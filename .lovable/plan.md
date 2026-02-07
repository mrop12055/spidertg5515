

# Fix: Python Runner Freezing After Catchup

## Problem
The Python runner connects all 950 accounts, completes the catch-up phase, but then freezes and never enters the main task loop.

## Root Cause
When the runner polls `/runner-tasks/get`, the backend returns ALL 950 accounts with full session data and proxy details in every response (default `include_accounts=true`). This produces a 10-30MB JSON payload that causes:
- Network transfer delays
- JSON parsing blocking the asyncio event loop
- Silent aiohttp timeouts

The backend already has an optimization flag (`include_accounts: false`) but the Python runner is not using it.

## Backend Verification (All Passing)
- `runner-tasks/get` -- 200 OK, returning tasks correctly
- `runner-tasks/report` -- working, processing incoming messages
- `runner-tasks/heartbeat` -- working, last seen 2 minutes ago
- Database -- 950 active accounts, 20 pending messages, 6,665 queued recipients
- No running campaigns (all paused) -- this is expected, not a bug

## Fix (Python Side)

Since the Python runner code lives outside this project (it's a separate Python file on your VPS), here is exactly what to change:

### Step 1: Add `include_accounts: false` to polling requests

In your Python runner's main loop where it calls `/runner-tasks/get`, change the request body from:

```python
# BEFORE (sends huge payload every poll)
body = {"runner": "unified", "batch_size": 100}
```

to:

```python
# AFTER (skip accounts in response - runner already has them connected)
body = {"runner": "unified", "batch_size": 100, "include_accounts": False}
```

### Step 2: Add a timeout to the HTTP request

Make sure the polling request has an explicit timeout so it never hangs silently:

```python
# Add timeout to prevent silent hangs
async with session.post(url, json=body, timeout=aiohttp.ClientTimeout(total=30)) as resp:
    data = await resp.json()
```

### Step 3: Add debug prints around the main loop entry

To confirm the fix works, add prints:

```python
print("[MAINLOOP] Entering main task loop...", flush=True)
while True:
    print(f"[POLL] Fetching tasks...", flush=True)
    # ... your polling code ...
    print(f"[POLL] Got {len(tasks)} tasks, delay={delay}", flush=True)
```

## Why This Wasn't an Issue Before

With fewer accounts (say 200-400), the full accounts payload was manageable. At 950 accounts, the response size crossed a threshold where it blocks the event loop or exceeds default timeouts. This is a scaling issue, not a code bug.

## Technical Details

### Response size comparison:
- `include_accounts: true` (default) -- ~28,000 lines of JSON (~15-25MB)
- `include_accounts: false` -- ~900 lines of JSON (~50KB)

### The backend optimization already exists
Line 170 of `runner-tasks/index.ts`:
```
const includeAccounts: boolean = body?.include_accounts !== false;
```

This was specifically added for large fleets. The Python runner just needs to opt into it.

