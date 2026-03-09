

## Make Accounts Page Updates Realtime (No Full Refresh)

### Problem
Every action on the Accounts page (delete, status change, proxy assign, tag update, bulk operations) calls `refreshData()` which triggers a full data re-fetch. This causes a visible loading flash instead of instant UI updates.

The `useAccounts` hook **already has realtime subscriptions** that optimistically update the React Query cache on INSERT/UPDATE/DELETE events from the `telegram_accounts` table. So calling `refreshData()` is redundant and causes the jarring refresh.

### Solution
Remove all `refreshData()` calls from account-related actions in `src/pages/Accounts.tsx`. The realtime subscription in `useAccounts` will automatically update the UI when the database changes. For proxy-related changes, also ensure `useProxies` has a similar realtime subscription.

### Changes

**File: `src/pages/Accounts.tsx`** (~20 locations)

Remove `refreshData()` calls after these actions:
- Single account delete (line ~858)
- Proxy change (line ~874)
- Bulk delete (line ~973)
- Account upload/import (line ~812)
- Spambot check complete (line ~280)
- Account task complete (lines ~321, ~334, ~389)
- Verify accounts (lines ~792, ~1726)
- Bulk proxy assign (line ~1572)
- Proxy remove (line ~1693)
- Tag assign/remove/rename/delete (lines ~1780, ~1805, ~1844, ~1925, ~1944, ~1979, ~2010)
- Status change (line ~1925)
- Bulk proxy remove (line ~1844)

Keep `refreshData()` only where non-account data (campaigns, conversations) genuinely needs refreshing — which is none of these cases.

**File: `src/hooks/useProxies.ts`**

Check if it has realtime subscriptions. If not, add one similar to `useAccounts` so proxy changes also reflect instantly.

**File: `src/hooks/useAccounts.ts`**

Already correct — has realtime subscriptions for INSERT/UPDATE/DELETE. No changes needed.

### Result
All account actions (status changes, proxy assignments, tag updates, deletions) will update the UI instantly via the existing realtime subscription, with no loading flash or full page refresh.

