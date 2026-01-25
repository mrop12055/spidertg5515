

# Fix: API Usage Counter Over-Counting

## Problem Identified
Your API usage counter shows **226,672** but only **413 messages** were actually sent. The counter is being inflated **549x** because:

1. **Polling Overhead**: Every time the Python runners poll for tasks (every 5-30 seconds), the system calls `getNextApiCredential()` for connection status, even when no tasks exist
2. **Double Counting**: Warmup tasks call `getNextApiCredential()` twice per message (once for sender, once for receiver)
3. **Redundant Calls**: LiveChat assigns API to accounts for "connection readiness" even when no messages need sending
4. **Pre-assignment**: APIs are incremented when **assigned**, not when **actually used**

---

## Solution: Track Only Actual Usage

Change the system to only increment API usage when a **message is successfully processed**, not when an API is assigned to a task.

### Architecture Change

```text
CURRENT (Over-counting):
  Runner polls → Edge function assigns API → INCREMENTS usage
  Runner polls → Edge function assigns API → INCREMENTS usage  
  Runner polls → Edge function assigns API → INCREMENTS usage
  Runner sends 1 message → Already counted 3x
  
FIXED (Accurate):
  Runner polls → Edge function assigns API → NO increment (just selection)
  Runner polls → Edge function assigns API → NO increment
  Runner sends 1 message → report-task-result → INCREMENTS usage once
```

---

## Implementation Details

### Phase 1: Modify API Helper (No Increment on Selection)

**File**: `supabase/functions/_shared/api-helper.ts`

Create two separate functions:
1. `selectNextApiCredential()` - Returns API without incrementing (for task assignment)
2. `recordApiUsage()` - Called only when task completes successfully

```typescript
// New function: SELECT without incrementing
export async function selectNextApiCredential(
  supabase: any
): Promise<{ id: string; api_id: string; api_hash: string } | null> {
  const { data: apis } = await supabase
    .from('telegram_api_credentials')
    .select('id, api_id, api_hash, usage_count')
    .eq('is_active', true)
    .order('usage_count', { ascending: true })
    .limit(1);

  if (!apis?.length) return null;
  
  // Return without incrementing - just selection
  return {
    id: apis[0].id,
    api_id: apis[0].api_id,
    api_hash: apis[0].api_hash
  };
}

// New function: Record actual usage (call after successful send)
export async function recordApiUsage(
  supabase: any,
  apiId: string
): Promise<void> {
  await supabase.rpc('increment_api_usage', { p_api_id: apiId });
}
```

### Phase 2: Update report-task-result to Increment

**File**: `supabase/functions/report-task-result/index.ts`

Add API usage increment when task completes successfully:

```typescript
// After successful message send
if (status === 'sent' || status === 'success') {
  // Increment the API that was actually used
  if (result.api_credential_id) {
    await recordApiUsage(supabase, result.api_credential_id);
  }
}
```

### Phase 3: Update report-batch-results Similarly

**File**: `supabase/functions/report-batch-results/index.ts`

Only count APIs for successfully sent messages:

```typescript
// For each successful result in the batch
for (const result of results) {
  if (result.status === 'sent' && result.api_credential_id) {
    await recordApiUsage(supabase, result.api_credential_id);
  }
}
```

### Phase 4: Update Task Assignment (No Increment)

**File**: `supabase/functions/get-batch-tasks/index.ts`

Replace all `getNextApiCredential()` calls with `selectNextApiCredential()`:

```typescript
// Before (increments on assignment):
const accountApi = await getNextApiCredential(supabase);

// After (no increment, just selection):
const accountApi = await selectNextApiCredential(supabase);
```

### Phase 5: Pass API ID Through Task Payload

Add `api_credential_id` to task payloads so the result reporters know which API was used:

```typescript
// In task payload
{
  api_id: accountApi.api_id,
  api_hash: accountApi.api_hash,
  api_credential_id: accountApi.id,  // NEW: track for usage reporting
}
```

---

## UI Fix: Display Formatting

**File**: `src/components/settings/ApiCredentialsManager.tsx`

Also fix the display to:
1. Format numbers with commas (226,672 instead of 226672)
2. Add auto-refresh every 30 seconds
3. Show "Today" vs "Total" usage separately

```typescript
// Format large numbers
<p className="text-2xl font-bold text-blue-500">
  {totalUsage.toLocaleString()}
</p>
```

---

## Reset Current Counts

After deploying the fix, reset all usage counts to start fresh with accurate tracking:

```sql
UPDATE telegram_api_credentials 
SET usage_count = 0, daily_usage = 0
WHERE is_active = true;
```

---

## Expected Results

| Metric | Before Fix | After Fix |
|--------|------------|-----------|
| API calls per message | ~550x | 1x |
| Accuracy | Inflated 549x | Exact match |
| What it tracks | API assignments | Successful sends |

---

## Summary of Changes

| File | Change |
|------|--------|
| `_shared/api-helper.ts` | Add `selectNextApiCredential()` (no increment) and `recordApiUsage()` |
| `get-batch-tasks/index.ts` | Replace `getNextApiCredential` with `selectNextApiCredential` |
| `get-next-task/index.ts` | Replace `getNextApiCredential` with `selectNextApiCredential` |
| `report-task-result/index.ts` | Add `recordApiUsage()` call on success |
| `report-batch-results/index.ts` | Add `recordApiUsage()` call for each success |
| `ApiCredentialsManager.tsx` | Format numbers, add auto-refresh |

This ensures the usage counter reflects **actual message sends**, not polling overhead.

