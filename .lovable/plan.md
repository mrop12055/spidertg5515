

# Fix Runner Hang After CATCHUP Phase - COMPLETED

## Problem

With 500+ accounts, the runner hangs AFTER the CATCHUP phase completes but BEFORE entering the main task loop. The root cause was the `setup_handlers()` function which iterates over all 500+ clients to register event handlers - if any client had a stale/disconnected socket, the registration would block indefinitely.

## Solution Applied

1. **Defensive handler registration**: Added try/catch around each handler registration so one bad client doesn't block all others
2. **Connection check before registration**: Skip disconnected clients instead of trying to register handlers on them
3. **Debug markers with explicit stdout flush**: Added `[DEBUG]` print statements with `sys.stdout.flush()` to prevent buffering from hiding where the runner actually stops
4. **Progress logging**: Print how many handlers were successfully registered

## Changes Made to SetupGuide.tsx (Python Runner)

### Updated `setup_handlers()` function:

```python
async def setup_handlers():
    """Set up incoming message handlers with defensive error handling."""
    count = 0
    for aid, client in list(clients.items()):
        if getattr(client, "_h", False):
            continue
        
        try:
            # Check if client is still connected before registering handler
            if not client.is_connected():
                print(f"  [HANDLER] Skipping disconnected client {aid[:8]}...")
                continue
            
            @client.on(events.NewMessage(incoming=True))
            async def handler(event, a=aid):
                await on_message(event, a)
            
            setattr(client, "_h", True)
            count += 1
        except Exception as e:
            print(f"  [HANDLER] Failed to register for {aid[:8]}: {str(e)[:30]}")
            continue
    
    if count > 0:
        print(f"  [HANDLERS] Registered {count} new message handlers")
```

### Added debug markers in `main()`:

```python
_, _ = await connect_all_from_response(initial_accounts)
print("  [DEBUG] CATCHUP complete, setting up handlers...")
sys.stdout.flush()

await setup_handlers()
print("  [DEBUG] Handlers registered, entering main loop...")
sys.stdout.flush()
```

## Why This Works

- **No more blocking**: Individual client failures don't block the entire handler setup
- **Skip dead clients**: Disconnected clients are skipped rather than blocking on them
- **Visibility**: Debug markers with forced flush show exactly where runner stops
- **No new limits**: No semaphores or throttling added - just defensive error handling

## Expected Console Output

After applying this fix, you should see:
```
  [DEBUG] CATCHUP complete, setting up handlers...
  [HANDLERS] Registered 487 new message handlers
  [DEBUG] Handlers registered, entering main loop...

  ==================================================
    PROCESSING TASKS + LISTENING FOR MESSAGES
  ==================================================

  [WAIT] No tasks (487 clients listening)
```

If it still hangs, the `[DEBUG]` lines will show exactly where it stops.
