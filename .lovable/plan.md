
# Fix: Python Runner Not Fetching All Accounts (1000+ Row Limit)

## Problem Identified

You have **1,008 accounts** in the database, but the `runner-tasks` edge function only fetches up to **1,000 accounts** due to Supabase's default row limit. This causes 8 accounts to be silently dropped, breaking the Python runner's ability to fetch all accounts.

The issue is in `supabase/functions/runner-tasks/index.ts` at line 248:
```typescript
let accountsQuery = supabase.from("telegram_accounts").select("*, proxies!fk_proxy(*)");
```
This query has no pagination, so it hits the 1,000-row ceiling.

---

## Solution

Implement **sequential paginated fetching** in the edge function to retrieve all accounts in batches of 1,000.

---

## Implementation Plan

### Step 1: Add Paginated Account Fetching Helper

Create a helper function that fetches accounts in pages:

```typescript
async function fetchAllAccounts(supabase: any, statusFilter: string[], accountIds?: string[]): Promise<any[]> {
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 10; // Support up to 10,000 accounts
  const allAccounts: any[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from("telegram_accounts")
      .select("*, proxies!fk_proxy(*)")
      .in("status", statusFilter)
      .range(from, to);

    if (accountIds?.length > 0) {
      query = query.in("id", accountIds);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    allAccounts.push(...data);
    if (data.length < PAGE_SIZE) break; // Last page
  }

  return allAccounts;
}
```

### Step 2: Update the `handleGetTasks` Function

Replace the current single query with the paginated helper:

**Before (lines 247-262):**
```typescript
let accountsQuery = supabase.from("telegram_accounts").select("*, proxies!fk_proxy(*)");

if (isLivechat) {
  accountsQuery = accountsQuery.in("status", ["active", "restricted", "cooldown", "frozen"]);
} else {
  accountsQuery = accountsQuery.in("status", ["active", "cooldown", "restricted"]);
}

if (account_ids?.length > 0) {
  accountsQuery = accountsQuery.in("id", account_ids);
}

const { data: accounts, error: accountsError } = await accountsQuery;
```

**After:**
```typescript
const statusFilter = isLivechat
  ? ["active", "restricted", "cooldown", "frozen"]
  : ["active", "cooldown", "restricted"];

let accounts: any[];
try {
  accounts = await fetchAllAccounts(supabase, statusFilter, account_ids);
} catch (accountsError) {
  console.error("[runner-tasks/get] Error fetching accounts:", accountsError);
  return jsonResponse({ tasks: [], accounts: [], delay_after: 30, reason: "Error fetching accounts" });
}

console.log(`[runner-tasks/get] Fetched ${accounts.length} accounts (paginated)`);
```

---

## Technical Notes

- **Sequential vs Parallel**: Using sequential fetching (not `Promise.all`) because edge functions have strict timeout limits, and for 1,000-2,000 accounts only 2 requests are needed
- **Scalability**: Supports up to 10,000 accounts (10 pages × 1,000 rows)
- **Backward Compatible**: No changes to the Python runner or API contract
- **Frontend Already Fixed**: The `useAccounts.ts` hook already uses pagination

---

## Files to Modify

| File | Change |
|------|--------|
| `supabase/functions/runner-tasks/index.ts` | Add paginated fetching helper and update `handleGetTasks` |

---

## After Implementation

1. Deploy the updated edge function
2. Start the Python runner
3. Verify all 1,008 accounts are fetched correctly
