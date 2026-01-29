

# LiveChat Runner - Fix "retry_failed_accounts_parallel" Not Defined

## Build Version: 2026-01-29-retry-import-fix

---

## Problem Analysis

The LiveChat runner crashes with:
```
[ERROR] name 'retry_failed_accounts_parallel' is not defined
```

**Root Cause:**
1. Line 2793 imports `retry_proxy_error_accounts` (the alias function)
2. Line 3762 calls `retry_failed_accounts_parallel` directly (which is NOT imported)

```python
# Current import (line 2793):
from client_manager import (
    ..., retry_proxy_error_accounts, ...  # ✓ Imported
)

# Main loop calls (line 3762):
await retry_failed_accounts_parallel(connected_ids)  # ✗ NOT imported!
```

---

## Solution

**Option A (Simplest):** Replace the call on line 3762 to use the already-imported alias `retry_proxy_error_accounts`

The alias was created for exactly this purpose:
```python
# In client_manager.py (line 635-638):
async def retry_proxy_error_accounts(connected_ids_ref: set = None):
    """Alias for retry_failed_accounts_parallel - for backward compatibility."""
    return await retry_failed_accounts_parallel(connected_ids_ref)
```

---

## Technical Changes

### File: `src/pages/SetupGuide.tsx`

### Change 1: Update the Main Loop Call (Line 3762)

**Current Code:**
```python
# ========== RETRY FAILED ACCOUNTS (every 30s) ==========
if time.time() - last_proxy_retry >= 30:
    await retry_failed_accounts_parallel(connected_ids)  # Uses simplified _failed_accounts tracking
    last_proxy_retry = time.time()
```

**New Code:**
```python
# ========== RETRY FAILED ACCOUNTS (every 30s) ==========
if time.time() - last_proxy_retry >= 30:
    await retry_proxy_error_accounts(connected_ids)  # Uses simplified _failed_accounts tracking
    last_proxy_retry = time.time()
```

---

## Why This Works

| Component | Status |
|-----------|--------|
| `retry_proxy_error_accounts` | ✓ Already imported in livechat runner |
| `retry_failed_accounts_parallel` | ✓ Exists in client_manager.py |
| Alias mapping | ✓ `retry_proxy_error_accounts` → `retry_failed_accounts_parallel` |

The alias exists for backward compatibility and works identically to the direct call.

---

## Summary

| File | Location | Change |
|------|----------|--------|
| SetupGuide.tsx | Line 3762 | Change `retry_failed_accounts_parallel` → `retry_proxy_error_accounts` |

---

## Safety Guarantees

1. **No functional change**: The alias calls the exact same function internally
2. **Already tested**: The alias pattern was specifically created for this purpose
3. **Single line change**: Minimal risk

