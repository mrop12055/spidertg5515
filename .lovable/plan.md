
# Plan: Immediate Session Disconnect on Proxy Failure with 3-Minute Retry

## Problem Summary

When a proxy connection fails, the session must be **immediately terminated** (disconnected and cleared from memory) before scheduling any retry. The current implementation may leave sessions in a partial state.

## Key Requirement

**IMMEDIATE DISCONNECT** means:
1. Call `client.disconnect()` right away
2. Remove from `active_clients` dictionary
3. Clear any session state
4. THEN schedule retry after 3 minutes

## Implementation Details

### Step 1: Create Force Disconnect Function

Add a dedicated function that forcefully terminates a session immediately:

```python
async def force_disconnect_session(account_id: str, reason: str = "proxy_error"):
    """
    IMMEDIATELY disconnect and clear session from memory.
    Called the moment a proxy failure is detected.
    """
    phone = account_id[:8]
    
    # Step 1: Remove from active clients FIRST
    client = active_clients.pop(account_id, None)
    
    # Step 2: Force disconnect if client exists
    if client:
        try:
            if client.is_connected():
                await asyncio.wait_for(client.disconnect(), timeout=3)
            await asyncio.sleep(0.1)  # Let pending tasks finalize
            print(f"  [FORCE DISCONNECT] {phone} - Session terminated: {reason}")
        except Exception as e:
            print(f"  [FORCE DISCONNECT] {phone} - Force cleared (error: {e})")
    
    # Step 3: Clear from any other tracking
    if account_id in message_queues:
        del message_queues[account_id]
    
    return True
```

### Step 2: Update Proxy Error Handler in connect_with_retry

When proxy connection fails inside `connect_with_retry()`:

```python
except Exception as e:
    error_str = str(e).lower()
    
    if "proxy" in error_str or "connection" in error_str:
        # IMMEDIATE DISCONNECT - Do this FIRST
        await force_disconnect_session(account_id, "proxy_connection_failed")
        
        # Report error to backend
        await report_result("proxy_error", {
            "account_id": account_id,
            "error": str(e)
        })
        
        # Schedule retry after 3 minutes
        await add_to_proxy_retry_queue(account_id, account_data, proxy_data)
        
        return None  # Return immediately, session is gone
```

### Step 3: Update Main Loop Connection Handling

In the main loop where initial connections are attempted:

```python
# When connection fails due to proxy
if not client:
    if "proxy" in last_error.lower():
        # Session already disconnected by connect_with_retry
        # Just log and continue - retry will happen automatically
        print(f"  [MAIN] {phone} - Proxy failed, will retry in 3 minutes")
        continue
```

### Step 4: Update Retry Queue Tracking

```python
# Retry tracking with 3-minute delay
_proxy_retry_queue: Dict[str, dict] = {}
# Format: {account_id: {"count": int, "next_retry_at": timestamp}}

async def add_to_proxy_retry_queue(account_id: str, account_data: dict, proxy_data: dict = None):
    """Schedule retry after IMMEDIATE disconnect."""
    global _proxy_retry_queue
    
    now = time.time()
    
    if account_id not in _proxy_retry_queue:
        _proxy_retry_queue[account_id] = {"count": 0, "next_retry_at": 0}
    
    _proxy_retry_queue[account_id]["count"] += 1
    _proxy_retry_queue[account_id]["next_retry_at"] = now + 180  # 3 minutes from now
    
    retry_count = _proxy_retry_queue[account_id]["count"]
    
    if retry_count >= 3:
        # Max retries exceeded - mark inactive
        print(f"  [PROXY MAX] {account_id[:8]} - 3 attempts failed, marking INACTIVE")
        await report_result("proxy_max_retries_exceeded", {
            "account_id": account_id,
            "reason": "Proxy failed after 3 attempts",
            "retry_count": retry_count
        })
        del _proxy_retry_queue[account_id]  # Remove from retry queue
    else:
        remaining = 3 - retry_count
        print(f"  [PROXY RETRY] {account_id[:8]} - Attempt {retry_count}/3, retry in 3 min ({remaining} left)")
```

### Step 5: Background Retry Check

```python
async def check_proxy_retries():
    """Check if any accounts are ready for proxy retry (3 min passed)."""
    global _proxy_retry_queue
    
    now = time.time()
    ready = []
    
    for acc_id, info in list(_proxy_retry_queue.items()):
        if info["count"] >= 3:
            continue  # Already exceeded, waiting for backend to mark inactive
        
        if now >= info["next_retry_at"]:
            ready.append(acc_id)
    
    return ready
```

### Step 6: Backend Handler for Max Retries

Add to `report-task-result` edge function:

```typescript
case "proxy_max_retries_exceeded": {
  const { account_id, reason, retry_count } = result;
  
  await supabase
    .from("telegram_accounts")
    .update({
      status: "disconnected",
      disabled_reason: `Proxy error: Failed ${retry_count}x (requires admin fix)`,
      auto_disabled: true
    })
    .eq("id", account_id);
  
  break;
}
```

## Flow Diagram

```text
Proxy Connection Fails
         │
         ▼
┌────────────────────────┐
│ IMMEDIATELY DISCONNECT │  ◄── This happens FIRST
│ - client.disconnect()  │
│ - Remove from active   │
│ - Clear message queue  │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ Increment retry count  │
│ Schedule retry: now+3m │
└───────────┬────────────┘
            │
            ▼
     ┌──────────────┐
     │ Count >= 3 ? │
     └──────┬───────┘
            │
      ┌─────┴─────┐
      │           │
     Yes          No
      │           │
      ▼           ▼
┌───────────┐  ┌─────────────┐
│ Mark      │  │ Wait 3 min  │
│ INACTIVE  │  │ Then retry  │
│ auto_dis  │  │ connection  │
└───────────┘  └──────┬──────┘
                      │
                      ▼
               [Retry Loop]
```

## Timeline Example

| Time | Event | Action |
|------|-------|--------|
| 0:00 | Proxy fails | IMMEDIATELY disconnect, schedule retry for 3:00 |
| 3:00 | Retry #1 | Attempt connection, fails, IMMEDIATELY disconnect |
| 3:00 | Schedule | Retry scheduled for 6:00 |
| 6:00 | Retry #2 | Attempt connection, fails, IMMEDIATELY disconnect |
| 6:00 | Schedule | Retry scheduled for 9:00 |
| 9:00 | Retry #3 | Attempt connection, fails, IMMEDIATELY disconnect |
| 9:00 | Max reached | Mark account as DISCONNECTED + auto_disabled |

## Files to Modify

1. **`src/pages/SetupGuide.tsx`** - Python runner:
   - Add `force_disconnect_session()` function
   - Update `connect_with_retry()` to call immediate disconnect on proxy error
   - Add `_proxy_retry_queue` tracking dictionary
   - Update `add_to_proxy_retry_queue()` with 3-minute delay
   - Add `check_proxy_retries()` function
   - Update main loop to use new retry system

2. **`supabase/functions/report-task-result/index.ts`**:
   - Add `proxy_max_retries_exceeded` case handler
