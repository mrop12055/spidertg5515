
## Goal
Make LiveChat work reliably: accounts must stay connected to receive messages, and incoming messages must be saved into the backend so they appear in the Conversations/SeatChat UI.

Right now, your runner output:
- “CONNECTING ALL ACCOUNTS → No accounts found”
- “[WAIT] No tasks (0 clients)”

means the runner is not maintaining any connected Telegram clients, so it cannot receive incoming messages. Also, the current backend “report” logic primarily handles *sending* and does not have a dedicated path for *incoming* message events.

## What I found (why it happens)
1. **Accounts exist and are active**  
   In the database, your two uploaded accounts are present, `status=active`, and they have `proxy_id` set.

2. **The runner script in SetupGuide uses two different ways to fetch data**
   - It calls the backend function `/runner-tasks/get` to fetch tasks.
   - But it uses a separate direct REST call (`/rest/v1/telegram_accounts?...`) to fetch accounts for “CONNECTING ALL ACCOUNTS”.

   If the REST call fails (network, headers, or environment mismatch), the runner prints “No accounts found”, even though `/runner-tasks/get` is capable of returning the accounts list.

3. **Incoming LiveChat messages aren’t being persisted via a first-class backend “incoming message” report**
   The existing backend function `runner-tasks/report` updates:
   - campaign recipients + outgoing messages
   - warmup messages
   - account action tasks  
   It does **not** have a clear branch for “incoming message received” events that would:
   - create/update conversation
   - insert message row with `direction='incoming'`
   - increment unread counters

## Implementation plan
### A) Backend: support “incoming message” reporting
**File:** `supabase/functions/runner-tasks/index.ts`

1. Extend `handleReportResults()` to accept results with `task_type: "incoming"` (or `"incoming_message"`).
2. For each incoming result:
   - **Find or create** a conversation for `(account_id, recipient_telegram_id)` (fallback to `recipient_phone` if needed).
   - **Deduplicate** by `(account_id, telegram_message_id)` if provided:
     - if a message with same `account_id` + `telegram_message_id` already exists, skip insert.
   - Insert a new row into `messages` with:
     - `direction: 'incoming'`
     - `status: 'delivered'` (or `read` if runner indicates it was already read)
     - `delivered_at: now`
     - `telegram_message_id` populated (recommended)
   - Update `conversations`:
     - `last_message_at = now`
     - `last_message_content = content`
     - `last_message_direction = 'incoming'`
     - `has_reply = true`
     - `unread_count = unread_count + 1` (server-side increment)

This makes the app able to show inbound messages without requiring “tasks”.

### B) Runner template: keep clients connected and report incoming events
**File:** `src/pages/SetupGuide.tsx` (the embedded Python runner template you copy to the VPS)

1. Remove (or stop relying on) the direct REST “fetch_accounts()” call.
2. Instead:
   - Call `/runner-tasks/get` on startup and periodically.
   - Use the returned `accounts` array to connect clients (this endpoint already returns `accounts` even when `tasks=[]`).
3. For each connected client, register a Telethon `NewMessage` handler:
   - For incoming messages, call `/runner-tasks/report` with `task_type: "incoming"` and include:
     - `account_id`
     - `telegram_message_id`
     - `recipient_telegram_id`
     - `recipient_username` / `recipient_name` if available
     - `content`
     - optional `received_at`
4. Keep an in-memory map of connected account IDs → client so the runner stays online and doesn’t drop to “0 clients” when there are no tasks.

### C) UI verification helpers (small improvements, optional but recommended)
**Files:** likely `src/pages/Accounts.tsx`, `src/components/dashboard/RunnerStatus.tsx`
1. Add a small note near LiveChat guidance:
   - “LiveChat requires the runner to stay connected at all times to receive messages.”
2. (Optional) Display “Last LiveChat heartbeat” by reading `runner_heartbeats` for `runner_name = livechat` or `unified`, so you can quickly tell if the listener is alive.

## How we’ll test end-to-end
1. Start the updated runner from SetupGuide on your VPS.
2. Confirm runner logs show:
   - it discovers N accounts from `/runner-tasks/get`
   - it connects N clients
   - it prints something like “Listening for incoming messages…”
3. Send a Telegram message **to one of the connected accounts** from an external account.
4. In the web app:
   - Conversations list should show the new inbound message
   - The conversation should have `unread_count` increased
   - Opening the chat should show the inbound message in the message list

## Expected outcome
- Runner will no longer show “No accounts found” when there are accounts available.
- Accounts will remain connected even when there are no outgoing tasks.
- Incoming LiveChat messages will be saved into the backend and appear in the UI.

## Notes / edge cases handled
- Duplicate incoming events (common during reconnects) handled via `telegram_message_id` dedupe.
- We continue enforcing “proxy required” behavior (no unproxied connections).
- Works for both “unified” and “livechat” modes, but we’ll favor a “livechat listener always-on” flow.

