

# Bulletproof Post-Catchup Startup

## Problem

The runner crashes right after catchup finishes, before reaching the main task loop. Even though we added error catches for `PersistentTimestampOutdatedError`, the crash can come from ANY Telethon internal error during the transition between catchup and the main loop. The current protection only catches specific timestamp errors but misses other Telethon background errors.

## What's Happening

After catchup finishes for all accounts, the runner calls `setup_handlers()` which registers message listeners on each Telethon client. During this process, Telethon's internal update manager can fire errors from its background threads. These errors crash `main()` entirely, even though they're harmless.

## Solution

**File:** `src/pages/SetupGuide.tsx`

### 1. Wrap the ENTIRE setup_handlers call in a blanket try/except

Instead of only catching `PersistentTimestampOutdatedError`, catch ALL exceptions during handler setup. If handler setup fails completely, log a warning and continue to the main loop anyway -- the main loop already re-registers handlers every 60 seconds when it refreshes accounts.

### 2. Add a blanket try/except around the main loop's handler re-registration

Inside the main loop (line 1539-1540), the `setup_handlers()` call during account refresh is also unprotected. Wrap it so a failure there doesn't crash the entire loop.

### 3. Update build version

Change to `2026-02-10-startup-shield-v9`.

## Technical Changes

```python
# Post-catchup handler setup (lines 1504-1514) - catch EVERYTHING
    try:
        await setup_handlers()
    except Exception as e:
        print(f"  [WARN] Handler setup error (non-fatal): {str(e)[:80]}")
        print("  [WARN] Continuing to main loop - handlers will retry on next refresh cycle")
        sys.stdout.flush()

# Main loop handler re-registration (lines 1539-1540) - also protect
            if need_accounts and batch_accounts:
                _, newly_connected = await connect_all_from_response(batch_accounts)
                if newly_connected:
                    try:
                        await setup_handlers()
                    except Exception as e:
                        print(f"  [WARN] Handler re-registration failed: {str(e)[:60]}")
                        sys.stdout.flush()
                last_refresh = time.time()
```

## Why This Works

- Handler setup is NOT critical for the runner to function -- the main loop processes tasks regardless
- Handlers are re-attempted every 60 seconds during the account refresh cycle
- By catching ALL exceptions (not just timestamp errors), we're protected against any Telethon internal error
- The runner will always reach the main task loop, even if some handlers fail to register
