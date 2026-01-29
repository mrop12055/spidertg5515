

# Fix: Proxy Timeout Handling - Wait 3 Minutes Before First Retry

## Problem Summary

The current implementation has **fast retries inside `connect_with_retry()`** that retry 3 times with 1s/2s/4s delays - this is the "Attempt 1/3... Waiting 1s" you're seeing. The user wants:

1. **No quick retries** - proxy connections need 3 minutes to stabilize, not 1-4 seconds
2. **Disable after 1 cooldown retry** - if it fails after the 3-minute wait, mark account as `auto_disabled` immediately
3. **Never remove proxy from account** - just mark proxy as "error" status in admin; admin will remove it manually

## Root Cause

The `connect_with_retry()` function (lines 576-608) contains a built-in retry loop with short delays (1s, 2s, 4s) that runs BEFORE the 3-minute cooldown queue takes over:

```python
# CURRENT BEHAVIOR (WRONG):
for attempt in range(3):        # Quick 3x retry loop
    connect()                    # Try connection
    await asyncio.sleep(1/2/4)   # Wait 1s, 2s, 4s between attempts
# THEN add to 3-minute queue
```

**What user wants:**
```python
# CORRECT BEHAVIOR:
try:
    connect()                    # Single attempt with 180s timeout
except:
    # IMMEDIATELY add to 3-minute queue - NO quick retries
```

## Changes Required

### 1. Remove Quick Retries in `connect_with_retry()` (SetupGuide.tsx)

**Current (lines 576-608):**
```python
async def connect_with_retry(client: TelegramClient, max_retries: int = 3) -> bool:
    for attempt in range(max_retries):  # 3 quick attempts
        try:
            await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
            return True
        except ...:
            # Quick retry with 1s/2s/4s delay
            if attempt < max_retries - 1:
                wait_time = min(2 ** attempt, 4)
                print(f"    [RETRY] Waiting {wait_time}s before retry...")
                await asyncio.sleep(wait_time)
```

**New (single attempt, 3-minute proxy timeout):**
```python
async def connect_with_retry(client: TelegramClient, connection_timeout: int = 180) -> bool:
    """
    Attempt single connection with 3-minute timeout for slow proxies.
    NO quick retries - if proxy fails, add to 3-minute cooldown queue.
    """
    try:
        await asyncio.wait_for(client.connect(), timeout=connection_timeout)
        print(f"    [CONNECTED] Proxy connection successful")
        return True
    except asyncio.TimeoutError:
        print(f"    [TIMEOUT] Proxy connection timed out after {connection_timeout}s")
        return False
    except Exception as e:
        err_str = str(e).lower()
        if any(p in err_str for p in PROXY_ERROR_PATTERNS):
            print(f"    [PROXY ERROR] {e}")
        else:
            print(f"    [ERROR] {e}")
        return False
```

### 2. Change `PROXY_MAX_RETRIES` from 3 to 1 (SetupGuide.tsx)

**Current (line 139):**
```python
PROXY_MAX_RETRIES = 3     # Max retry attempts before marking account as inactive
```

**New:**
```python
PROXY_MAX_RETRIES = 1     # After 1 failed cooldown retry (total: initial + 1 retry = 2 attempts), disable
```

This means:
- **Initial connection attempt** - uses 3-minute proxy timeout
- If fails: wait 3 minutes in queue
- **Retry attempt #1** - uses 3-minute proxy timeout again
- If fails: mark account as `auto_disabled` immediately

### 3. Update Connection Timeout Constant (SetupGuide.tsx)

**Current (line 142):**
```python
CONNECTION_TIMEOUT = 20      # Telegram connection timeout (increased from 10)
```

**New:**
```python
PROXY_CONNECTION_TIMEOUT = 180   # 3 minutes for slow proxy connections
```

### 4. Update Backend Handler (report-task-result/index.ts)

The backend already handles `proxy_max_retries_exceeded` correctly - it marks the account as:
- `status: "disconnected"`
- `auto_disabled: true`
- `disabled_reason: "Proxy error: Failed Xx (3-min intervals) - requires admin fix"`

The proxy_id is **never removed** (this is already correct).

Also mark the proxy status as "error" so it shows in admin dashboard.

## Updated Flow

```text
Account Connection Attempt
        ↓
connect_with_retry() - 180s timeout (NO quick retries)
        ↓
If SUCCESS:
   ✓ Account connected, start listening for messages
        ↓
If FAILURE:
   → force_disconnect_session() - kill session immediately
   → report_result("proxy_error") - mark proxy as "error" in DB
   → add_to_proxy_retry_queue() - schedule retry after 3 minutes
        ↓
[After 3 minutes]
        ↓
retry_proxy_error_accounts() picks up account
        ↓
connect_with_retry() - 180s timeout again
        ↓
If SUCCESS: ✓ Connected
If FAILURE: 
   → retry_count (now 1) >= PROXY_MAX_RETRIES (now 1)
   → report_result("proxy_max_retries_exceeded")
   → Account marked: disconnected + auto_disabled
   → Admin must fix proxy and reactivate manually
```

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | Remove quick retry loop in `connect_with_retry()`, increase timeout to 180s, change `PROXY_MAX_RETRIES` to 1 |
| `supabase/functions/report-task-result/index.ts` | Update `proxy_max_retries_exceeded` handler to also mark proxy status as "error" |

## Technical Summary

| Setting | Current | New | Purpose |
|---------|---------|-----|---------|
| `CONNECTION_TIMEOUT` | 20s | 180s (renamed to `PROXY_CONNECTION_TIMEOUT`) | Give proxy 3 minutes to connect |
| Quick retries | 3x (1s, 2s, 4s delays) | 0 (removed) | No fast retries |
| `PROXY_MAX_RETRIES` | 3 | 1 | Auto-disable after 1 cooldown retry |
| `PROXY_RETRY_DELAY` | 180s | 180s (unchanged) | 3 minutes between cooldown retries |
| Proxy removal | Never | Never (unchanged) | Admin handles manually |

