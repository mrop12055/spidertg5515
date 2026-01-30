
# Fix Slow Sequential Unread Message Fetching

## Problem
When accounts reconnect, the runner fetches unread messages **sequentially** (one account at a time). With many accounts, this creates a bottleneck:
- 50 accounts × ~5 seconds each = ~250 seconds (4+ minutes) of waiting

The issue is in `connect_all_from_response()` at lines 1166-1170:
```python
for aid in newly_connected:
    if aid in clients:
        await fetch_unread_messages(clients[aid], aid)  # Sequential!
```

## Solution
Change the sequential loop to use `asyncio.gather()` for parallel execution, exactly like how accounts are connected and tasks are processed.

## Technical Details

### File: `src/pages/SetupGuide.tsx` (Python runner code)

**Location:** Lines 1166-1170 inside `connect_all_from_response()`

**Before (sequential):**
```python
for aid in newly_connected:
    if aid in clients:
        await fetch_unread_messages(clients[aid], aid)
```

**After (parallel):**
```python
# Fetch unread messages in PARALLEL for all newly connected accounts
if newly_connected:
    await asyncio.gather(
        *[fetch_unread_messages(clients[aid], aid) 
          for aid in newly_connected if aid in clients],
        return_exceptions=True
    )
```

## Expected Performance

| Scenario | Before (Sequential) | After (Parallel) |
|----------|---------------------|------------------|
| 10 accounts | ~50 seconds | ~5 seconds |
| 50 accounts | ~250 seconds | ~5-10 seconds |
| 100 accounts | ~500 seconds | ~5-10 seconds |

The parallel approach limits total time to the slowest single account rather than the sum of all accounts.
