

# Plan: Fix Misleading Startup Log in LiveChat Runner

## Problem Identified

The startup banner in `main_loop()` displays an **outdated** message that doesn't match the actual retry logic:

| What's Displayed | Actual Code |
|------------------|-------------|
| `🔄 Failed connections retry after 60s cooldown` | `FAILED_RETRY_DELAY = 180` (3 minutes) |

This creates confusion because:
1. **Network/Proxy errors** → go to `add_to_proxy_retry_queue` → 3-minute delay between attempts
2. **Non-proxy errors** → go to `failed_connection_accounts[acc_id] = time.time() + 180` → 3-minute delay

The "60s" mentioned in the log is a **stale reference** from a previous version. There's also `SYNC_RETRY_INTERVAL = 60` but that's for message synchronization, not connection retries.

## Solution

Update the startup log message to accurately reflect the 3-minute retry logic.

### Change Required

**File**: `src/pages/SetupGuide.tsx`

**Location**: Line 3478 (inside livechatRunnerPy template)

**Before**:
```python
print("  🔄 Failed connections retry after 60s cooldown")
```

**After**:
```python
print("  🔄 Failed connections retry after 3 min cooldown")
```

### Additional Fix

Also update the comment at line 3523 that incorrectly says "60s":

**Before**:
```python
# Allow failed accounts to retry after their cooldown expires (60s from failure)
```

**After**:
```python
# Allow failed accounts to retry after their cooldown expires (180s/3min from failure)
```

## Summary of Retry Logic (No Change Needed)

The actual code is **correct**:

| Error Type | Handler | Delay | Max Attempts |
|------------|---------|-------|--------------|
| Proxy/Network errors | `add_to_proxy_retry_queue()` | 3 minutes | 3 attempts then disable |
| Other connection errors | `failed_connection_accounts` | 3 minutes (180s) | Unlimited |
| Health check failures | `add_to_proxy_retry_queue()` | 3 minutes | 3 attempts then disable |

The **only issue** is the misleading log message - the retry logic itself is working correctly.

## Files to Modify

1. **`src/pages/SetupGuide.tsx`**:
   - Line 3478: Update startup log from "60s" to "3 min"
   - Line 3523: Update comment from "60s" to "180s/3min"

## Expected Outcome

After this fix:
- The startup banner will correctly show "3 min cooldown"
- Comments will match the actual `FAILED_RETRY_DELAY = 180` constant
- No confusion between the two different 60s values (SYNC_RETRY_INTERVAL vs FAILED_RETRY_DELAY)

