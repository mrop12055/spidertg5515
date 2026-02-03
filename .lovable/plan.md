

# Fix Runner Hang During CATCHUP Phase

## Problem

With 500+ accounts, the runner hangs during the CATCHUP phase because it attempts to run `fetch_unread_messages()` for ALL newly connected accounts in parallel simultaneously. This creates:
- Hundreds of concurrent `get_dialogs()` API calls
- Thousands of `get_messages()` calls across all accounts
- Potential Telegram flood protection triggers
- Resource exhaustion (memory, connections, file descriptors)

The runner works fine with fewer accounts because the parallel load is manageable.

## Solution

Add a semaphore to throttle the CATCHUP phase, processing only 5 accounts at a time instead of all 500+ simultaneously.

## Changes to SetupGuide.tsx (Python Runner)

### 1. Add CATCHUP Semaphore (near other semaphores)

Add a new semaphore constant for catch-up operations:

```python
CATCHUP_SEMAPHORE = asyncio.Semaphore(5)  # Process 5 accounts at a time
```

### 2. Wrap fetch_unread_messages with Semaphore

Create a throttled wrapper function:

```python
async def fetch_unread_throttled(client, acc_id: str, offline_since: Optional[str] = None):
    """Throttled wrapper for fetch_unread_messages to prevent overwhelming Telegram API."""
    async with CATCHUP_SEMAPHORE:
        await fetch_unread_messages(client, acc_id, offline_since)
```

### 3. Update connect_all_from_response to Use Throttled Version

Change line 1225-1228 from:

```python
await asyncio.gather(
    *[fetch_unread_messages(clients[aid], aid, last_offline_at) 
      for aid in newly_connected if aid in clients],
    return_exceptions=True
)
```

To:

```python
await asyncio.gather(
    *[fetch_unread_throttled(clients[aid], aid, last_offline_at) 
      for aid in newly_connected if aid in clients],
    return_exceptions=True
)
```

### 4. Add Progress Logging

Update `fetch_unread_messages` to show progress:

```python
# At start of function
print(f"  [CATCHUP] [{phone}] Starting...")
```

## Why This Works

- **Controlled concurrency**: Only 5 accounts fetch unread messages simultaneously
- **Prevents API floods**: Telegram won't see 500+ parallel API calls
- **Prevents resource exhaustion**: System resources stay under control
- **Still parallel**: 5 at a time is still fast, just not overwhelming
- **Matches existing pattern**: Runner already uses semaphores for connections and tasks

## Technical Notes

The semaphore value of 5 is chosen to match the existing `CONNECTION_SEMAPHORE` pattern in the runner, which was set to prevent Windows semaphore timeout errors. This can be tuned higher (10-15) if performance is acceptable, or lower (3) if issues persist.

