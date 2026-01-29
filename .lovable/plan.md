
# LiveChat Runner - Simplified Proxy Retry System

## Build Version: 2026-01-29-forward-ref-fix (IMPLEMENTED)

---

## Implementation Complete ✅

Replaced queue-based retry with simplified in-memory tracking + parallel batch processing.
**FIXED (2026-01-29)**: Moved `mark_account_failed` and related functions AFTER `report_result` to prevent Python NameError crash.

---

## Changes Made

### 1. Tracking Structure
**Before:** `_proxy_retry_queue: Dict[str, dict]` with complex scheduling
**After:** `_failed_accounts: Dict[str, dict]` with simple timestamps

```python
# Simple tracking: {account_id: {"failed_at": float, "attempts": int, "account_data": dict, "proxy_data": dict}}
_failed_accounts: Dict[str, dict] = {}
```

### 2. Failure Tracking Function
**Before:** `add_to_proxy_retry_queue()` - queued with next_retry_at scheduling
**After:** `mark_account_failed()` - simple timestamp-based tracking

Key changes:
- Records `failed_at` timestamp instead of `next_retry_at`
- Simple 1-minute delay check: `now - failed_at >= 60`
- Increment attempts on each failure
- Remove from tracking after 3 failed attempts + report to backend

### 3. Parallel Batch Retry
**Before:** Sequential processing, 100 accounts at a time
**After:** Parallel processing in batches of 50

```python
async def retry_failed_accounts_parallel(connected_ids_ref: set = None):
    # Find ready accounts (1 min passed)
    ready_ids = get_ready_failed_accounts()
    
    # Process in parallel batches of 50
    BATCH_SIZE = 50
    batches = [ready_ids[i:i+BATCH_SIZE] for i in range(0, len(ready_ids), BATCH_SIZE)]
    
    for batch_idx, batch in enumerate(batches):
        # Execute batch in parallel
        results = await asyncio.gather(*[retry_one(acc_id) for acc_id in batch])
```

### 4. Main Loop Filter
Updated to use `_failed_accounts` instead of `_proxy_retry_queue`:
```python
new_accounts = [
    acc for acc in accounts 
    if acc.get("id") not in connected_ids 
    and acc.get("id") not in failed_connection_accounts
    and acc.get("id") not in _failed_accounts  # Changed from _proxy_retry_queue
    and acc.get("id") not in _currently_connecting
]
```

---

## Flow Summary

```text
Connection Attempt:
    1. Delete old session file (pre-cleanup)
    2. Decode fresh session
    3. Create TelegramClient with proxy
    4. Single connection attempt (no internal retry)
    
If proxy fails:
    1. INSTANT: Kill session via force_disconnect_session()
    2. Mark in _failed_accounts with timestamp
    3. Increment attempts count
    
Every ~30 seconds in main loop:
    1. Check _failed_accounts for entries where (now - failed_at) >= 60s
    2. Collect all ready accounts
    3. Process in PARALLEL BATCHES of 50
    4. On success: Remove from _failed_accounts, add to connected_ids
    5. On failure: mark_account_failed() increments count, resets timestamp
    
After 3 failures:
    1. Report to backend: mark account INACTIVE
    2. Remove from _failed_accounts
    3. Admin must fix proxy and set account to Active
```

---

## Key Improvements

| Before | After |
|--------|-------|
| Queue with scheduling | Simple timestamp tracking |
| Sequential processing | Parallel batches (50 at once) |
| Complex state management | Minimal state (just timestamp + count) |
| Race conditions possible | `_currently_connecting` lock prevents doubles |

---

## Safety Guarantees

1. **Instant Kill**: `force_disconnect_session()` called FIRST on any error
2. **No Internet Without Proxy**: `connection_retries=0`, `auto_reconnect=False`
3. **Session Cleanup**: Session file deleted before retry
4. **Lock Protection**: `_currently_connecting` prevents double connections

---

## Backward Compatibility

Old function names are kept as aliases:
- `add_to_proxy_retry_queue()` → calls `mark_account_failed()`
- `remove_from_proxy_retry_queue()` → calls `remove_from_failed_accounts()`
- `retry_proxy_error_accounts()` → calls `retry_failed_accounts_parallel()`
