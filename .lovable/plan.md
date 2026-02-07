

# Fix: Runner Stops After CATCHUP - Handler Registration Bottleneck

## Problem Identified

The Python runner completes CATCHUP successfully but then **appears to freeze** before entering the main loop. The bottleneck is in `setup_handlers()`, which runs **sequentially** through all ~1,000 connected clients.

For each client, it calls:
```python
connected = await asyncio.wait_for(asyncio.to_thread(client.is_connected), timeout=0.5)
```

With 1,000 clients and a 0.5s timeout per client, this step can take **up to 500 seconds** (8+ minutes) in the worst case. If many clients are unresponsive or slow, the runner sits silently at this stage with no output (it only prints every 25th client).

Additionally, `asyncio.to_thread(client.is_connected)` wraps a synchronous call in a thread. With 1,000+ clients doing this sequentially, thread pool exhaustion and GIL contention can cause further delays.

## Solution

Update the Python runner code in `SetupGuide.tsx` to:

1. **Parallelize handler registration** using `asyncio.gather` with batches instead of sequential iteration
2. **Add more frequent progress logging** so the runner doesn't appear stuck
3. **Reduce the is_connected timeout** from 0.5s to 0.3s (we just need a quick liveness check)

## Technical Details

### File: `src/pages/SetupGuide.tsx`

**Change 1: Parallelize `setup_handlers()` function**

Replace the sequential loop in `setup_handlers()` with parallel batched processing:

```python
async def setup_handlers():
    """Set up incoming message handlers with defensive error handling."""
    count = 0
    items = list(clients.items())
    total = len(items)
    started = time.time()
    
    async def _register_one(aid, client):
        nonlocal count
        if getattr(client, "_h", False):
            return True  # Already registered
        try:
            connected = False
            try:
                connected = await asyncio.wait_for(
                    asyncio.to_thread(client.is_connected), timeout=0.3
                )
            except Exception:
                connected = False
            
            if not connected:
                return False
            
            @client.on(events.NewMessage(incoming=True))
            async def handler(event, a=aid):
                await on_message(event, a)
            
            setattr(client, "_h", True)
            count += 1
            return True
        except Exception:
            return False
    
    # Process in parallel batches of 50
    BATCH = 50
    for i in range(0, total, BATCH):
        batch = items[i:i+BATCH]
        print(f"  [HANDLER] Registering {i+1}-{min(i+BATCH, total)}/{total}...")
        sys.stdout.flush()
        await asyncio.gather(
            *[_register_one(aid, client) for aid, client in batch],
            return_exceptions=True,
        )
    
    if count > 0:
        took = time.time() - started
        print(f"  [HANDLERS] Registered {count} new message handlers in {took:.1f}s")
        sys.stdout.flush()
```

This reduces handler registration from up to 500s (sequential) to approximately 10-15s (parallel batches of 50).

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | Parallelize `setup_handlers()` using batched `asyncio.gather` instead of sequential loop, add frequent progress logging |

## Expected Result
- Handler registration for 1,000 clients will complete in ~10-15 seconds instead of potentially 500+ seconds
- Clear progress logging every 50 clients so the runner never appears "stuck"
- Runner will enter the main loop much faster after CATCHUP completes

