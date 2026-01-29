

# Fix: LiveChat Runner Fast Retry Bug

## Issue Identified

The LiveChat runner is retrying failed proxy connections immediately instead of waiting 3 minutes because there's a **gap in the retry queue checks**.

### Current Flow (Broken)

```text
Proxy Failure Detected
        ↓
add_to_proxy_retry_queue() → Account added to _proxy_retry_queue
        ↓
Main loop fetches accounts from get_next_task("livechat")
        ↓
Filter only checks: connected_ids and failed_connection_accounts
        ↓
_proxy_retry_queue IS NOT CHECKED ← BUG!
        ↓
Account immediately reconnected (no 3-minute wait)
```

### Evidence from Logs

```text
Line 1469:  [PROXY RETRY] 16236494 - Attempt 1/3, retry in 3 min (2 left)
Line 1492:  [CONNECTED] 116/128 (timeouts=12...)
Line 1493:  [HEARTBEAT] Retry Queue: 0  ← Shows 0, but 12 should be waiting!
Line 1504:  [CONNECT] Connecting 12 accounts in PARALLEL...  ← IMMEDIATE retry!
```

## Root Cause

**File**: `src/pages/SetupGuide.tsx` (lines 3619-3623)

The main loop filter does not include `_proxy_retry_queue`:

```python
# Current (broken) - missing _proxy_retry_queue check
new_accounts = [
    acc for acc in accounts 
    if acc.get("id") not in connected_ids 
    and acc.get("id") not in failed_connection_accounts
]
```

## Fix

Add `_proxy_retry_queue` to the filter so accounts waiting for proxy retry are skipped:

```python
# Fixed - includes _proxy_retry_queue check
new_accounts = [
    acc for acc in accounts 
    if acc.get("id") not in connected_ids 
    and acc.get("id") not in failed_connection_accounts
    and acc.get("id") not in _proxy_retry_queue  # ← ADD THIS
]
```

## Additional Fixes

### 1. Fix Heartbeat to show correct retry queue count

Update the heartbeat log (line 3583-3584) to show `_proxy_retry_queue` count instead of `failed_connection_accounts`:

```python
# Current (showing wrong queue)
retry_count = len(failed_connection_accounts)

# Fixed (showing proxy retry queue)
retry_count = len(_proxy_retry_queue)
```

### 2. Import `_proxy_retry_queue` in LiveChat runner scope

The `_proxy_retry_queue` variable needs to be explicitly imported/available in the LiveChat runner section since it's defined in `client_manager.py`.

Add after line 3353:
```python
from client_manager import _proxy_retry_queue
```

Or add `global _proxy_retry_queue` at the start of `main_loop()` to access it.

---

## Technical Summary

| Location | Line | Issue | Fix |
|----------|------|-------|-----|
| `main_loop()` filter | 3619-3623 | Missing `_proxy_retry_queue` check | Add `acc.get("id") not in _proxy_retry_queue` |
| Heartbeat log | 3583-3584 | Shows wrong queue | Use `len(_proxy_retry_queue)` |
| `main_loop()` imports | 3557 | Missing import | Add `global _proxy_retry_queue` |

## Expected Result After Fix

```text
Proxy Failure Detected
        ↓
add_to_proxy_retry_queue() → Account in _proxy_retry_queue
        ↓
Main loop fetches accounts from get_next_task("livechat")
        ↓
Filter checks: connected_ids + failed_connection_accounts + _proxy_retry_queue ← FIXED
        ↓
Account SKIPPED (in _proxy_retry_queue)
        ↓
After 3 minutes: retry_proxy_error_accounts() picks it up
        ↓
Account reconnected with proper delay
```

