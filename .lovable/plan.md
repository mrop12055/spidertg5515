

# LiveChat Runner - Proxy Failure Handling Fixes

## Issues Identified from Logs

Based on the log analysis, there are **3 bugs** in the current LiveChat runner that need fixing:

---

### Issue 1: `message_queues` is not defined

**Log Evidence:**
```
[DISCONNECTED] +918238263086: name 'message_queues' is not defined
```

**Root Cause:**
The `force_disconnect_session()` function references `message_queues` in its `global` declaration (line 205) and cleanup code (lines 273-275), but **`message_queues` is never initialized anywhere in the client_manager.py code**.

**Fix:**
Add the missing `message_queues` initialization at the top of the client_manager.py section (near line 135):

```python
message_queues: Dict[str, asyncio.Queue] = {}  # Per-account outgoing message queues
```

---

### Issue 2: Retry Accounts Reconnect Sequentially (One-by-One)

**Log Evidence:**
```
[CONNECT] Connecting 1 accounts in PARALLEL...
[2651] STEP 1: Proxy validated...
```

Instead of connecting in parallel batches, accounts reconnect one at a time when picked up by the retry queue.

**Root Cause:**
The `retry_proxy_error_accounts()` function (lines 367-513) processes accounts sequentially in a `for acc_id in ready_ids:` loop. Unlike the main connection loop which uses `asyncio.gather()`, retries happen one by one.

**Fix:**
Modify `retry_proxy_error_accounts()` to process ready accounts in **parallel batches of up to 100** (as per your preference):

```python
async def retry_proxy_error_accounts():
    """
    Process accounts in the proxy retry queue that are ready for retry.
    FIX: Now processes up to 100 accounts in PARALLEL BATCHES instead of sequentially.
    """
    global _proxy_retry_queue
    
    # Get accounts ready for retry
    ready_ids = get_ready_proxy_retries()
    
    if not ready_ids:
        return 0
    
    # Limit batch size to 100 per cycle
    BATCH_SIZE = 100
    batch = ready_ids[:BATCH_SIZE]
    
    print(f"\\n  [PROXY RETRY] {len(batch)} accounts ready for PARALLEL retry...")
    
    http = get_http_client()
    from datetime import datetime
    
    async def retry_one(acc_id):
        # ... existing retry logic for single account ...
        # (move current for-loop body here as async function)
        pass
    
    # Process ALL ready accounts in PARALLEL
    results = await asyncio.gather(
        *[retry_one(acc_id) for acc_id in batch],
        return_exceptions=True
    )
    
    reconnected = sum(1 for r in results if r is True)
    
    if reconnected > 0:
        print(f"  [PROXY RETRY] Reconnected {reconnected}/{len(batch)} accounts (parallel)")
    
    return reconnected
```

---

### Issue 3: Failed Accounts Added to Both Queues (Duplicate Retries)

**Log Evidence (combined):**
The logs show accounts sometimes being added to `failed_connection_accounts` AND `_proxy_retry_queue`, causing confusion.

**Root Cause:**
Multiple code paths add failed accounts to different retry tracking structures:
- `disconnect_and_schedule_retry()` (line 3433) adds to `failed_connection_accounts`
- `add_to_proxy_retry_queue()` (line 305) adds to `_proxy_retry_queue`

When an account fails, it might get added to one or both, and the normal connect loop (line 3640-3644) only checks `failed_connection_accounts`, not `_proxy_retry_queue`.

**Fix:**
Ensure failed accounts are excluded from the normal connect loop if they're in the proxy retry queue:

```python
# Lines 3640-3644: Filter out accounts in proxy retry queue
new_accounts = [
    acc for acc in accounts 
    if acc.get("id") not in connected_ids 
    and acc.get("id") not in failed_connection_accounts
    and acc.get("id") not in _proxy_retry_queue  # ADD THIS CHECK
]
```

Also add import of `_proxy_retry_queue` to the livechat runner imports (around line 2643):
```python
from client_manager import (
    # ... existing imports ...
    _proxy_retry_queue  # ADD THIS
)
```

---

## Summary of Changes

| File | Location | Change |
|------|----------|--------|
| `src/pages/SetupGuide.tsx` | Line ~135 | Add `message_queues: Dict[str, asyncio.Queue] = {}` initialization |
| `src/pages/SetupGuide.tsx` | Lines 367-513 | Refactor `retry_proxy_error_accounts()` to use `asyncio.gather()` for parallel retry (batch size 100) |
| `src/pages/SetupGuide.tsx` | Lines 3640-3644 | Add `_proxy_retry_queue` check to exclude retry-queue accounts from normal connect loop |
| `src/pages/SetupGuide.tsx` | Line ~2643 | Add `_proxy_retry_queue` to imports |

---

## Technical Details

### Before (Sequential Retry):
```text
Account A ready → retry → wait → success
Account B ready → retry → wait → fail
Account C ready → retry → wait → success
...
Total time: N * (connection_time)
```

### After (Parallel Retry up to 100):
```text
Account A ready ─┐
Account B ready ─┼─→ asyncio.gather() → All retry simultaneously
Account C ready ─┤
...              ─┘
Total time: max(connection_time) for the batch
```

### Retry-Queue Isolation (Your Preference):
Failed accounts will ONLY be retried via the 60-second retry queue, never picked up by the normal "connect new accounts" loop. This prevents:
- Early retries before 60 seconds
- Double connection attempts
- Race conditions between retry paths

---

## Required Action After Implementation

**Restart the LiveChat runner on VPS** to load these fixes. The changes ensure:
1. No `message_queues not defined` errors
2. Failed accounts reconnect in parallel (up to 100 at once)
3. Failed accounts only retry via the 60-second queue (no duplicates)

