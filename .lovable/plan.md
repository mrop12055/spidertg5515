

# CRITICAL FIX: Prevent IP Leak During Proxy Failure

## Security Vulnerability Identified

**Your concern is 100% valid!** There's a critical security gap in the current LiveChat runner:

1. **Problem**: When `long_lived=True`, the client is created with `auto_reconnect=True` and `connection_retries=3`
2. **Risk**: If proxy fails mid-session, Telethon's internal auto-reconnect could try to reconnect before we call `force_disconnect_session`
3. **Window of exposure**: Between proxy failure and our error handling, Telethon may attempt to reconnect and potentially expose real IP

## Root Cause

```python
# Current code (line 788-790)
client = TelegramClient(
    ...
    proxy=proxy,
    connection_retries=3 if long_lived else 0,  # ⚠️ Risk
    auto_reconnect=long_lived,  # ⚠️ TRUE for LiveChat = Telethon controls reconnections
    ...
)
```

When `auto_reconnect=True`, Telethon has its own internal reconnection logic that runs **before** our error handlers catch the exception.

## Solution: Disable Auto-Reconnect, Handle Manually

**Change 1**: Disable Telethon's internal auto-reconnect for ALL connections

```python
# SAFE: We control all reconnections manually
client = TelegramClient(
    ...
    proxy=proxy,
    connection_retries=0,      # DISABLED - we handle retries manually
    retry_delay=0,             # DISABLED
    auto_reconnect=False,      # DISABLED - prevents IP leak
    request_retries=1          # Minimal - fail fast
)
```

**Change 2**: Our existing manual retry system already handles reconnections safely:
- `force_disconnect_session()` - Kills session immediately
- `add_to_proxy_retry_queue()` - Schedules retry with proxy validation
- All reconnections go through `get_or_create_client()` which re-validates proxy FIRST

**Change 3**: Add explicit proxy verification before ANY operation

```python
# In send_message and other operations, verify proxy is still set
if not client._proxy:
    print(f"  [SECURITY] {phone} - NO PROXY - refusing to send")
    await force_disconnect_session(account_id, "no_proxy_security_kill")
    return None
```

---

## Technical Changes

### File: `src/pages/SetupGuide.tsx`

**Change 1: Line 786-791 - Disable Telethon auto-reconnect**

Current:
```python
client = TelegramClient(
    session_path, int(api_id), api_hash,
    ...
    proxy=proxy,
    timeout=CONNECTION_TIMEOUT,
    connection_retries=3 if long_lived else 0,
    retry_delay=2 if long_lived else 0,
    auto_reconnect=long_lived,
    request_retries=3 if long_lived else 1
)
```

Fixed:
```python
client = TelegramClient(
    session_path, int(api_id), api_hash,
    ...
    proxy=proxy,
    timeout=CONNECTION_TIMEOUT,
    # SECURITY: Disable ALL auto-reconnect to prevent IP leak on proxy failure
    # We handle all reconnections manually via force_disconnect + retry queue
    connection_retries=0,   # DISABLED - manual retries only
    retry_delay=0,          # DISABLED
    auto_reconnect=False,   # CRITICAL: Prevents Telethon from reconnecting without proxy
    request_retries=1       # Minimal - fail fast so we catch errors
)
```

**Change 2: Add proxy safety check in send_message function (around line 1050-1080)**

Add before sending:
```python
# SECURITY: Verify proxy is still configured before ANY network operation
if not client._proxy:
    print(f"  [SECURITY] {phone} - NO PROXY DETECTED - aborting send")
    await force_disconnect_session(account_id, "security_no_proxy")
    return None
```

**Change 3: Add proxy safety check in check_client_health function (line 281-303)**

Add at start of health check:
```python
async def check_client_health(client, account_id: str) -> bool:
    """..."""
    try:
        # SECURITY: Verify proxy is still configured
        if not getattr(client, '_proxy', None):
            print(f"  [SECURITY] {account_id[:8]} - NO PROXY - killing session")
            return False  # Will trigger force_disconnect
        
        # get_me() is lightweight and will fail quickly if socket is dead
        await asyncio.wait_for(client.get_me(), timeout=10)
        return True
    ...
```

---

## Expected Outcome

After implementation:

1. **No auto-reconnect**: Telethon will NOT attempt any reconnection on its own
2. **Fail-fast behavior**: Any proxy failure immediately terminates the connection
3. **Proxy verification**: Before any send operation, we verify proxy is still configured
4. **Manual retry only**: All reconnections go through our controlled flow that validates proxy FIRST
5. **Zero IP exposure**: Your accounts will NEVER connect to Telegram without proxy

---

## Safety Verification

The current flow already has these safety measures (which will work better once auto_reconnect is disabled):

1. **Initial connection**: Proxy is validated BEFORE connection (line 713-721)
2. **Proxy failure**: `force_disconnect_session()` is called immediately
3. **Retry queue**: Reconnections go through `get_or_create_client()` which re-validates proxy
4. **Max retries**: After 3 failed attempts, account is marked inactive

Disabling `auto_reconnect` closes the security gap where Telethon might reconnect without our knowledge.

