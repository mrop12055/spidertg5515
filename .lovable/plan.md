

# Increase Catchup Timeout

## What's Changing

The runner's catch-up phase (which syncs offline messages when accounts reconnect) currently has a **20-second timeout per account**. This is causing some accounts to timeout before they finish syncing unread messages, especially accounts with many dialogs or slow proxy connections.

The plan is to increase this timeout from **20 seconds to 45 seconds**, giving accounts more time to complete the catch-up sync.

## Technical Details

**File:** `src/pages/SetupGuide.tsx`

- **Line 1246**: Change `timeout=20` to `timeout=45` in the `_catchup_one` function
- **Line 17**: Update the build version string to reflect the change (e.g., `2026-02-09-catchup-timeout-v5`)

This means each account gets up to 45 seconds to scan dialogs and fetch unread messages before being skipped. The catch-up still runs in parallel across all newly connected accounts, so total startup time depends on the slowest account (capped at 45s).

**Trade-off**: Startup may take slightly longer if some accounts are slow, but fewer accounts will be skipped due to timeout.

> After this change, you will need to **re-download and restart** the runner for the new timeout to take effect.
