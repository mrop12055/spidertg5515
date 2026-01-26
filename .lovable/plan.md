# Implemented: Immediate Session Disconnect on Proxy Failure with 3-Minute Retry

## Summary

Implemented the proxy failure retry logic with immediate session disconnect:

1. **Immediate Disconnect** - `force_disconnect_session()` function added that:
   - Calls `client.disconnect()` immediately
   - Removes from `active_clients` dictionary
   - Clears message queue tracking

2. **3-Minute Retry Queue** - `_proxy_retry_queue` tracks:
   - Attempt count per account
   - Next retry timestamp (now + 180 seconds)
   - Account and proxy data for retry

3. **Max 3 Attempts** - After 3 failures:
   - Reports `proxy_max_retries_exceeded` to backend
   - Backend marks account as `disconnected` with `auto_disabled: true`
   - Requires admin fix in dashboard

## Files Modified

- `src/pages/SetupGuide.tsx` - Python runner with new retry logic
- `supabase/functions/report-task-result/index.ts` - Backend handler for max retries

## Timeline Example

| Time | Event | Action |
|------|-------|--------|
| 0:00 | Proxy fails | IMMEDIATELY disconnect, schedule retry for 3:00 |
| 3:00 | Retry #1 | Attempt connection, fails, IMMEDIATELY disconnect |
| 6:00 | Retry #2 | Attempt connection, fails, IMMEDIATELY disconnect |
| 9:00 | Retry #3 | Attempt connection, fails, mark DISCONNECTED |
