

# Fix: Campaign Account Selection Not Being Respected

## Problem Summary

When you select specific accounts for a campaign (e.g., 210 accounts), the system saves this selection correctly to the `campaign_accounts` table. However, when the runner processes campaign messages, it **ignores this selection** and distributes messages across **all 809 active accounts** instead of just the 210 you selected.

This happens because the `runner-tasks` edge function fetches all active accounts and never filters them by the `campaign_accounts` table.

---

## Root Cause

In `supabase/functions/runner-tasks/index.ts`, lines 319-346:

1. The code fetches **all active accounts** into `usableAccounts`
2. When assigning campaign tasks, it iterates over this full list
3. It **never checks** the `campaign_accounts` table to filter down to the campaign's selected accounts

---

## Solution

Modify the runner-tasks edge function to respect the `campaign_accounts` linkage when assigning campaign messages.

### Step 1: Fetch Campaign-Linked Accounts

When processing campaign recipients, for each recipient:
1. Look up the campaign ID
2. Query the `campaign_accounts` table to get the list of account IDs linked to that campaign
3. Filter `usableAccounts` to only include accounts that are in the campaign's linked list

### Step 2: Optimize with Batch Lookup

Since multiple recipients may belong to the same campaign:
1. Collect all unique campaign IDs from the batch of recipients
2. Fetch all linked account IDs for these campaigns in a single query
3. Build a map of `campaign_id -> Set<account_id>`
4. When assigning each recipient, filter `usableAccounts` to only include accounts in that campaign's set

---

## Technical Implementation

```text
+----------------------------------+
|   Current Flow (Broken)          |
+----------------------------------+
| 1. Fetch pending recipients      |
| 2. Get ALL active accounts       |
| 3. Round-robin across ALL        |
|    809 accounts                  |
+----------------------------------+

           ↓ FIX ↓

+----------------------------------+
|   Fixed Flow                     |
+----------------------------------+
| 1. Fetch pending recipients      |
| 2. Get campaign IDs from batch   |
| 3. Lookup campaign_accounts for  |
|    those campaigns               |
| 4. Filter usableAccounts to only |
|    include linked accounts       |
| 5. Round-robin across SELECTED   |
|    accounts only                 |
+----------------------------------+
```

### Code Changes in `runner-tasks/index.ts`

**After fetching recipients (around line 279), add:**

1. Extract unique campaign IDs from recipients batch
2. Query `campaign_accounts` table for all linked account IDs
3. Build a lookup map: `campaignAccountMap[campaign_id] = Set<account_id>`

**In the account assignment loop (around line 330), modify:**

1. Get the current recipient's campaign ID
2. Look up allowed accounts from `campaignAccountMap`
3. Filter the account loop to only consider accounts in that set
4. If no accounts are linked (empty set), fall back to all usable accounts for backward compatibility

---

## Files to Modify

| File | Change |
|------|--------|
| `supabase/functions/runner-tasks/index.ts` | Add campaign_accounts lookup and filter logic in the campaign tasks section |

---

## Edge Cases Handled

1. **No accounts selected** (old campaigns or user skipped selection): Fall back to all usable accounts
2. **All selected accounts at daily limit**: Recipient stays pending until next day
3. **Selected account banned/restricted**: Naturally filtered out by existing status checks
4. **Multiple campaigns in same batch**: Each recipient uses its own campaign's account list

---

## Verification

After implementation:
1. Create a new campaign selecting only 5 specific accounts
2. Start the campaign
3. Check `campaign_recipients.sent_by_account_id` to verify messages only went through the 5 selected accounts

