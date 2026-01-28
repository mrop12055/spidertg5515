# LiveChat Runner - Session Lock Fix

## Status: ✅ IMPLEMENTED (2026-01-28)

All 5 critical issues from the log analysis have been fixed.

---

## Changes Made

### 1. Cross-Function Connection Lock (`_currently_connecting`)
- Added global `_currently_connecting: set` to track accounts being connected
- Prevents double connection attempts from different code paths (main loop vs retry loop)
- Both `connect_one()` and `retry_one()` now check and use this lock
- Lock is cleared in `finally` block to ensure cleanup

### 2. Retry Count Fixed to 3 Attempts
- Changed `PROXY_MAX_RETRIES = 3` (was 2)
- Now gives: Initial (1) + Retry after 60s (2) + Final retry (3) = 3 total attempts
- Only marks inactive after all 3 attempts fail

### 3. Session File Cleanup Before Retry
- `force_disconnect_session()` now deletes session files using glob patterns
- `retry_one()` also deletes old session files before attempting reconnection
- Prevents SQLite "database is locked" errors

### 4. Improved Force Disconnect
- Increased sleep after disconnect from 0.5s to 1.0s for file handle release
- Now removes account from `_currently_connecting` on disconnect
- Deletes session files to ensure clean state for retry

### 5. Immediate connected_ids Update
- `retry_proxy_error_accounts()` now accepts `connected_ids_ref` parameter
- Successfully reconnected accounts are added to `connected_ids` immediately
- Prevents normal connect loop from attempting to reconnect same account

### 6. Enhanced Filter in Main Loop
- `new_accounts` filter now checks:
  - `connected_ids` (already connected)
  - `failed_connection_accounts` (in cooldown)
  - `_proxy_retry_queue` (being retried)
  - `_currently_connecting` (connection in progress)

---

## Flow After Fix

```
Account A fails → INSTANT DISCONNECT → Add to retry queue (attempt 1/3)
                                       ↓
                        Wait 60 seconds
                                       ↓
[Normal loop: A in _proxy_retry_queue OR _currently_connecting → SKIP]
                                       ↓
retry_proxy_error_accounts() picks up A:
  1. Check _currently_connecting → Skip if already connecting
  2. Delete old session file
  3. Connect with fresh session
                                       ↓
Success? → Remove from queue, add to connected_ids → DONE
Fail?    → Increment count → Wait 60s → Retry (attempt 2/3)
                                       ↓
Success? → DONE
Fail?    → Wait 60s → Retry (attempt 3/3)
                                       ↓
Success? → DONE  
Fail?    → Report to backend as INACTIVE
```

---

## Build Version
`2026-01-28-session-lock-fix`
