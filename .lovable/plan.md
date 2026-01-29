

# Fix: LiveChat 3-Minute Proxy Timeout with Immediate Disable

## Problem Summary

Three issues are causing the current behavior:

1. **Outer timeout (30s) overrides the 3-minute proxy timeout**
   - `CONNECT_TIMEOUT_SECONDS = 30` at line 2660 wraps the entire connection
   - The inner `PROXY_CONNECTION_TIMEOUT = 180` never gets a chance to complete
   - Connection is killed after 30s, not 3 minutes

2. **Session checks are reporting errors and changing account status**
   - `report_session_check()` calls at lines 863, 877, 881, 885, 889, 893, 899, 924, 928, 932, 938 mark accounts as "disconnected" or "banned" on errors
   - These run before the retry logic can take over

3. **User wants IMMEDIATE disable after 3-minute timeout fails** (no retry queue)
   - Current: fail → 3-min queue → retry → fail again → disable
   - Desired: fail after 3-min timeout → immediately kill session and disable

## Changes Required

### 1. Increase `CONNECT_TIMEOUT_SECONDS` to 200 seconds

**Location:** Line 2660

**Current:**
```python
CONNECT_TIMEOUT_SECONDS = 30  # Timeout for stable connections
```

**New:**
```python
CONNECT_TIMEOUT_SECONDS = 200  # 3+ minutes to allow full proxy timeout (180s) + overhead
```

### 2. Remove retry queue - immediate disable on proxy failure

**Current flow (wrong):**
```
fail → add_to_proxy_retry_queue() → wait 3 min → retry → disable
```

**New flow (correct):**
```
3-minute timeout for proxy → fail → kill session → disable immediately
```

**Location:** Lines 809-826 in `get_or_create_client()` and lines 840-846

**Current:**
```python
if not await connect_with_retry(client):
    print(f"  [PROXY ERROR] Connection failed for {phone} - adding to 3-min retry queue")
    await force_disconnect_session(account_id, "proxy_connection_failed")
    asyncio.create_task(report_result("proxy_error", {...}))
    await add_to_proxy_retry_queue(account_id, account, task_proxy)  # ← REMOVE THIS
    return None
```

**New:**
```python
if not await connect_with_retry(client):
    print(f"  [CONNECTION TIMEOUT] {phone} - Proxy failed after 180s - DISABLING ACCOUNT")
    await force_disconnect_session(account_id, "proxy_connection_timeout")
    asyncio.create_task(report_result("proxy_timeout_disable", {
        "account_id": account_id,
        "proxy_id": proxy_id,
        "reason": "Proxy connection failed after 3-minute timeout - account disabled"
    }))
    # NO RETRY QUEUE - immediate disable
    return None
```

### 3. Replace `report_session_check()` with `log_error()` in error paths

Session checks should NOT run when proxy fails because we can't determine session status without a successful connection. Replace all error-path session checks with log_error() for visibility.

**Lines to modify:** 863, 877, 881, 885, 889, 893, 899, 924, 928, 932, 938

**Current pattern:**
```python
except AuthKeyUnregisteredError:
    print(f"  [EXPIRED] {phone}: Auth key unregistered")
    asyncio.create_task(report_session_check(account_id, success=False, error="Auth key unregistered"))
    return None
```

**New pattern:**
```python
except AuthKeyUnregisteredError:
    print(f"  [EXPIRED] {phone}: Auth key unregistered")
    asyncio.create_task(log_error("livechat", f"{phone}: Auth key unregistered - session expired"))
    return None
```

### 4. Add new `proxy_timeout_disable` handler to backend

**Location:** `supabase/functions/report-task-result/index.ts`

Add handler for the new result type that:
- Marks account as `status: "disconnected"` 
- Sets `auto_disabled: true`
- Sets `disabled_reason: "Connection timeout - proxy failed after 3 minutes"`
- Marks proxy as `status: "error"`
- **Never removes `proxy_id`** from account

### 5. Remove retry queue logic from main_loop error handling

**Location:** Lines 3717-3729

**Current:**
```python
elif error == "TIMEOUT":
    timeout_count += 1
    await disconnect_and_schedule_retry(acc_id, "connection timeout")
```

**New:**
```python
elif error == "TIMEOUT":
    timeout_count += 1
    # Timeout already handled in get_or_create_client with immediate disable
    # Just ensure session is killed (already done in connect_with_retry failure path)
```

## Expected Flow After Fix

```text
Account Connection Attempt (main_loop)
        ↓
asyncio.wait_for(connect_account_with_fingerprint(), timeout=200s)  ← Allows full 180s
        ↓
get_or_create_client() with skip_session_check=True
        ↓
connect_with_retry(client) - 180s PROXY timeout (single attempt)
        ↓
If SUCCESS:
   ✓ Account connected
   ✓ NO session check (skip_session_check=True)
        ↓
If TIMEOUT after 180s:
   → force_disconnect_session() - KILL SESSION IMMEDIATELY
   → report_result("proxy_timeout_disable") - mark account INACTIVE
   → Proxy marked: error status
   → PROXY STAYS ASSIGNED (never removed)
   → Account marked: disconnected + auto_disabled
   → NO RETRY QUEUE - immediate disable
```

## Security Guarantees

| Guarantee | Implementation |
|-----------|----------------|
| Proxy always used | `connect_with_retry()` only accepts clients with proxy configured |
| Proxy never removed | `proxy_id` stays in database even after timeout |
| Session killed on failure | `force_disconnect_session()` called immediately on timeout |
| No connection without proxy | `auto_reconnect=False` and `connection_retries=0` in Telethon client |
| 3 minutes for proxy | `PROXY_CONNECTION_TIMEOUT = 180` fully respected now |
| Immediate disable | No retry queue - account disabled on first 3-minute timeout failure |

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | 1. Increase `CONNECT_TIMEOUT_SECONDS` from 30 to 200 |
| `src/pages/SetupGuide.tsx` | 2. Replace `add_to_proxy_retry_queue()` with immediate `report_result("proxy_timeout_disable")` |
| `src/pages/SetupGuide.tsx` | 3. Replace all error-path `report_session_check()` with `log_error()` |
| `supabase/functions/report-task-result/index.ts` | 4. Add `proxy_timeout_disable` handler to mark account inactive and proxy as error |

## Technical Summary

| Setting | Current | New | Purpose |
|---------|---------|-----|---------|
| `CONNECT_TIMEOUT_SECONDS` | 30s | 200s | Allow full 180s proxy timeout |
| `PROXY_CONNECTION_TIMEOUT` | 180s | 180s (unchanged) | 3 minutes for proxy to connect |
| Retry queue | Active (3-min delay) | REMOVED | Immediate disable on timeout |
| `report_session_check()` on errors | Active | Replaced with `log_error()` | Don't change status on proxy failure |
| Proxy removal | Never | Never | Admin handles manually |

