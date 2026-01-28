

# Plan: Disable Session Check Reporting for LiveChat Runner

## Current Situation Analysis

The `report_session_check` function makes HTTP calls to the `report-session-check` edge function to update account status in the database. This is currently called in multiple scenarios:

### Where Session Checks Are Called (in `connect_account_with_fingerprint`):

| Scenario | Line | Currently Called? |
|----------|------|-------------------|
| **SUCCESS** - After `get_me()` succeeds | Lines 857-863 | ✅ Only when `skip_session_check=False` |
| **BANNED** - Account deleted (get_me returns None) | Line 853 | ❌ Always called |
| **EXPIRED** - AuthKeyUnregisteredError | Line 867 | ❌ Always called |
| **EXPIRED** - SessionRevokedError | Line 871 | ❌ Always called |
| **BANNED** - UserDeactivatedBanError | Line 875 | ❌ Always called |
| **BANNED** - PhoneNumberBannedError | Line 879 | ❌ Always called |
| **BANNED** - InputUserDeactivatedError | Line 883 | ❌ Always called |
| **OTHER** - Any other get_me() exception | Line 889 | ❌ Always called |
| **AUTH ERRORS** (outer catch) | Lines 912-929 | ❌ Always called |

### Key Finding
The `skip_session_check=True` flag only skips the **SUCCESS** reporting. All **ERROR** cases still call `report_session_check`, causing unnecessary backend calls like `[SESSION CHECK EXC]` errors you're seeing.

---

## Proposed Solution

Modify the LiveChat runner to **completely skip all session check reporting** since:
1. LiveChat runner already handles account status via `report_result()` for proxy errors
2. Session validity is already verified by the connection process itself
3. Error logging already goes to `vps_logs` via `log_error()`

### Changes Required

**File: `src/pages/SetupGuide.tsx`**

#### Change 1: Add `skip_session_check` parameter control for ALL error paths

Wrap ALL `report_session_check` calls inside the `skip_session_check` condition:

```python
# Instead of:
asyncio.create_task(report_session_check(account_id, success=False, error="..."))

# Do:
if not skip_session_check:
    asyncio.create_task(report_session_check(account_id, success=False, error="..."))
```

This applies to approximately **10-12 locations** in the `connect_account_with_fingerprint` function.

#### Change 2: Ensure all LiveChat connection calls use `skip_session_check=True`

Verify these are already set (confirmed in analysis):
- Initial connection loop: Line 3664 ✅
- Message send reconnection: Line 3833 ✅  
- Proxy retry reconnection: Uses `get_or_create_client` which calls with skip flag

---

## Technical Details

### Lines to Modify in `connect_account_with_fingerprint` function:

| Line | Current Code | New Code |
|------|--------------|----------|
| 853 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 867 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 871 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 875 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 879 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 883 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 889 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 914 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 918 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 922 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |
| 928 | `asyncio.create_task(report_session_check(...))` | Wrap with `if not skip_session_check:` |

---

## Expected Outcome

| Before | After |
|--------|-------|
| Every connection attempt calls `report-session-check` edge function | Zero session check calls for LiveChat runner |
| `[SESSION CHECK EXC]` errors appear in logs | No session check logs or errors |
| Extra HTTP overhead on every connection | Reduced backend calls |
| Network errors during session check cause confusion | Clean connection flow |

---

## Alternative Consideration

The edge function `report-session-check` is still useful for:
- **Account Runner** - Verifies session validity during spambot checks
- **Campaign Runner** - Initial account verification

So we'll keep the function, just disable it for LiveChat via the `skip_session_check=True` flag.

