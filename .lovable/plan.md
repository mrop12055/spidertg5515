

# Fix: Instant Disconnect on Proxy Failure - No Connection Retries

## Current Problem

The LiveChat runner has a risky retry mechanism:

1. `connect_with_retry()` function retries connection **3 times** with exponential backoff (1s, 2s, 4s delays)
2. During retry attempts, if the proxy fails but network is available, the Telethon client **could connect without the proxy**
3. This causes **account bans** because Telegram sees different IP addresses

Your requirement:
- **INSTANT DISCONNECT** on proxy failure - no retries
- Wait until ALL accounts finish connecting
- Retry failed accounts after **1 minute** (not 3 minutes)
- Never risk connecting without proxy

## Solution

### File: `src/pages/SetupGuide.tsx`

**Change 1: Remove retry from `connect_with_retry` - Make it single attempt**

Replace `connect_with_retry` function (lines 569-600) with a simple single-attempt connect:

```python
async def connect_single_attempt(client: TelegramClient, timeout: int = CONNECTION_TIMEOUT) -> tuple[bool, str]:
    """
    Single connection attempt - NO RETRIES.
    If proxy fails, we disconnect immediately to prevent proxyless connection.
    Returns (success, error_message).
    """
    try:
        await asyncio.wait_for(client.connect(), timeout=timeout)
        return True, None
    except asyncio.TimeoutError:
        return False, "Connection timeout"
    except Exception as e:
        return False, str(e)
```

**Change 2: Update client creation to use single attempt (lines 808-826)**

Replace retry logic in `_get_or_create_client_internal`:

```python
# BEFORE (3 retries):
print(f"  [CONNECT] {account['phone_number']} (with 3 retries)...")
if not await connect_with_retry(client, max_retries=3):

# AFTER (single attempt - instant fail):
print(f"  [CONNECT] {account['phone_number']} (single attempt - no retry)...")
success, connect_error = await connect_single_attempt(client, timeout=CONNECTION_TIMEOUT)
if not success:
    # PROXY FAILED - IMMEDIATELY DISCONNECT
    print(f"  [PROXY ERROR] {phone} - INSTANT disconnect: {connect_error[:50]}")
    
    # Clean up any partial connection state
    try:
        if client.is_connected():
            await asyncio.wait_for(client.disconnect(), timeout=5)
    except:
        pass
    
    # Report and queue for retry (after all accounts connected)
    asyncio.create_task(report_result("proxy_error", {
        "account_id": account_id,
        "proxy_id": proxy_id,
        "reason": f"Instant fail (no retry): {connect_error[:100]}"
    }))
    
    await add_to_proxy_retry_queue(account_id, account, task_proxy)
    return None
```

**Change 3: Reduce retry delay from 3 minutes to 1 minute (line 138)**

```python
# BEFORE:
PROXY_RETRY_DELAY = 180   # 3 minutes

# AFTER:
PROXY_RETRY_DELAY = 60    # 1 minute (user request)
```

**Change 4: Update retry queue comments (line 321)**

```python
# BEFORE:
_proxy_retry_queue[account_id]["next_retry_at"] = now + PROXY_RETRY_DELAY  # 3 minutes from now

# AFTER:
_proxy_retry_queue[account_id]["next_retry_at"] = now + PROXY_RETRY_DELAY  # 1 minute from now
```

**Change 5: Update logging messages to reflect 1-minute delay (lines 329, 339)**

```python
# BEFORE:
print(f"  [PROXY RETRY] {phone} - Attempt {retry_count}/{PROXY_MAX_RETRIES}, retry in 3 min ({remaining} left)")

# AFTER:
print(f"  [PROXY RETRY] {phone} - Attempt {retry_count}/{PROXY_MAX_RETRIES}, retry in 1 min ({remaining} left)")
```

## Summary of Changes

| Setting | Current | New | Why |
|---------|---------|-----|-----|
| Connection Retries | 3 attempts with backoff | 1 attempt (instant fail) | Prevents proxyless connection |
| Retry Delay | 180s (3 min) | 60s (1 min) | Faster recovery after all connected |
| On Proxy Fail | Retry immediately | Instant disconnect + queue | No risk of ban |

## How It Works After Changes

```text
[START] Connect 137 accounts in parallel
  ├─ Account A: Connected OK ✓
  ├─ Account B: Proxy timeout → INSTANT DISCONNECT → Queue for 1-min retry
  ├─ Account C: Connected OK ✓
  └─ Account D: Proxy error → INSTANT DISCONNECT → Queue for 1-min retry

[AFTER ALL CONNECTED] (main loop continues)
  └─ Every loop iteration: Check retry queue for accounts past 1-min mark
       └─ Retry Account B and D now (1 minute passed)
```

## Technical Details

**Why instant disconnect prevents bans:**
- Telethon stores connection state in SQLite session file
- If we retry with a dead proxy, Telethon might fall back to direct connection
- Direct connection = different IP = Telegram detects mismatch = BAN
- By disconnecting immediately, we ensure session file is clean for next attempt

