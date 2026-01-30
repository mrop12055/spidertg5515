
Goal: Stop the Python runner from *appearing* to “reconnect accounts again and again” (and repeatedly doing catch-up), and make it clear when a real restart happens vs a normal periodic refresh.

What’s happening now (root cause)
1) The runner calls `connect_all_from_response()` on startup (expected).
2) It also calls `connect_all_from_response()` again during the main loop:
   - every 60 seconds (`time.time() - last_refresh > 60`), OR
   - when it detects fewer connected clients than accounts (`len(clients) < len(batch_accounts)`)

That is why you keep seeing:

==================================================
  CONNECTING ACCOUNTS
==================================================

Important detail:
- Even when accounts are already connected, `connect_all_from_response()` still runs the “catch-up” scan (`fetch_unread_messages`) for each account it considers “successfully connected”.
- So you see `[CATCHUP] ...` again and again, which makes it look like it’s reconnecting, even if it’s not truly reconnecting.

High-level fix
A) Only do “catch-up” for accounts that are newly connected (or reconnected after a disconnect), not every refresh.
B) Reduce noisy “CONNECTING ACCOUNTS” headers when nothing actually needs reconnecting.
C) Add a small “run id / boot counter” log so you can immediately tell whether the script restarted (crash/restart) or it’s just refreshing accounts inside the same run.

Files to change
1) `src/pages/SetupGuide.tsx` (this is the template that generates the downloadable `unified_runner.py`)
2) (Optional but recommended) `supabase/functions/runner-tasks/index.ts` to distribute campaign tasks across accounts (this addresses your earlier “why only one account sends” question)

Implementation steps (detailed)

1) Update Python template to avoid repeated catch-up + reduce reconnect spam
File: `src/pages/SetupGuide.tsx`

1.1 Modify `connect_all_from_response(accs)` logic
Current behavior:
- Always prints CONNECTING ACCOUNTS
- Always runs catch-up for every “successful” connect() result, including already-connected clients

New behavior:
- Snapshot which accounts are already connected before doing anything:
  - `already_connected = {aid for aid, c in clients.items() if c and c.is_connected()}`
- Build a `to_connect` list with only accounts that are missing or disconnected:
  - `to_connect = [acc for acc in accs if acc.id not in clients or not clients[acc.id].is_connected()]`
- Only print the big CONNECTING ACCOUNTS block if `to_connect` is non-empty
- Only run `fetch_unread_messages()` for accounts that were not in `already_connected` (newly connected/reconnected)

Expected result:
- On steady state (everything connected), the runner will NOT repeatedly print CONNECTING ACCOUNTS and will NOT repeatedly do catch-up.

1.2 Keep the “refresh every 60s” safety, but make it quiet
We will keep the existing refresh trigger (it’s useful to pick up newly added accounts), but because connect_all_from_response will now be “quiet” when nothing needs connecting, you won’t see confusing logs.

1.3 Add a clear marker to detect real restarts
Add:
- `BOOT_COUNT` incremented in `__main__` each time it re-enters the outer loop
- Print something like: `[BOOT] #2` and a timestamp
This helps you distinguish:
- “same run, periodic refresh” vs
- “script restarted/crashed and restarted”

2) (Optional but recommended) Fix “one account sends, other doesn’t” by distributing campaign tasks
File: `supabase/functions/runner-tasks/index.ts`

Problem in current campaign dispatch:
- In the campaign recipients loop it uses:
  - `usableAccounts.find(...)`
- That typically returns the first account every time, so one account gets all tasks in that batch.

Fix:
- Implement round-robin (or least-used-in-batch) selection:
  - Maintain `assignedCountByAccountId` inside the loop
  - Treat “effective sent” as `messages_sent_today + assignedCountByAccountId`
  - Pick the next available account each recipient
This will naturally spread 17 campaign sends across 2 accounts instead of hammering one account.

3) How we’ll verify (acceptance checks)
After implementing and you re-download the runner from Setup:
- Run the python file for 2–3 minutes with no tasks:
  - You should see one initial CONNECTING ACCOUNTS block, then mostly `[WAIT] No tasks...`
  - You should NOT see repeated `[CATCHUP] ...` blocks every minute.
- Start a campaign with multiple recipients:
  - You should see sends split across accounts (not all from only one).
- If the script truly restarts:
  - You will see `[BOOT] #2` / `[BOOT] #3` etc, making it obvious it restarted.

User action required after changes
Because this runner lives inside the Setup download:
- Re-download `telegram_crm_ultra.zip` from the Setup page
- Replace your existing `unified_runner.py`
- Run again

Risks / notes
- Catch-up is meant for after reconnects or startup. Running it every minute is wasteful and can confuse users; limiting it to new connections is the correct behavior.
- If you still see repeated boots after this change (BOOT counter increases), then it’s a real crash/restart and we’ll need the crash line (`⚠ Crashed: ...`) or full console output around it to pinpoint the exact exception.

