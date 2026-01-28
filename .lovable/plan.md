

# Remove Unused CONNECTION_RETRIES Constant

## Issue

The constant `CONNECTION_RETRIES = 2` at line 143 is defined but never used anywhere in the code. This is dead code that could confuse developers.

**Evidence:**
- Line 143 defines: `CONNECTION_RETRIES = 2`
- Line 772 uses hardcoded: `connection_retries=0,  # NEVER retry internally - could bypass proxy`

The Telethon client intentionally uses `connection_retries=0` for safety (to prevent retrying without proxy), making the `CONNECTION_RETRIES` constant obsolete.

## Change

**File:** `src/pages/SetupGuide.tsx`

**Remove line 143:**
```python
# BEFORE (lines 141-145):
# ========== SPLIT TIMEOUTS ==========
CONNECTION_TIMEOUT = 20      # Telegram connection timeout (increased from 10)
CONNECTION_RETRIES = 2       # Connection retries (increased from 1)
RETRY_DELAY = 2              # Retry delay in seconds (increased from 0)

# AFTER (lines 141-144):
# ========== SPLIT TIMEOUTS ==========
CONNECTION_TIMEOUT = 20      # Telegram connection timeout (increased from 10)
RETRY_DELAY = 2              # Retry delay in seconds (increased from 0)
```

## Impact

- **Functional impact:** None - the constant was never used
- **Code quality:** Improved - removes confusing dead code
- **Risk:** Zero - purely cosmetic cleanup

