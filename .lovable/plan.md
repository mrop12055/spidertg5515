

# Complete Audit: SetupGuide.tsx - Outdated Comments and Issues Found

## Summary

After a comprehensive search through all Python code in `SetupGuide.tsx`, I found **6 outdated comments** that still reference "3 minutes" or "3-minute" delays, but the actual code uses 60 seconds (1 minute). All functional code is correct - these are **documentation-only fixes**.

## Issues Found

### Issue 1: Line 350 - Comment says "3 min passed"
```python
# CURRENT (WRONG):
def get_ready_proxy_retries() -> list:
    """Get list of account IDs ready for proxy retry (3 min passed)."""

# FIXED:
def get_ready_proxy_retries() -> list:
    """Get list of account IDs ready for proxy retry (1 min passed)."""
```

### Issue 2: Line 361 - Comment says "3 minutes"
```python
# CURRENT (WRONG):
        # Check if enough time has passed (3 minutes)
        if now >= info.get("next_retry_at", 0):

# FIXED:
        # Check if enough time has passed (1 minute = PROXY_RETRY_DELAY)
        if now >= info.get("next_retry_at", 0):
```

### Issue 3: Lines 369-371 - Docstring says "3 min passed" and "3-minute delays"
```python
# CURRENT (WRONG):
async def retry_proxy_error_accounts():
    """
    Process accounts in the proxy retry queue that are ready for retry (3 min passed).
    Uses the in-memory _proxy_retry_queue for tracking with 3-minute delays.
    """

# FIXED:
async def retry_proxy_error_accounts():
    """
    Process accounts in the proxy retry queue that are ready for retry (1 min passed).
    Uses the in-memory _proxy_retry_queue for tracking with 1-minute delays.
    """
```

### Issue 4: Line 2644 - CLEANUP_INTERVAL = 180 (3 minutes)
This is a **functional constant** for cleanup interval (not retry delay), so it's intentionally 3 minutes. **No change needed** - cleanup every 3 minutes is fine.

### Issue 5: Line 3414 - Comment says "3-minute delay"
```python
# CURRENT (WRONG):
    if is_proxy_error:
        # Use proxy retry queue with 3-attempt limit and 3-minute delay
        print(f"  [PROXY RETRY] {phone} - Adding to 3-attempt retry queue")

# FIXED:
    if is_proxy_error:
        # Use proxy retry queue with 3-attempt limit and 1-minute delay
        print(f"  [PROXY RETRY] {phone} - Adding to 3-attempt retry queue")
```

### Issue 6: Line 3574 - Comment says "180s/3min"
```python
# CURRENT (WRONG):
                # Allow failed accounts to retry after their cooldown expires (180s/3min from failure)
                now = time.time()

# FIXED:
                # Allow failed accounts to retry after their cooldown expires (60s/1min from failure)
                now = time.time()
```

## Verification of Correct Implementation

| Category | Status | Value | Location |
|----------|--------|-------|----------|
| `PROXY_RETRY_DELAY` | ✅ Correct | 60 seconds | Line 138 |
| `FAILED_RETRY_DELAY` | ✅ Correct | 60 seconds | Line 3330 |
| `connection_retries` | ✅ Correct | 0 | Line 772 |
| `auto_reconnect` | ✅ Correct | False | Line 774 |
| `request_retries` | ✅ Correct | 1 | Line 775 |
| Campaign Runner single-attempt | ✅ Correct | Yes | Lines 2143-2176 |
| LiveChat Runner single-attempt | ✅ Correct | Yes | Lines 3790-3821 |
| Instant disconnect on proxy fail | ✅ Correct | Yes | Line 806 |
| Health check interval | ✅ Correct | 60s | Line 3438 |
| `CLEANUP_INTERVAL` | ✅ Intentional | 180s (3 min) | Line 2644 |

## Session Disconnection and Reconnection Flow

The current implementation correctly:

1. **Disconnects instantly** when proxy fails (via `force_disconnect_session`)
2. **Adds to retry queue** with 60-second delay (via `add_to_proxy_retry_queue`)
3. **Checks retry queue every 30 seconds** (line 3554) for expired accounts
4. **Reconnects after 1 minute** when `now >= next_retry_at`
5. **Marks inactive after 3 failed attempts**

## Changes to Make

| Line | Current Text | Fixed Text |
|------|--------------|------------|
| 350 | `(3 min passed)` | `(1 min passed)` |
| 361 | `(3 minutes)` | `(1 minute = PROXY_RETRY_DELAY)` |
| 370 | `(3 min passed)` | `(1 min passed)` |
| 371 | `3-minute delays` | `1-minute delays` |
| 3414 | `3-minute delay` | `1-minute delay` |
| 3574 | `(180s/3min from failure)` | `(60s/1min from failure)` |

## Impact Assessment

- **Functional Impact**: None - all code uses correct 60-second values
- **Documentation Impact**: Yes - developers reading code might be confused
- **Risk Level**: Low - cosmetic changes only

