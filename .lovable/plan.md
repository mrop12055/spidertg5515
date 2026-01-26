

# Plan: Fix Missing Import for check_client_health in LiveChat Runner

## Problem Identified

The error `name 'check_client_health' is not defined` occurs because:

1. **`check_client_health`** function is defined in **`client_manager.py`** (clientManagerPy template, lines 281-303)
2. **`live_chat_listener.py`** (livechatRunnerPy template) calls this function at line 3404 inside `keep_clients_alive()`
3. **BUT** - the import statement in livechatRunnerPy (lines 2579-2584) does NOT include `check_client_health`:

```python
from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client,
    retry_proxy_error_accounts, log_error,
    HTTP_TIMEOUT_UPLOAD
)
# MISSING: check_client_health
```

## Solution

Add `check_client_health` to the import statement in `livechatRunnerPy`.

### Change Required

**File**: `src/pages/SetupGuide.tsx`

**Location**: Lines 2579-2584 (the import from client_manager in livechatRunnerPy)

**Before**:
```python
from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client,
    retry_proxy_error_accounts, log_error,
    HTTP_TIMEOUT_UPLOAD
)
```

**After**:
```python
from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client,
    retry_proxy_error_accounts, log_error, check_client_health,
    HTTP_TIMEOUT_UPLOAD
)
```

Also need to add the import of `add_to_proxy_retry_queue` (also called at line 3414) which is defined in client_manager.py:

```python
from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client,
    retry_proxy_error_accounts, log_error, check_client_health, add_to_proxy_retry_queue,
    HTTP_TIMEOUT_UPLOAD
)
```

Also need to add `force_disconnect_session` to the import (called at line 3413):

```python
from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client,
    retry_proxy_error_accounts, log_error, check_client_health, add_to_proxy_retry_queue,
    force_disconnect_session,
    HTTP_TIMEOUT_UPLOAD
)
```

## Technical Details

| Missing Function | Defined In | Called At |
|-----------------|------------|-----------|
| `check_client_health` | client_manager.py line 281 | live_chat_listener.py line 3404 |
| `add_to_proxy_retry_queue` | client_manager.py line 306 | live_chat_listener.py line 3414, 3365 |
| `force_disconnect_session` | client_manager.py line 198 | live_chat_listener.py line 3413 |

## Files to Modify

1. **`src/pages/SetupGuide.tsx`**:
   - Update the import statement in livechatRunnerPy (around line 2579-2584)
   - Add: `check_client_health`, `add_to_proxy_retry_queue`, `force_disconnect_session`

## Expected Outcome

After this fix:
- The `NameError: name 'check_client_health' is not defined` error will be resolved
- The health check system will work correctly, detecting zombie connections every 60 seconds
- Failed connections will be properly routed to the 3-attempt retry queue

