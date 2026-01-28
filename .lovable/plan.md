

# Fix: Update Misleading Comment on Line 836

## Issue Found

During the comprehensive audit, I found one remaining cosmetic issue that was not addressed in the previous changes:

**Line 836**: The comment still says `# Add to retry queue with 3-min delay` but the actual code uses `PROXY_RETRY_DELAY = 60` (1 minute).

## Current Code (Line 836)

```python
                # Add to retry queue with 3-min delay
                await add_to_proxy_retry_queue(account_id, account, task_proxy)
```

## Fixed Code

```python
                # Add to retry queue with 1-min delay (PROXY_RETRY_DELAY)
                await add_to_proxy_retry_queue(account_id, account, task_proxy)
```

## Impact

- **Functional Impact**: None - this is documentation only
- **Developer Confusion**: Yes - developers reading this code might think the delay is 3 minutes when it's actually 1 minute

## Summary of Complete Audit

After reviewing all ~5000+ lines of Python runner code in `SetupGuide.tsx`, I confirm:

| Category | Status | Details |
|----------|--------|---------|
| Telethon Client Settings | ✅ Verified | `connection_retries=0`, `auto_reconnect=False`, `request_retries=1` |
| Retry Delays | ✅ Verified | Both `PROXY_RETRY_DELAY` and `FAILED_RETRY_DELAY` = 60s |
| Campaign Runner | ✅ Verified | Single attempt with SQLite-only retry |
| LiveChat Runner | ✅ Verified | Single attempt with SQLite-only retry |
| Health Check System | ✅ Verified | Routes dead connections to proxy retry queue |
| force_disconnect_session | ✅ Verified | Properly cancels all internal Telethon tasks |
| Documentation | ⚠️ One Fix | Line 836 comment needs update |

### Connection Flow (Verified Working)

```text
CONNECTION ATTEMPT:
  ├─ TelegramClient created with:
  │   ├─ connection_retries=0 (NO internal retry)
  │   └─ auto_reconnect=False (NO background reconnect)
  │
  ├─ connect_single_attempt() called (20s timeout)
  │   ├─ SUCCESS → Continue with account
  │   └─ FAIL → INSTANT DISCONNECT
  │            ├─ client.disconnect() (cleanup)
  │            ├─ force_disconnect_session() (remove from tracking)
  │            └─ add_to_proxy_retry_queue() (60s delay)
  │
  └─ NO RISK of Telethon retrying without proxy

AFTER 60 SECONDS:
  └─ Retry queue checks expired accounts
      └─ Fresh connection attempt with proxy
          ├─ SUCCESS → Account online
          └─ FAIL → Retry count +1 (max 3 attempts)
              └─ After 3 fails → Mark account INACTIVE
```

## Technical Summary

All critical safety mechanisms are correctly implemented:

1. **No internal Telethon retries** - `connection_retries=0` prevents Telethon from retrying connections internally
2. **No auto-reconnect** - `auto_reconnect=False` prevents background reconnection that could bypass proxy
3. **Instant disconnect on failure** - `force_disconnect_session()` immediately cleans up session on any proxy error
4. **1-minute retry delay** - Failed accounts wait 60 seconds before retry attempt
5. **3-attempt limit** - After 3 failed attempts, accounts are marked inactive
6. **SQLite-only local retry** - Only local file lock errors are retried, not network errors

