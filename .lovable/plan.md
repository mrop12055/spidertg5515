
# Fix: Remove All Retry Logic and Clean Up Disconnection Logging

## User Requirements Confirmed

1. **No retries at all** - If a connection fails (proxy, network, or health check), disable the account immediately. It will NOT be automatically retried.
2. **Clean disconnect logging** - The "No active client found, cleared tracking" message should only appear when appropriate; accounts that time out during connection should be handled cleanly.

## Current Issues Found

### Issue 1: Retry Queue Still Active
The code still contains a fully-functional retry queue system:
- **Lines 138-140**: `PROXY_RETRY_DELAY`, `PROXY_MAX_RETRIES` constants
- **Lines 194-196**: `_proxy_retry_queue` dictionary
- **Lines 317-351**: `add_to_proxy_retry_queue()` function that adds accounts to retry
- **Lines 353-376**: `get_ready_proxy_retries()` and `remove_from_proxy_retry_queue()` functions
- **Lines 379-525**: `retry_proxy_error_accounts()` function that processes retries
- **Line 3447**: `add_to_proxy_retry_queue()` called in `disconnect_and_schedule_retry()`
- **Line 3593**: `retry_proxy_error_accounts()` called every 30 seconds in `main_loop()`
- **Lines 3639**: Checks `_proxy_retry_queue` to skip accounts

All of this retry logic is now DEAD CODE per user requirements and must be removed.

### Issue 2: Health Check Adds to Retry Queue
- **Lines 3498-3502**: After a health check failure, the code calls `report_result("proxy_max_retries_exceeded")` which is meant for the retry system. This should just disable immediately without referencing retry counts.

### Issue 3: "No active client found" Message
- **Line 275**: This message appears when `force_disconnect_session()` is called but the account was never successfully added to `active_clients` (because connection timed out before completing).
- The user wants accounts that are "still trying to connect after 3 minutes" to be disconnected properly.

The real issue: When connection times out in `connect_with_retry()`, the `TelegramClient` object exists but was never added to `active_clients`. When we call `force_disconnect_session()`, it can't find the client. We need to ensure the client object created in `get_or_create_client()` is properly cleaned up even if it never made it to `active_clients`.

## Implementation Plan

### A) Remove All Retry Queue Logic from `clientManagerPy` Template

**File:** `src/pages/SetupGuide.tsx` (Python template sections)

1. **Remove retry constants** (lines 138-140):
   - Delete `PROXY_RETRY_DELAY = 180`
   - Delete `PROXY_MAX_RETRIES = 1`

2. **Remove `_proxy_retry_queue` variable** (line 196):
   - Delete `_proxy_retry_queue: Dict[str, dict] = {}`

3. **Remove `add_to_proxy_retry_queue()` function** (lines 317-351):
   - Delete entire function

4. **Remove `remove_from_proxy_retry_queue()` function** (lines 353-357):
   - Delete entire function

5. **Remove `get_ready_proxy_retries()` function** (lines 360-376):
   - Delete entire function

6. **Remove `retry_proxy_error_accounts()` function** (lines 379-525):
   - Delete entire function

7. **Update `force_disconnect_session()` to accept an optional `client` parameter** (lines 199-284):
   - Add parameter `client: Optional[TelegramClient] = None` to accept a client that never made it to `active_clients`
   - If `client` is passed in, disconnect it directly instead of looking in `active_clients`
   - Update log message to be clearer: "[FORCE DISCONNECT] {phone} - Client not in active_clients (connection never completed)"

### B) Update `get_or_create_client()` to Pass Client to Force Disconnect

**Location:** Lines 828-844 in `clientManagerPy`

When connection fails after the 180s timeout, pass the `client` object to `force_disconnect_session()` so it can be properly cleaned up:

```python
if not await connect_with_retry(client):
    # Pass the client object so it can be disconnected properly
    await force_disconnect_session(account_id, "proxy_connection_timeout", client=client)
    asyncio.create_task(report_result("proxy_timeout_disable", {...}))
    return None
```

### C) Remove Retry Logic from `livechatRunnerPy` Template

**File:** `src/pages/SetupGuide.tsx` (livechatRunnerPy section)

1. **Remove import of retry functions** (lines 2664-2665):
   - Remove: `retry_proxy_error_accounts, add_to_proxy_retry_queue, _proxy_retry_queue`
   - Keep: `force_disconnect_session, log_error, check_client_health`

2. **Remove `failed_connection_accounts` retry tracking** (lines 3360-3361):
   - Delete these variables and the `FAILED_RETRY_DELAY` constant

3. **Simplify `disconnect_and_schedule_retry()` function** (lines 3364-3450):
   - Rename to `disconnect_session()` (no retry scheduling)
   - Remove all calls to `add_to_proxy_retry_queue()`
   - Remove `failed_connection_accounts` updates
   - Just disconnect and report to backend for immediate disable

4. **Remove retry loop from `main_loop()`** (line 3591-3594):
   - Remove the `retry_proxy_error_accounts()` call

5. **Remove `_proxy_retry_queue` filter** (line 3639):
   - Remove `and acc.get("id") not in _proxy_retry_queue` check

6. **Simplify cleanup loop** (lines 3613-3621):
   - Remove `failed_connection_accounts` cleanup logic

7. **Simplify health check reporting** (lines 3493-3503):
   - Replace `proxy_max_retries_exceeded` with a simpler `health_check_disable` result type
   - No retry counts needed

### D) Add `health_check_disable` Handler to Backend

**File:** `supabase/functions/report-task-result/index.ts`

Add a new simple handler for health check failures (similar to `proxy_timeout_disable` but without retry count references):

```typescript
case "health_check_disable": {
  const { account_id, reason } = result;
  
  await supabase
    .from("telegram_accounts")
    .update({
      status: "disconnected",
      auto_disabled: true,
      disabled_reason: reason || "Health check failed - zombie connection",
      last_active: new Date().toISOString()
    })
    .eq("id", account_id);
    
  // Mark proxy as error if account has one
  const { data: account } = await supabase
    .from("telegram_accounts")
    .select("proxy_id")
    .eq("id", account_id)
    .single();
    
  if (account?.proxy_id) {
    await supabase
      .from("proxies")
      .update({ status: "error", last_checked: new Date().toISOString() })
      .eq("id", account.proxy_id);
  }
  
  console.log(`[report-task-result] Account ${account_id} DISABLED: ${reason}`);
  break;
}
```

## Expected Behavior After Fix

```text
Account Connection Attempt
        ↓
180s PROXY timeout (single attempt, enforced by await asyncio.sleep for remaining time)
        ↓
If SUCCESS:
   ✓ Account connected, added to active_clients
        ↓
If TIMEOUT/ERROR after 180s:
   → Client object disconnected directly (passed to force_disconnect_session)
   → No "No active client found" message
   → report_result("proxy_timeout_disable") - mark account INACTIVE
   → NO RETRY - immediately disabled
   → Account marked: disconnected + auto_disabled
   → Proxy marked: error status
   → proxy_id stays assigned
```

## Heartbeat Output Change

**Before:**
```
[HEARTBEAT] Iteration 9, Connected: 2, Active: 2, Proxy Retry: 5, Conn Retry: 3
```

**After:**
```
[HEARTBEAT] Iteration 9, Connected: 2, Active: 2
```

No more retry queue counts because there are no retry queues.

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/SetupGuide.tsx` | Remove ~200 lines of retry queue code from `clientManagerPy` and `livechatRunnerPy` templates |
| `supabase/functions/report-task-result/index.ts` | Add `health_check_disable` handler (~25 lines) |

## What This Achieves

1. **No retries** - Failed connections immediately disable the account
2. **Clean logs** - No confusing "No active client found" messages when client objects are properly passed to disconnect
3. **Simpler code** - Removes ~200 lines of dead retry queue logic
4. **Clear behavior** - 180s to connect, then immediate disable if failed
