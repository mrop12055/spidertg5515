

# Complete Fix: Instant Disconnect on ALL Proxy Failures

## Problems Found in Deep Audit

After reviewing all Python code in `src/pages/SetupGuide.tsx`, I found **6 critical issues** where connection retries or Telethon internal settings could cause accounts to connect without proxy:

| # | Location | Issue | Risk Level |
|---|----------|-------|------------|
| 1 | Line 772-775 | `connection_retries=3, auto_reconnect=True` for LiveChat | **CRITICAL** - Telethon internal retry bypasses proxy |
| 2 | Line 143-144 | `CONNECTION_RETRIES = 2, RETRY_DELAY = 2` - unused but misleading | Low - cosmetic |
| 3 | Line 3327 | `FAILED_RETRY_DELAY = 180` (3 min) should be 60s | Medium - not your 1-min requirement |
| 4 | Lines 2144-2173 | Campaign runner `max_connection_retries = 3` loop | **HIGH** - retries on network errors |
| 5 | Lines 3793-3811 | LiveChat send_parallel `max_db_retries = 3` loop | **HIGH** - retries on network errors |
| 6 | Line 309 comment | Says "3 minutes" but constant is now 60s | Low - cosmetic |

## Solution - All Changes

### Change 1: Remove Telethon Internal Retries (Lines 772-775)

**CRITICAL FIX** - Disable Telethon's internal retry and auto-reconnect which can bypass proxy:

```python
# BEFORE (DANGEROUS - allows internal retries that could bypass proxy):
connection_retries=3 if long_lived else 0,
retry_delay=2 if long_lived else 0,
auto_reconnect=long_lived,
request_retries=3 if long_lived else 1

# AFTER (SAFE - NO internal retries, use our external retry queue only):
connection_retries=0,  # NEVER retry internally - could bypass proxy
retry_delay=0,
auto_reconnect=False,  # NEVER auto-reconnect - could bypass proxy
request_retries=1  # Allow 1 request retry for API calls only (not connection)
```

### Change 2: Update FAILED_RETRY_DELAY to 60s (Line 3327)

```python
# BEFORE:
FAILED_RETRY_DELAY = 180  # 3 MINUTES

# AFTER:
FAILED_RETRY_DELAY = 60  # 1 MINUTE (matches PROXY_RETRY_DELAY)
```

### Change 3: Fix Comment at Line 309

```python
# BEFORE:
"""Schedule retry after IMMEDIATE disconnect.
Tracks attempt count and schedules next retry after 3 minutes.

# AFTER:
"""Schedule retry after IMMEDIATE disconnect.
Tracks attempt count and schedules next retry after 1 minute.
```

### Change 4: Campaign Runner - Instant Disconnect on Network Errors (Lines 2144-2173)

Replace the retry loop with single attempt + instant disconnect for non-SQLite errors:

```python
# BEFORE (retries ALL errors including network/proxy):
max_connection_retries = 3
for attempt in range(max_connection_retries):
    try:
        client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True, no_cache=True)
        if client:
            break
    except Exception as conn_err:
        last_connection_error = str(conn_err)
        err_lower = last_connection_error.lower()
        if "database is locked" in err_lower and attempt < max_connection_retries - 1:
            # retry...

# AFTER (only retry SQLite locks, instant disconnect on network/proxy errors):
client = None
last_connection_error = None

try:
    client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True, no_cache=True)
except Exception as conn_err:
    last_connection_error = str(conn_err)
    err_lower = last_connection_error.lower()
    
    # ONLY retry for SQLite lock errors (local file contention - safe)
    if "database is locked" in err_lower:
        for db_retry in range(3):
            await asyncio.sleep(0.5 * (db_retry + 1))
            try:
                client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True, no_cache=True)
                if client:
                    break
            except Exception as db_err:
                if "database is locked" not in str(db_err).lower():
                    last_connection_error = str(db_err)
                    break  # Not a lock error - stop retrying immediately
    # else: NETWORK/PROXY ERROR - no retry, session already disconnected
```

### Change 5: LiveChat send_parallel - Instant Disconnect (Lines 3793-3811)

Same pattern - only retry SQLite locks, instant fail for network/proxy:

```python
# BEFORE (retries ALL errors):
for db_attempt in range(max_db_retries):
    try:
        client, connection_error = await connect_account_with_fingerprint(...)
        if client:
            break
    except Exception as conn_err:
        connection_error = str(conn_err)
        err_lower = connection_error.lower()
        if "database is locked" in err_lower and db_attempt < max_db_retries - 1:
            # retry...
        break

# AFTER (only retry SQLite locks):
client = None
connection_error = None

try:
    client, connection_error = await connect_account_with_fingerprint(
        account, setup_handler=setup_message_handler, task_proxy=proxy,
        skip_session_check=True
    )
except Exception as conn_err:
    connection_error = str(conn_err)
    err_lower = connection_error.lower()
    
    # ONLY retry for SQLite lock errors (safe - local file contention)
    if "database is locked" in err_lower:
        for db_retry in range(3):
            await asyncio.sleep(0.5 * (db_retry + 1))
            try:
                client, connection_error = await connect_account_with_fingerprint(
                    account, setup_handler=setup_message_handler, task_proxy=proxy,
                    skip_session_check=True
                )
                if client:
                    break
            except Exception as db_err:
                if "database is locked" not in str(db_err).lower():
                    connection_error = str(db_err)
                    break  # Not a lock error - stop immediately

# If connection failed (network/proxy), session is ALREADY disconnected by get_or_create_client
```

### Change 6: Update Heartbeat Log (Line 3526)

```python
# BEFORE:
print("  🔄 Failed connections retry after 3 min cooldown")

# AFTER:
print("  🔄 Failed connections retry after 1 min cooldown")
```

## Summary of All Changes

| Location | Current | Fixed | Why |
|----------|---------|-------|-----|
| Line 772 | `connection_retries=3 if long_lived` | `connection_retries=0` | Prevent Telethon internal retries |
| Line 773 | `retry_delay=2 if long_lived` | `retry_delay=0` | No delay for retries we're removing |
| Line 774 | `auto_reconnect=long_lived` | `auto_reconnect=False` | Prevent auto-reconnect bypassing proxy |
| Line 775 | `request_retries=3 if long_lived` | `request_retries=1` | Keep 1 for API calls only |
| Line 309 | "3 minutes" | "1 minute" | Match new delay |
| Line 3327 | `FAILED_RETRY_DELAY = 180` | `FAILED_RETRY_DELAY = 60` | 1 minute retry delay |
| Line 3526 | "3 min cooldown" | "1 min cooldown" | Match new delay |
| Lines 2144-2173 | 3-attempt loop for all errors | Single attempt + SQLite-only retry | Instant disconnect on proxy failure |
| Lines 3793-3811 | 3-attempt loop for all errors | Single attempt + SQLite-only retry | Instant disconnect on proxy failure |

## Technical Details

### Why `auto_reconnect=False` is critical

When Telethon has `auto_reconnect=True`:
1. It creates a background task monitoring the connection
2. If connection drops (proxy timeout), it tries to reconnect automatically
3. This reconnection happens INSIDE Telethon, bypassing our proxy-checking code
4. Result: Account could connect without proxy and get **BANNED**

### Why `connection_retries=0` is critical

When `connection_retries > 0`:
1. Telethon's internal retry doesn't re-validate proxy before retry
2. If first attempt fails due to proxy timeout, retry may use stale socket state
3. In edge cases, this can result in direct connection without proxy

### Why SQLite lock retries are safe

SQLite "database is locked" errors are LOCAL file contention:
- They happen when multiple coroutines access the same session file
- They do NOT affect proxy/network connection state
- The proxy is still valid - just file access is blocked temporarily
- Safe to retry because session file will be released shortly

### Flow After Fix

```text
CONNECTION ATTEMPT:
  ├─ TelegramClient created with proxy config
  │   ├─ connection_retries=0 (NO internal retry)
  │   └─ auto_reconnect=False (NO background reconnect)
  │
  ├─ connect_single_attempt() called (20s timeout)
  │   ├─ SUCCESS → Continue with account
  │   └─ FAIL → INSTANT DISCONNECT (session cleaned)
  │            └─ Add to proxy retry queue (60s delay)
  │
  └─ NO RISK of Telethon retrying without proxy

AFTER 60 SECONDS:
  └─ Retry queue checks expired accounts
      └─ Fresh connection attempt with proxy
          ├─ SUCCESS → Account online
          └─ FAIL → Retry count +1 (max 3 attempts)
              └─ After 3 fails → Mark account INACTIVE
```

