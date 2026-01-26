

# Plan: Fix Network Error Detection and Proper Retry Logic in Live Chat Runner

## Problem Identified

After analyzing the uploaded logs, I found these issues:

### What's Happening

1. **"Server closed the connection: [WinError 121]"** - These messages are printed by **Telethon internally**, not caught by our exception handlers
2. **`client.is_connected()`** returns True even after socket death - Telethon's internal state lags behind
3. **`catch_up()` doesn't raise exceptions** for connection drops - Telethon tries auto-reconnect internally
4. **Tasks destroyed without cleanup** - When Telethon's internal reconnect fails, pending tasks are killed ungracefully
5. **Retry queue stuck at 8** - Accounts are scheduled for retry but the retry logic isn't effective

### Root Cause

The `keep_clients_alive()` function relies on:
- `client.is_connected()` - unreliable for detecting dead sockets
- `catch_up()` raising exceptions - doesn't happen for all disconnect scenarios

When network errors occur mid-session:
1. Telethon prints "Server closed the connection" internally
2. Our code doesn't catch this (no exception raised to us)
3. `is_connected()` still returns True
4. Eventually tasks are destroyed, causing the "Task was destroyed" warnings

## Solution

### Step 1: Add Proactive Connection Health Check

Add a health check that sends an actual Telegram API call to verify the connection is truly alive:

```python
async def check_client_health(client, account_id: str) -> bool:
    """
    Proactively check if client connection is truly alive.
    A simple API call that will fail fast if connection is dead.
    Returns True if healthy, False if connection is dead.
    """
    try:
        # get_me() is lightweight and will fail quickly if socket is dead
        await asyncio.wait_for(client.get_me(), timeout=10)
        return True
    except Exception as e:
        error_str = str(e).lower()
        if any(p in error_str for p in PROXY_ERROR_PATTERNS + NETWORK_ERROR_PATTERNS):
            print(f"  [HEALTH CHECK] {account_id[:8]} - Dead connection detected: {str(e)[:50]}")
        return False
```

### Step 2: Update keep_clients_alive with Periodic Health Checks

Run health checks every 60 seconds on all clients:

```python
async def keep_clients_alive():
    # ... existing code ...
    last_health_check = time.time()
    HEALTH_CHECK_INTERVAL = 60  # Check every 60 seconds
    
    while RUNNING:
        # ... existing loop code ...
        
        # ========== PERIODIC HEALTH CHECK ==========
        if time.time() - last_health_check >= HEALTH_CHECK_INTERVAL:
            for acc_id, client in list(active_clients.items()):
                if not await check_client_health(client, acc_id):
                    # Connection is dead - immediately disconnect and add to proxy retry
                    await force_disconnect_session(acc_id, "health_check_failed")
                    await add_to_proxy_retry_queue(acc_id, {"id": acc_id}, None)
            last_health_check = time.time()
```

### Step 3: Use force_disconnect_session Consistently

Update `disconnect_and_schedule_retry` to call `add_to_proxy_retry_queue` for network errors:

```python
async def disconnect_and_schedule_retry(acc_id: str, reason: str = "disconnected"):
    # ... existing cleanup code ...
    
    # Check if this is a proxy/network error - use the 3-attempt retry queue
    is_proxy_error = any(p in reason.lower() for p in PROXY_ERROR_PATTERNS + NETWORK_ERROR_PATTERNS)
    
    if is_proxy_error:
        # Use proxy retry queue with 3-attempt limit and 3-minute delay
        await add_to_proxy_retry_queue(acc_id, {"id": acc_id}, None)
    else:
        # Non-proxy errors use standard retry schedule
        failed_connection_accounts[acc_id] = time.time() + FAILED_RETRY_DELAY
```

### Step 4: Cancel All Pending Telethon Tasks on Disconnect

Enhance `force_disconnect_session` to cancel ALL internal Telethon tasks:

```python
async def force_disconnect_session(account_id: str, reason: str = "proxy_error"):
    # ... existing code to pop client ...
    
    if client:
        try:
            # Cancel ALL internal Telethon tasks (not just _updates_handle)
            internal_handles = ['_updates_handle', '_sender', '_borrowed_senders']
            for handle_name in internal_handles:
                if hasattr(client, handle_name):
                    handle = getattr(client, handle_name)
                    if handle:
                        if hasattr(handle, 'cancel'):
                            handle.cancel()
                        elif isinstance(handle, dict):
                            for sender in handle.values():
                                if hasattr(sender, 'cancel'):
                                    sender.cancel()
            
            # Also cancel the _sender's loops if they exist
            if hasattr(client, '_sender') and client._sender:
                sender = client._sender
                for loop_name in ['_send_loop', '_recv_loop']:
                    if hasattr(sender, loop_name):
                        loop = getattr(sender, loop_name)
                        if loop and hasattr(loop, 'cancel'):
                            loop.cancel()
            
            # Disconnect with longer timeout for cleanup
            if client.is_connected():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(client.disconnect()), 
                        timeout=10  # Increased from 5
                    )
                except:
                    pass
            
            # Give MORE time for event loop cleanup
            await asyncio.sleep(0.5)  # Increased from 0.2
            
            del client
        except Exception as e:
            print(f"  [FORCE DISCONNECT] {phone} - Force cleared (error: {str(e)[:30]})")
```

### Step 5: Add Catch for Telethon Internal Logs

Add a warning filter or hook to detect Telethon's internal "Server closed" messages and trigger disconnect:

```python
# Alternative approach - wrap the keep_clients_alive iteration in a broader try-catch
# that looks for specific patterns in the output buffer

# In the main_loop, periodically check for stuck clients:
async def check_stuck_clients():
    """Check for clients that are in active_clients but not receiving updates."""
    now = time.time()
    for acc_id, client in list(active_clients.items()):
        # If client reports connected but hasn't received updates in 5 minutes
        # it might be a zombie connection
        try:
            if not client.is_connected():
                await force_disconnect_session(acc_id, "zombie_connection")
                await add_to_proxy_retry_queue(acc_id, {"id": acc_id}, None)
        except:
            pass
```

## Files to Modify

1. **`src/pages/SetupGuide.tsx`**:
   - Add `check_client_health()` function
   - Update `keep_clients_alive()` to include periodic health checks
   - Update `disconnect_and_schedule_retry()` to use proxy retry queue for network errors
   - Enhance `force_disconnect_session()` to cancel more Telethon internal tasks
   - Add `check_stuck_clients()` helper function

## Expected Outcome

After this fix:
- Dead connections are detected proactively via health checks (not just waiting for exceptions)
- Network errors trigger the 3-attempt retry logic with 3-minute delays
- All Telethon internal tasks are properly cancelled before disconnect
- The "Task was destroyed" and "GeneratorExit" warnings should be eliminated
- Accounts with persistent proxy failures will be marked inactive after 3 failed attempts

## Timeline Example

| Time | Event |
|------|-------|
| 0:00 | Health check detects dead socket |
| 0:00 | IMMEDIATE disconnect, add to retry queue |
| 3:00 | Retry attempt 1 - still failing |
| 6:00 | Retry attempt 2 - still failing |
| 9:00 | Retry attempt 3 - still failing |
| 9:00 | Mark account as DISCONNECTED (auto_disabled) |

