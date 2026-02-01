

# Fix Message Listening Stopping After Some Time

## Problem Analysis

The Python runner's message listening stops working after some time due to **silent connection drops**. Here's why:

1. **Auto-reconnect is disabled** (`auto_reconnect=False`) to prevent unproxied connections
2. **No keepalive mechanism** - connections can idle out without detection
3. **`is_connected()` is unreliable** - it checks socket state, not actual Telegram connectivity
4. **60-second refresh is too slow** - by the time it detects a dead connection, messages are lost

When a proxy times out or the network blips, Telethon doesn't know the connection is dead until it tries to send/receive. Since the runner only polls for tasks (not actively pinging Telegram), stale connections go undetected.

## Solution

Implement a **proactive health check** that periodically pings Telegram to verify connections are alive, and reconnects any that have silently died.

### Technical Changes

**File:** `src/pages/SetupGuide.tsx` (Python runner code)

#### 1. Add a `ping_account()` function
This function will call `client.get_me()` with a short timeout to verify the connection is truly alive:

```python
async def ping_account(aid: str) -> bool:
    """Ping Telegram to verify connection is alive."""
    client = clients.get(aid)
    if not client:
        return False
    try:
        # Quick ping - if this fails, connection is dead
        await asyncio.wait_for(client.get_me(), timeout=10)
        return True
    except:
        return False
```

#### 2. Add a `health_check()` function
This will run periodically to find and fix dead connections:

```python
async def health_check():
    """Check all connections and reconnect dead ones."""
    dead = []
    for aid in list(clients.keys()):
        if not await ping_account(aid):
            dead.append(aid)
            # Remove dead client
            try:
                await clients[aid].disconnect()
            except:
                pass
            del clients[aid]
    
    if dead:
        print(f"  [HEALTH] {len(dead)} dead connections detected")
    
    return dead
```

#### 3. Run health check every 5 minutes in main loop
Update the main loop to run the health check periodically (not too often to avoid rate limits):

```python
last_health_check = time.time()

while RUNNING:
    # ... existing code ...
    
    # Health check every 5 minutes (300 seconds)
    if time.time() - last_health_check > 300:
        dead_accounts = await health_check()
        if dead_accounts:
            # Reconnect dead accounts
            accs_to_reconnect = [accounts[aid] for aid in dead_accounts if aid in accounts]
            if accs_to_reconnect:
                _, newly_connected = await connect_all_from_response([...batch_accounts...])
                if newly_connected:
                    await setup_handlers()
        last_health_check = time.time()
    
    # ... rest of loop ...
```

#### 4. Reduce reconnect interval from 60s to 30s
The current 60-second refresh is too slow. Reduce it to 30 seconds for faster recovery:

```python
# Change from:
if time.time() - last_refresh > 60 or len(clients) < len(batch_accounts):
# To:
if time.time() - last_refresh > 30 or len(clients) < len(batch_accounts):
```

#### 5. Add connection state tracking
Track when each client was last verified to avoid repeated pings:

```python
client_last_ping: Dict[str, float] = {}

# In health_check, only ping clients not verified recently
for aid in list(clients.keys()):
    if time.time() - client_last_ping.get(aid, 0) < 60:
        continue  # Skip if pinged within last minute
    # ... ping logic ...
    client_last_ping[aid] = time.time()
```

---

## Summary of Changes

| Location | Change |
|----------|--------|
| Line ~60 (STATE section) | Add `client_last_ping: Dict[str, float] = {}` |
| After line ~917 | Add `ping_account()` function |
| After `ping_account()` | Add `health_check()` function |
| Line ~1421 (main loop) | Add `last_health_check = time.time()` |
| Line ~1432 | Change 60s refresh to 30s: `if time.time() - last_refresh > 30` |
| After line ~1437 | Add health check block (every 300 seconds) |

---

## Why This Fixes the Problem

1. **Proactive detection**: Instead of waiting for the next send to fail, we actively verify connections are alive
2. **Faster recovery**: 30-second refresh + 5-minute health check catches dead connections before too many messages are lost
3. **Automatic reconnection**: Dead connections are automatically re-established and handlers re-attached
4. **Catch-up on reconnect**: When a client reconnects, `fetch_unread_messages()` already runs to catch missed messages

---

## Alternative Considerations

- **Enable `auto_reconnect=True`?** - No, this would risk unproxied connections if the proxy dies
- **More frequent pings?** - 5 minutes is a balance; too frequent could trigger rate limits
- **Use `asyncio.create_task()` for background pings?** - Could work but adds complexity; periodic check is simpler

---

## Testing

After implementing:
1. Start the runner and verify connections establish
2. Wait 5-10 minutes and check logs for `[HEALTH]` messages
3. Kill a proxy temporarily and verify the runner detects and reconnects
4. Send a test message during/after reconnection to verify handlers work

