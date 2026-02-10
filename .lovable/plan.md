

# Handle PersistentTimestampOutdatedError Gracefully

## Problem

After the catchup phase, the runner crashes with `PersistentTimestampOutdatedError: Persistent timestamp outdated (caused by GetChannelDifferenceRequest)`. This is a **Telegram server-side issue** -- it happens when Telethon tries to sync channel/group update state and the server rejects the timestamp as too old. It's not a client bug and doesn't mean accounts are broken.

Currently, this error bubbles up and crashes the runner, triggering a full restart (boot cycle).

## Solution

**File:** `src/pages/SetupGuide.tsx`

### 1. Add a global error filter for Telethon's internal sync errors

In the main loop's `except` block (around line 1541), catch `PersistentTimestampOutdatedError` specifically and log it as a warning instead of crashing. Since this error comes from Telethon's internal update handling (not from our code), we also need to add a Telethon session-level error handler.

### 2. Wrap the Telethon event loop with error suppression

Add a try/except around the `asyncio.sleep` in the main loop that catches this specific Telegram error class, logs it, and continues instead of crashing.

### 3. Specific changes

- **Import the error class** at the top of the Python script: `from telethon.errors import PersistentTimestampOutdatedError`
- **Add a catch** in the main loop's except block (line 1541) to specifically handle this error with a simple warning log instead of treating it as a crash
- **Add a catch** in the outer boot loop (line 1578) to handle it without triggering a full restart
- **Update build version** to `2026-02-10-timestamp-fix-v7`

### 4. Technical detail

The error path looks like:
1. Telethon's internal update manager calls `GetChannelDifferenceRequest`
2. Telegram server responds with "persistent timestamp outdated"
3. Telethon raises `PersistentTimestampOutdatedError`
4. This propagates up and crashes the runner

After the fix, these errors will be logged as warnings and the runner will continue operating normally.

