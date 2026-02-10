

# Fix Runner Crash After Catchup - Wrap Post-Catchup Phase

## What's Happening

The runner crashes right after catchup finishes because the `PersistentTimestampOutdatedError` (or other Telegram internal errors) fires during **handler registration** (line 1493) or during the gap between catchup and the main loop. While we added catches inside the main polling loop and the outer boot loop, the error during handler setup causes `main()` to crash and triggers a full restart.

**What is Catchup?** When the runner starts (or reconnects accounts), it syncs any messages that arrived while it was offline. For each account, it scans recent Telegram dialogs (private chats only), finds unread messages from the last 24 hours (or since last offline time), and saves them to your database. This ensures no messages are lost when the runner restarts. The 45-second timeout prevents slow accounts from blocking startup.

## Root Cause

The `PersistentTimestampOutdatedError` is a Telegram server-side issue -- Telethon internally tries to sync channel update timestamps and Telegram rejects them as too old. This can fire at ANY time from Telethon's background update loop, including during handler registration. Currently only the main polling loop and boot loop catch it, but the startup phase between catchup and the main loop does not.

## Solution

**File:** `src/pages/SetupGuide.tsx`

### 1. Wrap the entire post-catchup startup in a try/except (Lines 1489-1495)

Wrap the handler registration and startup debug prints in a try/except that catches `PersistentTimestampOutdatedError` and continues instead of crashing.

### 2. Add a fallback string-based catch

Some Telethon versions may not export `PersistentTimestampOutdatedError`. Add a fallback in the generic `except Exception` blocks that checks if "PersistentTimestamp" is in the error string, so even if the import fails silently, the error is still handled gracefully.

### 3. Wrap the import with a fallback

Make the `PersistentTimestampOutdatedError` import safe -- if it doesn't exist in the user's Telethon version, define a dummy class so the except clauses don't fail.

### 4. Update build version

Change to `2026-02-10-timestamp-fix-v8`.

## Specific Changes

```python
# Safe import (lines 86-91)
from telethon.errors import (
    FloodWaitError, UserPrivacyRestrictedError, PeerFloodError,
    UserBlockedError, ChatWriteForbiddenError, AuthKeyUnregisteredError,
    SessionRevokedError, UserDeactivatedBanError, PhoneNumberBannedError
)
try:
    from telethon.errors import PersistentTimestampOutdatedError
except ImportError:
    class PersistentTimestampOutdatedError(Exception):
        pass

# Wrap post-catchup startup (lines 1489-1495)
    _, _ = await connect_all_from_response(initial_accounts)
    print("  [DEBUG] CATCHUP complete, setting up handlers...")
    sys.stdout.flush()
    
    try:
        await setup_handlers()
    except PersistentTimestampOutdatedError:
        print("  [WARN] Telegram timestamp sync issue during handler setup - ignoring")
        sys.stdout.flush()
    except Exception as e:
        if "PersistentTimestamp" in str(e):
            print("  [WARN] Telegram timestamp sync issue during handler setup - ignoring")
            sys.stdout.flush()
        else:
            raise
    
    print("  [DEBUG] Handlers registered, entering main loop...")
    sys.stdout.flush()

# Also add string-based fallback in main loop except (line 1546-1548)
        except Exception as e:
            if "PersistentTimestamp" in str(e):
                print("  [WARN] Telegram internal sync issue - ignoring")
                sys.stdout.flush()
                await asyncio.sleep(2)
                continue
            print(f"  [ERROR] {str(e)[:40]}")
            await asyncio.sleep(5)

# Same string-based fallback in boot loop (line 1587-1591)
        except Exception as e:
            if "PersistentTimestamp" in str(e):
                print("\\n⚠ Telegram internal sync issue - continuing...")
                time.sleep(2)
                RUNNING = True
                continue
            print(f"\\n⚠ Crashed: {e}\\n  Restarting in 5s...")
            time.sleep(5)
            RUNNING = True
```

## Why This Fixes It

The error can now fire at any point during the runner lifecycle and will always be caught -- either by the specific exception class or by string matching as a fallback. The runner will log a warning and continue instead of crashing and restarting.

