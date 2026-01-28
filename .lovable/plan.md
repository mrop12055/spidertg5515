

# LiveChat Runner - Critical Session & Connection Fixes

## Analysis from Log File

After analyzing the 1933-line log file, I identified **5 critical issues** that need to be fixed to meet your requirements:

---

## Issues Identified

### Issue 1: Database Locked Errors (SQLite Lock)

**Log Evidence (Lines 1758-1804):**
```
[PROXY ERROR] +919012593881 - INSTANT disconnect: database is locked
[PROXY ERROR] +917567507488 - INSTANT disconnect: database is locked
sqlite3.OperationalError: database is locked
```

**Root Cause:**
When accounts fail and retry, the same session file gets opened multiple times because:
1. The retry logic in `retry_proxy_error_accounts()` creates a NEW client
2. But the main loop might also try to connect the SAME account if it appears in the "failed" accounts list
3. This causes TWO connections to the SAME SQLite session file

**The Fix:**
- Add stronger session file locking with an **exclusive file lock** before opening
- Ensure session file is **completely released** (with explicit close) before any retry
- Never open the same session file twice in parallel

---

### Issue 2: Double Connection Attempts

**Log Evidence (Lines 1692-1757):**
```
[RETRY] 6 failed accounts ready for retry
[CONNECT] Connecting 9 accounts in PARALLEL...
[1031] STEP 1: Proxy validated...  ← Same account in BOTH loops!
```

**Root Cause:**
The normal connect loop (`new_accounts` filter on line 3661-3666) excludes accounts in `_proxy_retry_queue`, **BUT** once the 60s retry window expires, they get removed from `failed_connection_accounts` (line 3640-3643) and immediately picked up by the normal loop AGAIN - before `retry_proxy_error_accounts()` gets to them.

**The Fix:**
- Keep accounts in `_proxy_retry_queue` until `retry_proxy_error_accounts()` processes them
- Remove from `_proxy_retry_queue` ONLY on success or max retries
- Add an **account connection lock** to prevent ANY double attempts

---

### Issue 3: Retry Miscount (2 Attempts Instead of 3)

**Log Evidence (Lines 1503-1518):**
```
[PROXY RETRY] e5606268 - Adding to 3-attempt retry queue
[PROXY MAX] e5606268 - 2 attempts failed, marking INACTIVE
```

**Root Cause:**
The current retry logic has `PROXY_MAX_RETRIES = 2` (line 140), which gives only 1 initial + 1 retry = 2 attempts total. Your requirement is for exactly 2 retries (1 initial + 1 retry after 60s + 1 more retry = 3 total).

**The Fix:**
- Change `PROXY_MAX_RETRIES = 3` to allow 3 total attempts
- Initial connection (1) + First retry after 60s (2) + Second retry after another 60s (3)
- Only mark inactive after all 3 attempts fail

---

### Issue 4: Session Not Properly Closed Before Retry

**Log Evidence (Lines 1678-1689):**
```
[FORCE DISCONNECT] d7802056 - No active client found, cleared tracking
[PROXY MAX] d7802056 - 2 attempts failed, marking INACTIVE
...
[d7802056] ✗ Still failing - will retry in 1 min
```

**Root Cause:**
The `force_disconnect_session()` function tries to disconnect, but:
1. The client is already removed from `active_clients` by the connection error handler
2. So it skips the actual disconnect logic and only "clears tracking"
3. The SQLite session file is NOT explicitly closed
4. When retry happens, the old file handle may still be held by the OS

**The Fix:**
- Store the **session file path** in `_proxy_retry_queue` alongside account data
- Before retry, explicitly **delete the session temp file** and decode fresh
- Add a longer sleep (1-2s) after disconnect to let OS release file handles

---

### Issue 5: Normal Connect Loop Reprocesses Retry-Queue Accounts

**Log Evidence (Lines 1914-1933):**
```
[CONNECT] Connecting 2 accounts in PARALLEL...
[6270] STEP 1: Proxy validated...
[3617] STEP 1: Proxy validated...
[PROXY ERROR] +919301163617 - INSTANT disconnect: database is locked
```

**Root Cause:**
Account 3617 was successfully reconnected by `retry_proxy_error_accounts()` (line 1904: `[fef0e9a1] ✓ Reconnected`), but then the normal connect loop (line 1914) tries to connect it AGAIN - causing SQLite lock.

**The Fix:**
- After successful reconnection in `retry_proxy_error_accounts()`, add to `connected_ids` IMMEDIATELY
- Check `connected_ids` at the START of `connect_one()` function to bail early
- Add a **per-account "connecting" flag** to prevent concurrent connection attempts

---

## Implementation Summary

| File | Change | Purpose |
|------|--------|---------|
| `SetupGuide.tsx` (Line 140) | `PROXY_MAX_RETRIES = 3` | Allow 3 total attempts (1 initial + 2 retries) |
| `SetupGuide.tsx` (Line 478-479) | Add to `connected_ids` immediately on retry success | Prevent normal loop from reconnecting |
| `SetupGuide.tsx` (Lines 368-540) | Add session file cleanup before retry | Prevent SQLite locks |
| `SetupGuide.tsx` (Lines 198-278) | Improve `force_disconnect_session()` with explicit file cleanup | Ensure file is released |
| `SetupGuide.tsx` (New) | Add `_currently_connecting: Set[str]` | Prevent ANY double connection attempts |

---

## Technical Implementation

### 1. Add Connection-in-Progress Lock

```python
# New global set to track accounts currently being connected
_currently_connecting: Set[str] = set()

async def connect_one(acc):
    acc_id = acc.get("id")
    
    # CRITICAL: Skip if already being connected
    if acc_id in _currently_connecting:
        return acc_id, None, "Already connecting", phone, False
    
    # Skip if already connected
    if acc_id in connected_ids:
        return acc_id, None, "Already connected", phone, False
    
    _currently_connecting.add(acc_id)
    try:
        # ... existing connection logic ...
    finally:
        _currently_connecting.discard(acc_id)
```

### 2. Fix Retry Count (3 Attempts Total)

```python
PROXY_MAX_RETRIES = 3  # Changed from 2 to 3
# Gives: Initial (1) + Retry after 60s (2) + Final retry (3)
```

### 3. Session File Cleanup Before Retry

```python
async def retry_one(acc_id: str) -> bool:
    # ... existing code ...
    
    # CRITICAL: Delete old session temp file to prevent SQLite locks
    phone = account_data.get("phone_number", acc_id[:8])
    old_session_path = os.path.join(SESSION_FOLDER, f"{phone}.session")
    if os.path.exists(old_session_path):
        try:
            os.remove(old_session_path)
            print(f"    [{phone[:8]}] Cleaned up old session file")
        except:
            pass
    
    # Now connect with fresh session decode
    client = await get_or_create_client(...)
```

### 4. Add to connected_ids Immediately on Retry Success

```python
if client:
    # SUCCESS! Clear from retry queue
    remove_from_proxy_retry_queue(acc_id)
    
    # CRITICAL: Add to connected_ids IMMEDIATELY to prevent normal loop reconnection
    connected_ids.add(acc_id)  # NEW LINE
    
    # Update database...
```

---

## Flow After Fix

```text
Account A fails → INSTANT DISCONNECT → Add to retry queue (attempt 1/3)
                                       ↓
                        Wait 60 seconds
                                       ↓
[Normal loop sees A NOT in connected_ids, BUT A IS in _proxy_retry_queue → SKIP]
                                       ↓
retry_proxy_error_accounts() picks up A → Clean session file → Connect
                                       ↓
Success? → Remove from queue, add to connected_ids → DONE
Fail?    → Increment count → Wait 60s → Retry (attempt 2/3)
                                       ↓
Success? → Remove from queue, add to connected_ids → DONE
Fail?    → Increment count → Wait 60s → Retry (attempt 3/3)
                                       ↓
Success? → Remove from queue, add to connected_ids → DONE
Fail?    → Report to backend as INACTIVE → Admin must fix proxy
```

---

## Re-activation Flow (Requirement #4)

When admin updates proxy and sets account to Active:
1. The next iteration of `get_next_task(runner="livechat")` returns this account
2. Account is NOT in `connected_ids` (was marked inactive/removed)
3. Account is NOT in `_proxy_retry_queue` (was cleared on max retries)
4. Account is NOT in `failed_connection_accounts` (status was set to inactive)
5. Normal connect loop picks it up → Fresh connection with new proxy

This is already working correctly - no changes needed.

---

## Session Integrity (Requirement #5)

The current implementation has per-account locks (`get_account_lock()`), but they only protect within the same function call. The issue is parallel attempts from DIFFERENT code paths.

**Fix:** Add `_currently_connecting` set as a cross-function lock to prevent ANY concurrent connection to the same account.

