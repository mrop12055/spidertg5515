

# Fix: Runner Slowdown Due to Excessive Backend Logging

## Problem Identified

The backend function that feeds tasks to the runner (`runner-tasks/get`) prints a log line for **every single account** on every poll cycle (line 103 in `runner-tasks/index.ts`):

```
[api] Using per-account API for +919707494945: 2040
```

With **950 active accounts**, this produces **950 log lines per request**, which:
- Bloats the edge function execution (currently 4.1 seconds per call)
- Can cause the edge function to approach or hit timeout limits
- Fills up the logging pipeline, hiding real errors

Additionally, there are **22 messages stuck in `sending`** and **18 messages stuck in `pending`** that aren't being processed, likely because the runner is spending too much time waiting for the slow `/get` response.

## What Will Change

### 1. Remove per-account API log spam (runner-tasks/index.ts, line 103)
Replace the per-account log with a single summary line:
```
[api] Resolved API credentials for 950 accounts
```

### 2. Add a summary log for account counts
After loading accounts, log a single line with counts instead of per-account details:
```
[runner-tasks/get] 950 active, 12 sendable (under daily limit), 950 connectable
```

### 3. Reset stuck messages
Run a one-time data fix to reset the 22 messages stuck in `sending` back to `pending` so the runner can retry them.

## Technical Details

**File changed:** `supabase/functions/runner-tasks/index.ts`
- Line 103: Replace individual `console.log` with a counter, print summary after the loop
- This reduces logging from ~950 lines to ~3 lines per poll cycle
- No change to the actual logic or data returned to the runner

**Data fix:** Reset 22 stuck `sending` messages to `pending`

## Expected Result
- Edge function execution drops from ~4s to under 1s
- Runner gets faster responses and stays in its main loop
- Stuck messages get retried automatically
