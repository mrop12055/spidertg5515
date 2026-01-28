# LiveChat Runner - Instant Session Kill on Proxy Failure

## Build Version: 2026-01-28-instant-kill-v2

## Status: ✅ IMPLEMENTED

---

## Changes Made

### Fix 1: Force Disconnect BEFORE Retry Queue in `retry_one()`
**Location:** Lines 586-597 (now 586-600)

Added `await force_disconnect_session(acc_id, ...)` BEFORE adding to retry queue to ensure session is killed instantly on any exception.

### Fix 2: Force Disconnect in `get_or_create_client()` Outer Exception Handler
**Location:** Lines 1032-1042 (now 1036-1050)

Added `await force_disconnect_session(account_id, ...)` at START of outer exception handler to prevent any proxyless connection.

### Fix 3: Force Disconnect in `connect_account_with_fingerprint()` Exception Handler
**Location:** Lines 2922-2940 (now 2937-2958)

Added `await force_disconnect_session(account_id, ...)` at START of exception handler before any other action.

### Fix 4: Delete Session File BEFORE TelegramClient Creation
**Location:** Lines 834-856 (now 834-856)

Added session file cleanup using `glob` to delete any existing `.session` files BEFORE decoding fresh session. This prevents:
- SQLite "database is locked" errors
- Stale connection state that could cause proxyless connection

---

## Flow After Implementation

```text
Connection Attempt:
    1. Delete any existing session file ← NEW!
    2. Decode fresh session from database
    3. Create TelegramClient with proxy
    4. Attempt connect (single attempt, no retry)
    
If proxy fails at ANY step:
    1. IMMEDIATELY call force_disconnect_session() ← FIRST!
    2. Delete session file (inside force_disconnect_session)
    3. Remove from active_clients
    4. THEN add to retry queue
    5. THEN report to backend
    
Account NEVER has a chance to connect without proxy.
```

---

## Key Safety Features

1. **Pre-emptive Cleanup:** Session file deleted BEFORE client creation
2. **Instant Kill:** `force_disconnect_session()` called FIRST in ALL exception handlers
3. **No Retry:** `connection_retries=0` and `auto_reconnect=False` in TelegramClient
4. **Strict Order:** Disconnect → Cleanup → Queue → Report
