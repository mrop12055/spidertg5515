

# Plan: Fix Round-Robin API Distribution in LiveChat

## Problem Identified

The `get-next-task` edge function (used by LiveChat) calls `selectNextApiCredential()` in a loop for each account and message. Since this function queries the database for the API with the **lowest `usage_count`**, and the count is only incremented on successful sends (not on assignment), **every call within the same request returns the SAME API**.

### Evidence from Logs
```
[api-helper] Selected API 34754522 (current usage: 6) - NO increment on assignment
[api-helper] Selected API 34754522 (current usage: 6) - NO increment on assignment
[api-helper] Selected API 34754522 (current usage: 6) - NO increment on assignment
... (repeated 87 times!)
```

### Working Example: `get-batch-tasks`
The warmup and campaign batch task function correctly implements round-robin:
```javascript
// Pre-fetch ALL APIs once
const { data: allActiveApis } = await supabase.from('telegram_api_credentials')...
const apiPool = allActiveApis || [];
let apiPoolIndex = 0;

// Rotate through pool IN-MEMORY
const getNextApiFromPool = () => {
  const api = apiPool[apiPoolIndex % apiPool.length];
  apiPoolIndex++;  // Advance for next call
  return api;
};
```

### Broken Implementation: `get-next-task` (LiveChat)
```javascript
// Line 150 - Called for each account (returns same API every time!)
const accountFreshApi = await selectNextApiCredential(supabase);

// Line 184 - Called for EACH message (returns same API every time!)
const messageFreshApi = await selectNextApiCredential(supabase);

// Line 217 - Called for EACH listening account (returns same API every time!)
const freshApi = await selectNextApiCredential(supabase);
```

---

## Solution

Apply the same in-memory pool rotation pattern from `get-batch-tasks` to `get-next-task`.

### File: `supabase/functions/get-next-task/index.ts`

#### Change 1: Add API Pool Pre-Fetch at Start of LiveChat Handler

**Location**: After line 88 (after fetching pending messages)

Add:
```typescript
// ========== PRE-FETCH API POOL FOR TRUE ROUND-ROBIN ==========
// Get all active APIs sorted by usage for true round-robin distribution
const { data: allActiveApis } = await supabase
  .from('telegram_api_credentials')
  .select('id, api_id, api_hash, usage_count')
  .eq('is_active', true)
  .order('usage_count', { ascending: true })
  .order('last_used_at', { ascending: true, nullsFirst: true });

const apiPool = allActiveApis || [];
let apiPoolIndex = 0;

// Helper function for true in-batch round-robin
const getNextApiFromPool = (): { id: string; api_id: string; api_hash: string } | null => {
  if (apiPool.length === 0) return null;
  const api = apiPool[apiPoolIndex % apiPool.length];
  apiPoolIndex++; // Advance for next call (true rotation)
  return { id: api.id, api_id: api.api_id, api_hash: api.api_hash };
};

console.log(`[get-next-task] Livechat API POOL: ${apiPool.length} APIs for round-robin`);
```

#### Change 2: Replace `selectNextApiCredential()` Calls with Pool Helper

**Location 1**: Line 150 (account-level API assignment)
```typescript
// BEFORE
const accountFreshApi = await selectNextApiCredential(supabase);

// AFTER
const accountFreshApi = getNextApiFromPool();
```

**Location 2**: Line 184 (per-message API assignment)
```typescript
// BEFORE
const messageFreshApi = await selectNextApiCredential(supabase);

// AFTER
const messageFreshApi = getNextApiFromPool();
```

**Location 3**: Line 217 (listening accounts API assignment)
```typescript
// BEFORE
const freshApi = await selectNextApiCredential(supabase);

// AFTER
const freshApi = getNextApiFromPool();
```

**Location 4**: Line 277 (single-message mode fallback)
```typescript
// BEFORE
const freshApi = await selectNextApiCredential(supabase);

// AFTER
const freshApi = getNextApiFromPool();
```

---

## Summary

| Before | After |
|--------|-------|
| 87 accounts → all get API `34754522` | 87 accounts → rotate through 16 APIs |
| Calls `selectNextApiCredential()` 87 times | Calls it 0 times (uses in-memory pool) |
| Same API overloaded | Even distribution across pool |
| 87 DB queries per request | 1 DB query per request (pool fetch) |

## Expected Log Output After Fix
```
[get-next-task] Livechat API POOL: 16 APIs for round-robin
Account 1 → API 34754522
Account 2 → API 34668149
Account 3 → API 35263613
...
Account 17 → API 34754522 (wraps around)
```

## Files to Modify

1. **`supabase/functions/get-next-task/index.ts`**:
   - Add API pool pre-fetch after line 88
   - Replace 4 instances of `selectNextApiCredential()` with `getNextApiFromPool()`

