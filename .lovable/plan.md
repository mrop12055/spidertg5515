

# Speed Up Account Upload & Skip Duplicates

## Problem
Uploading 315 accounts takes too long because:
1. Each account is inserted one-by-one (315 database calls)
2. No check for existing accounts before trying to insert
3. Duplicate accounts count as "failed" (confusing)

## Solution

### Changes to Backend (`supabase/functions/admin-api/index.ts`)

**Before:** Sequential insert, 315 database calls for 315 accounts

**After:** 
1. Fetch all existing phone numbers in ONE query
2. Filter out duplicates BEFORE inserting
3. Insert remaining accounts in ONE batch operation
4. Return separate "skipped" count for existing accounts

```text
Upload Flow (Optimized)
+------------------+     +------------------+     +------------------+
| 315 Accounts     | --> | Check existing   | --> | Insert new only  |
| from ZIP         |     | (1 query)        |     | (1 batch query)  |
+------------------+     +------------------+     +------------------+
                               |                        |
                               v                        v
                         +----------+             +----------+
                         | 200 exist|             | 115 new  |
                         | (skipped)|             | (success)|
                         +----------+             +----------+
```

### Changes to Frontend (`src/pages/Accounts.tsx`)

Update the upload results display to show:
- **Successful**: New accounts added
- **Skipped**: Already existing (not failures!)
- **Failed**: Actual errors

### Implementation Details

1. **Edge Function Changes:**
   - Extract all phone numbers from upload batch
   - Query existing: `SELECT phone_number FROM telegram_accounts WHERE phone_number IN (...)`
   - Filter out existing ones
   - Use batch insert with `ON CONFLICT DO NOTHING`
   - Return `{ successful, skipped, failed }`

2. **Frontend Changes:**
   - Update `uploadResults` state to include `skipped` count
   - Update UI to show "skipped (already exist)" separately from failures

## Expected Performance

| Scenario | Before | After |
|----------|--------|-------|
| 315 accounts, 0 exist | ~30-60 seconds | ~2-3 seconds |
| 315 accounts, 200 exist | ~30-60 seconds | ~1-2 seconds |

## Files to Modify

| File | Change |
|------|--------|
| `supabase/functions/admin-api/index.ts` | Batch insert + pre-filter duplicates |
| `src/pages/Accounts.tsx` | Show "skipped" count in UI |

