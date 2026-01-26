
# Plan: Fix GeneratorExit RuntimeError in Live Chat Runner

## Problem Summary

The error `RuntimeError: coroutine ignored GeneratorExit` occurs when Telethon's internal `Connection._recv_loop` coroutine is forcefully interrupted during disconnect. This happens because:

1. Telethon maintains a background receive loop (`_recv_loop`) that continuously listens for data
2. When `client.disconnect()` is called, this loop is interrupted mid-operation
3. Python's garbage collector raises `GeneratorExit` to clean up the coroutine
4. The coroutine doesn't properly handle this, causing the RuntimeError

## Root Cause

The current disconnect functions call `client.disconnect()` directly without:
1. Stopping internal listeners first
2. Cancelling pending tasks explicitly
3. Allowing the receive loop to exit gracefully

## Solution

Update both disconnect functions to properly cleanup Telethon client connections:

### Step 1: Update force_disconnect_session Function

Location: `src/pages/SetupGuide.tsx` lines 198-230

Add proper async cleanup before calling `client.disconnect()`:

```python
async def force_disconnect_session(account_id: str, reason: str = "proxy_error"):
    """
    IMMEDIATELY disconnect and clear session from memory.
    Called the MOMENT a proxy failure is detected - before any retry logic.
    
    FIX: Properly cancels pending tasks and allows receive loop to exit gracefully
    to prevent "coroutine ignored GeneratorExit" RuntimeError.
    """
    global active_clients, message_queues
    
    phone = account_id[:8]
    
    # Step 1: Remove from active clients FIRST (prevents any further operations)
    client = active_clients.pop(account_id, None)
    
    # Step 2: Force disconnect if client exists with PROPER CLEANUP
    if client:
        try:
            # Cancel any pending updates/listeners BEFORE disconnect
            if hasattr(client, '_updates_handle') and client._updates_handle:
                client._updates_handle.cancel()
            
            # Try graceful disconnect first
            if client.is_connected():
                try:
                    # Use asyncio.shield to prevent cancellation during disconnect
                    await asyncio.wait_for(
                        asyncio.shield(client.disconnect()), 
                        timeout=5
                    )
                except asyncio.TimeoutError:
                    pass
                except Exception:
                    pass
            
            # CRITICAL: Allow event loop to process pending callbacks
            # This prevents "coroutine ignored GeneratorExit" by letting
            # the _recv_loop coroutine exit cleanly
            await asyncio.sleep(0.2)
            
            # Force garbage collection to clean up any remaining references
            del client
            
            print(f"  [FORCE DISCONNECT] {phone} - Session terminated: {reason}")
        except Exception as e:
            print(f"  [FORCE DISCONNECT] {phone} - Force cleared (error: {str(e)[:30]})")
    else:
        print(f"  [FORCE DISCONNECT] {phone} - No active client found, cleared tracking")
    
    # Step 3: Clear from message queue tracking if exists
    if account_id in message_queues:
        del message_queues[account_id]
    
    return True
```

### Step 2: Update disconnect_and_schedule_retry Function

Location: `src/pages/SetupGuide.tsx` lines 3201-3233

Apply the same cleanup pattern:

```python
async def disconnect_and_schedule_retry(acc_id: str, reason: str = "disconnected"):
    """
    Properly disconnect a session and schedule it for retry after 3 MINUTES.
    
    FIX: Properly cancels pending tasks and allows receive loop to exit gracefully
    to prevent "coroutine ignored GeneratorExit" RuntimeError.
    """
    global failed_connection_accounts
    
    phone = acc_id[:8]
    
    # IMMEDIATE DISCONNECT - Remove from active clients and disconnect properly
    if acc_id in active_clients:
        try:
            client = active_clients.pop(acc_id)
            
            # Cancel any pending updates/listeners BEFORE disconnect
            if hasattr(client, '_updates_handle') and client._updates_handle:
                client._updates_handle.cancel()
            
            if client.is_connected():
                try:
                    # Use asyncio.shield to prevent cancellation during disconnect
                    await asyncio.wait_for(
                        asyncio.shield(client.disconnect()), 
                        timeout=5
                    )
                except asyncio.TimeoutError:
                    print(f"  [TIMEOUT] Disconnect timeout for {phone} - forcing cleanup")
                except Exception:
                    pass
                
                # CRITICAL: Allow event loop to process pending callbacks
                await asyncio.sleep(0.2)
                print(f"  [DISCONNECT] {phone} - {reason} - will retry in 3 min")
            else:
                print(f"  [CLEANUP] {phone} - already disconnected - will retry in 3 min")
            
            # Force cleanup of client reference
            del client
            
        except Exception as e:
            print(f"  [CLEANUP] {phone} - force cleanup ({e}) - will retry in 3 min")
    
    # Schedule retry after 3 MINUTES (180 seconds)
    failed_connection_accounts[acc_id] = time.time() + FAILED_RETRY_DELAY
```

### Step 3: Update Cleanup in _get_or_create_client_internal

Location: `src/pages/SetupGuide.tsx` lines 569-605

Apply consistent cleanup pattern when clearing cached clients:

```python
# In the client cleanup sections, add:
if hasattr(old_client, '_updates_handle') and old_client._updates_handle:
    old_client._updates_handle.cancel()
# Then proceed with disconnect
```

## Technical Details

| Issue | Solution |
|-------|----------|
| `_recv_loop` interrupted | Cancel updates handler before disconnect |
| GeneratorExit not caught | Use `asyncio.shield()` around disconnect |
| Pending callbacks | Add 0.2s sleep after disconnect for event loop cleanup |
| Memory leaks | Explicitly `del client` after disconnect |

## Files to Modify

1. **`src/pages/SetupGuide.tsx`**:
   - Update `force_disconnect_session()` (lines 198-230)
   - Update `disconnect_and_schedule_retry()` (lines 3201-3233)
   - Update client cleanup in `_get_or_create_client_internal()` (lines 569-605)

## Expected Outcome

After this fix:
- No more `RuntimeError: coroutine ignored GeneratorExit` errors
- Cleaner session disconnects without orphaned coroutines
- Proper resource cleanup preventing memory leaks
- The 3-minute retry logic continues to work as designed
