# ✅ COMPLETED: Connection Timeout Update (3 min → 1 min)

## Summary
Updated all proxy connection timeouts from 180 seconds (3 minutes) to 60 seconds (1 minute) and fixed the broken `disconnect_and_schedule_retry` function calls.

## Changes Made

### A) `src/pages/SetupGuide.tsx` - Python Templates ✅

| Line | Change |
|------|--------|
| 139 | `PROXY_CONNECTION_TIMEOUT = 60` (was 180) |
| 422-430 | Updated docstring to reference 1-minute/60s |
| 669 | Log message: `60s proxy timeout` (was 180s) |
| 671-683 | Error messages: `60s` and `1-minute timeout` |
| 2514-2516 | `CLEANUP_INTERVAL = 60`, `CONNECT_TIMEOUT_SECONDS = 80` |
| 3538-3551 | **FIX**: Replaced `disconnect_and_schedule_retry` → `disconnect_session` |

### B) `supabase/functions/report-task-result/index.ts` ✅

| Line | Change |
|------|--------|
| 1463 | `after 1-minute timeout` (was 3-minute) |
| 1476 | `proxy failed after 1 minute` (was 3 minutes) |
| 1501 | `timeout after 1 minute` (was 3 minutes) |

### C) `src/hooks/useRunnerStatus.ts` ✅

| Line | Change |
|------|--------|
| 20 | `OFFLINE_THRESHOLD_MS = 60000` (was 180000) |

## Final Timeout Values

| Setting | Before | After |
|---------|--------|-------|
| PROXY_CONNECTION_TIMEOUT | 180s | 60s |
| CONNECT_TIMEOUT_SECONDS | 200s | 80s |
| CLEANUP_INTERVAL | 180s | 60s |
| OFFLINE_THRESHOLD_MS | 180000ms | 60000ms |

## Safety Flow (Unchanged)

```
Account Connection Attempt
        ↓
Wait FULL 60s for proxy connection
        ↓
If FAIL after 60s:
   1. force_disconnect_session() - SESSION KILLED FIRST
   2. report_result("proxy_timeout_disable") - THEN proxy marked "error"
   3. NO RETRY - admin must fix and re-enable
```

**Key Safety**: Proxy is NEVER marked as "error" while session is still active. Session is always terminated first.
