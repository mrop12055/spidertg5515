

# Fix Runner Crash After Catchup Phase

## Problem

The runner crashes after the catchup phase completes. Account `5702` shows the error `"You tried to use a method that is not available fo..."` -- this is a Telethon error indicating the client connected but isn't fully authorized (e.g., session is partially valid). While the catchup error is caught and logged, the **broken client stays in the `clients` dictionary**. When subsequent phases (handler registration, task loop) try to use this client, it crashes the runner.

## Solution

Two changes in `src/pages/SetupGuide.tsx`:

### 1. Remove broken clients during catchup (Line ~1252)

When a catchup fails with a non-timeout error (like "method not available"), **remove the client from `clients` and disconnect it**. This prevents the broken client from being used in later phases.

```python
except Exception as e:
    phone_short = (accounts.get(aid, {}).get('phone_number') or '????')[-4:]
    print(f"  [CATCHUP] [{phone_short}] Error: {str(e)[:60]}")
    sys.stdout.flush()
    # Remove broken client so it doesn't crash handler registration or task loop
    try:
        bad_client = clients.pop(aid, None)
        if bad_client:
            await bad_client.disconnect()
    except:
        pass
    print(f"  [CATCHUP] [{phone_short}] Removed (will reconnect next cycle)")
    sys.stdout.flush()
```

### 2. Update the catchup "Done" message to only print on success (Lines ~1247-1248)

Move the "Done" print inside the try block so it only shows for successful catchups, not after errors.

### 3. Update build version (Line 17)

Change to `2026-02-09-catchup-fix-v6` to reflect the fix.

## Why This Fixes the Crash

Currently the flow is:
1. Catchup runs -- account 5702 errors but stays in `clients`
2. Handler registration tries to use account 5702's broken client -- crash

After the fix:
1. Catchup runs -- account 5702 errors, gets removed from `clients`
2. Handler registration skips account 5702 (not in `clients`)
3. Next polling cycle, account 5702 gets a fresh connection attempt

## Trade-off

Accounts that fail catchup will need to wait one polling cycle (~30s) to reconnect. This is much better than crashing the entire runner.

