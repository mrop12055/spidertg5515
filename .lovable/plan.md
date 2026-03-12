

# Root Cause: Session Files Used Twice → Telegram Revokes Sessions

## The Problem

All 189 disconnected accounts have the exact same reason: **"Session not authorized/revoked"**. This happens when Telegram detects two concurrent connections using the same auth key and kills both.

## Root Cause Analysis

After deep inspection of the runner code (`unified_runner.py`) and the edge function (`runner-tasks`), there are **two bugs** causing duplicate session usage:

### Bug 1: Old client not disconnected before reconnection (PRIMARY CAUSE)

In the `connect()` function, when an account exists in the `clients` dict but `is_connected()` returns `False`, the code creates a **brand new `TelegramClient`** without first disconnecting the old one:

```text
connect() flow:
  1. Check: aid in clients AND clients[aid].is_connected()?
  2. If YES → reuse (good)
  3. If NO → create NEW TelegramClient (BUG: old client not disconnected!)
     → Telegram sees 2 auth keys from same session → REVOKES BOTH
```

Every 60 seconds, the main loop calls `connect_all_from_response()` which checks `is_connected()` with a **0.5-second timeout**. If the check times out (common under load with 600+ accounts), the account is treated as "disconnected" and a NEW client is created — while the old one is still alive on Telegram's servers.

### Bug 2: Parallel task processing can trigger duplicate connects

When `process()` is called for a task and the client isn't in `clients`, it calls `connect(acc)`. With `asyncio.gather(*[process(t) for t in tasks])`, multiple tasks for the same account could race to create connections. The lock helps but the session file gets rewritten by `decode_session()` each time.

## Fix Plan

### 1. Fix `connect()` — Disconnect old client before creating new one

Add cleanup logic at the start of `connect()` to properly disconnect any existing stale client before creating a new one. This is the critical fix.

### 2. Fix `connect_all_from_response()` — Increase is_connected timeout  

Change the 0.5s timeout to 2s to reduce false "disconnected" results under load.

### 3. Fix `decode_session()` — Skip rewrite if session file already exists

Avoid rewriting the session file if it already exists with the same content, preventing file corruption during parallel access.

### 4. Add runner instance guard

Add a unique instance ID to heartbeats so the backend can warn if multiple runners are active simultaneously.

### Files Changed
- `src/pages/SetupGuide.tsx` — Runner Python code (all 4 fixes above)

