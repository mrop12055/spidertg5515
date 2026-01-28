

# LiveChat Runner - Simplified Proxy Retry System

## Build Version: 2026-01-28-no-queue-parallel-retry

---

## Current Implementation Analysis

The current system uses a **queue-based approach** (`_proxy_retry_queue` dictionary):
- When proxy fails → Add to queue with timestamp
- Background loop checks every 5s → Processes ready accounts (1 min passed)
- Queue stores: count, next_retry_at, account_data, proxy_data

**Issues with current approach:**
1. Queue adds complexity and state management overhead
2. Potential for accounts to be picked up by multiple code paths
3. State can get out of sync between queue and main loop

---

## Proposed Simplification

Replace the queue-based retry with a **simpler in-memory tracking + direct parallel retry**:

1. **No queue** - Just track failed accounts with timestamps
2. **Parallel batch processing** - Retry all ready accounts in parallel (up to 50 at once)
3. **1-minute delay** - Simple timestamp check, no scheduling logic
4. **Instant kill** - Session killed immediately on failure, NO internet access allowed

---

## Technical Changes

### File: `src/pages/SetupGuide.tsx`

### Change 1: Simplify Tracking Structure (Lines 194-200)

**Current:**
```python
_proxy_retry_queue: Dict[str, dict] = {}  # Complex queue with scheduling
```

**New:**
```python
# Simple tracking: {account_id: {"failed_at": float, "attempts": int, "account_data": dict, "proxy_data": dict}}
_failed_accounts: Dict[str, dict] = {}
```

### Change 2: Simplify add_to_retry Function (Lines 331-365)

**New Logic:**
```python
async def mark_account_failed(account_id: str, account_data: dict, proxy_data: dict = None):
    """
    Mark account as failed - NO QUEUE, just track for 1-minute delayed retry.
    Session is ALREADY killed before this is called (instant kill policy).
    """
    global _failed_accounts
    
    now = time.time()
    phone = account_id[:8]
    
    # Initialize or increment attempts
    if account_id not in _failed_accounts:
        _failed_accounts[account_id] = {"failed_at": now, "attempts": 1, "account_data": account_data, "proxy_data": proxy_data}
        print(f"  [FAILED] {phone} - Marked for retry in 1 min (attempt 1/{PROXY_MAX_RETRIES})")
    else:
        _failed_accounts[account_id]["attempts"] += 1
        _failed_accounts[account_id]["failed_at"] = now
        _failed_accounts[account_id]["account_data"] = account_data
        _failed_accounts[account_id]["proxy_data"] = proxy_data
        attempts = _failed_accounts[account_id]["attempts"]
        
        if attempts >= PROXY_MAX_RETRIES:
            # Max retries exceeded - report and remove
            print(f"  [MAX FAILED] {phone} - {PROXY_MAX_RETRIES} attempts, marking INACTIVE")
            await report_result("proxy_max_retries_exceeded", {
                "account_id": account_id,
                "reason": f"Proxy failed after {PROXY_MAX_RETRIES} attempts",
                "retry_count": attempts
            })
            del _failed_accounts[account_id]
        else:
            print(f"  [FAILED] {phone} - Retry in 1 min (attempt {attempts}/{PROXY_MAX_RETRIES})")
```

### Change 3: Parallel Batch Retry (Lines 393-615)

**New Logic:**
```python
async def retry_failed_accounts_parallel(connected_ids_ref: set = None):
    """
    Retry all failed accounts that have waited 1 minute - in PARALLEL batches.
    NO QUEUE - just check timestamps and process in batches.
    """
    global _failed_accounts, _currently_connecting
    
    now = time.time()
    RETRY_DELAY = 60  # 1 minute
    BATCH_SIZE = 50   # Process 50 at a time in parallel
    
    # Find accounts ready for retry (1 min passed)
    ready_ids = [
        acc_id for acc_id, info in _failed_accounts.items()
        if now - info.get("failed_at", 0) >= RETRY_DELAY
        and info.get("attempts", 0) < PROXY_MAX_RETRIES
    ]
    
    if not ready_ids:
        return 0
    
    # Process in batches
    batches = [ready_ids[i:i+BATCH_SIZE] for i in range(0, len(ready_ids), BATCH_SIZE)]
    total_reconnected = 0
    
    for batch_idx, batch in enumerate(batches):
        print(f"\n  [RETRY BATCH {batch_idx+1}/{len(batches)}] {len(batch)} accounts in PARALLEL...")
        
        async def retry_one(acc_id: str) -> bool:
            # Check locks
            if acc_id in _currently_connecting or acc_id in active_clients:
                return False
            
            info = _failed_accounts.get(acc_id, {})
            account_data = info.get("account_data", {})
            proxy_data = info.get("proxy_data")
            
            _currently_connecting.add(acc_id)
            try:
                # Clean session file first
                # ... (session cleanup code)
                
                # Fetch fresh data if needed
                # ... (API/proxy data fetching)
                
                # Attempt connection
                client = await get_or_create_client(account_data, task_proxy=proxy_data, ...)
                
                if client:
                    # SUCCESS - remove from failed tracking
                    del _failed_accounts[acc_id]
                    if connected_ids_ref:
                        connected_ids_ref.add(acc_id)
                    return True
                else:
                    # FAILED - force_disconnect already called inside get_or_create_client
                    # mark_account_failed also called inside - just return
                    return False
            finally:
                _currently_connecting.discard(acc_id)
        
        # Execute batch in parallel
        results = await asyncio.gather(*[retry_one(acc_id) for acc_id in batch], return_exceptions=True)
        batch_reconnected = sum(1 for r in results if r is True)
        total_reconnected += batch_reconnected
        
        print(f"  [RETRY BATCH {batch_idx+1}] Reconnected {batch_reconnected}/{len(batch)}")
    
    return total_reconnected
```

### Change 4: Update Main Loop Filter (Lines 3660-3670)

Ensure failed accounts are excluded from normal connection loop:
```python
new_accounts = [
    acc for acc in accounts 
    if acc.get("id") not in connected_ids 
    and acc.get("id") not in _failed_accounts  # Changed from _proxy_retry_queue
    and acc.get("id") not in _currently_connecting
]
```

---

## Flow After Changes

```text
Connection Attempt:
    1. Delete old session file (pre-cleanup)
    2. Decode fresh session
    3. Create TelegramClient with proxy
    4. Single connection attempt (no internal retry)
    
If proxy fails:
    1. INSTANT: Kill session via force_disconnect_session()
    2. Mark in _failed_accounts with timestamp
    3. Increment attempts count
    
Every ~5 seconds in main loop:
    1. Check _failed_accounts for entries where (now - failed_at) >= 60s
    2. Collect all ready accounts
    3. Process in PARALLEL BATCHES of 50
    4. On success: Remove from _failed_accounts, add to connected_ids
    5. On failure: mark_account_failed() increments count, resets timestamp
    
After 3 failures:
    1. Report to backend: mark account INACTIVE
    2. Remove from _failed_accounts
    3. Admin must fix proxy and set account to Active
```

---

## Key Improvements

| Before | After |
|--------|-------|
| Queue with scheduling | Simple timestamp tracking |
| Sequential processing | Parallel batches (50 at once) |
| Complex state management | Minimal state (just timestamp + count) |
| Race conditions possible | `_currently_connecting` lock prevents doubles |

---

## Safety Guarantees (Unchanged)

1. **Instant Kill**: `force_disconnect_session()` called FIRST on any error
2. **No Internet Without Proxy**: `connection_retries=0`, `auto_reconnect=False`
3. **Session Cleanup**: Session file deleted before retry
4. **Lock Protection**: `_currently_connecting` prevents double connections

