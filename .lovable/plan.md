
# Update Connection Timeout from 3 Minutes to 1 Minute

## Summary
Change all proxy connection timeouts from 180 seconds (3 minutes) to 60 seconds (1 minute) and fix the broken function call that was missed in the previous cleanup.

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/SetupGuide.tsx` | Update timeout constants, log messages, and fix broken `disconnect_and_schedule_retry` calls |
| `supabase/functions/report-task-result/index.ts` | Update timeout messages in error logging |
| `src/hooks/useRunnerStatus.ts` | Update offline threshold from 180s to 60s |

## Detailed Changes

### A) `src/pages/SetupGuide.tsx` - Python Templates

**1. Update timeout constant (line 139):**
```python
# Before
PROXY_CONNECTION_TIMEOUT = 180   # 3 minutes for slow proxy connections

# After
PROXY_CONNECTION_TIMEOUT = 60    # 1 minute for proxy connections (no quick retries)
```

**2. Update connect_with_retry() docstring (lines 422-435):**
- Change all references from "3-minute" / "180 seconds" to "1-minute" / "60 seconds"

**3. Update log message (line 669):**
```python
# Before
print(f"  [CONNECT] {account['phone_number']} (180s proxy timeout, NO RETRY on failure)...")

# After  
print(f"  [CONNECT] {account['phone_number']} (60s proxy timeout, NO RETRY on failure)...")
```

**4. Update error log (line 673):**
```python
# Before
print(f"  [CONNECTION TIMEOUT] {phone} - Proxy failed after 180s - DISABLING ACCOUNT IMMEDIATELY")

# After
print(f"  [CONNECTION TIMEOUT] {phone} - Proxy failed after 60s - DISABLING ACCOUNT IMMEDIATELY")
```

**5. Update reason message (line 682):**
```python
# Before
"reason": "Proxy connection failed after 3-minute timeout - session killed and account disabled"

# After
"reason": "Proxy connection failed after 1-minute timeout - session killed and account disabled"
```

**6. Update LiveChat runner constants (lines 2514-2516):**
```python
# Before
CLEANUP_INTERVAL = 180  # 3 minutes
CONNECT_TIMEOUT_SECONDS = 200  # 3+ minutes to allow full proxy timeout (180s) + overhead

# After
CLEANUP_INTERVAL = 60   # 1 minute - faster cleanup
CONNECT_TIMEOUT_SECONDS = 80  # 1+ minute to allow full proxy timeout (60s) + overhead
```

**7. Fix broken function calls (lines 3538-3551):**
Replace calls to non-existent `disconnect_and_schedule_retry` with `disconnect_session`:
```python
# Before
await disconnect_and_schedule_retry(acc_id, f"network: {error[:30]}")
await disconnect_and_schedule_retry(acc_id, f"failed: {error[:30]}")

# After
await disconnect_session(acc_id, f"network: {error[:30]}")
await disconnect_session(acc_id, f"failed: {error[:30]}")
```

Also update comment from "schedule 60s retry" to "immediate disable":
```python
# Before
# Connection failed - disconnect session and add to retry queue with 60s delay

# After  
# Connection failed - disconnect session immediately (no retry)
```

### B) `supabase/functions/report-task-result/index.ts`

**1. Update error messages (lines 1463, 1476, 1501):**
```typescript
// Before
"Proxy connection failed after 3-minute timeout"
"Connection timeout - proxy failed after 3 minutes"
"Proxy connection timeout after 3 minutes"

// After
"Proxy connection failed after 1-minute timeout"
"Connection timeout - proxy failed after 1 minute"
"Proxy connection timeout after 1 minute"
```

### C) `src/hooks/useRunnerStatus.ts`

**1. Update offline threshold (line 20):**
```typescript
// Before
const OFFLINE_THRESHOLD_MS = 180000; // 3 minutes

// After
const OFFLINE_THRESHOLD_MS = 60000; // 1 minute
```

## Expected Behavior After Changes

```text
Account Connection Attempt
        ↓
Wait FULL 60s for proxy connection
        ↓
If SUCCESS:
   ✓ Account connected, added to active_clients
        ↓
If FAIL after 60s:
   1. force_disconnect_session() - SESSION KILLED
   2. report_result("proxy_timeout_disable") - Account disabled + Proxy marked "error"
   3. NO RETRY - admin must fix and re-enable
```

## All Timeout Values After Update

| Setting | Before | After |
|---------|--------|-------|
| PROXY_CONNECTION_TIMEOUT | 180s | 60s |
| CONNECT_TIMEOUT_SECONDS | 200s | 80s |
| CLEANUP_INTERVAL | 180s | 60s |
| OFFLINE_THRESHOLD_MS | 180000ms | 60000ms |
