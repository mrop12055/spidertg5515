
## Goal

Turn the Python skeleton runner into a real Telethon worker that, on app start, connects every active account (with or without a proxy), keeps them online, and can send/receive messages.

## What the runner will do

1. **Boot**
   - Read `TCRM_SESSIONS_DIR`, `TCRM_FILES_DIR`, `TCRM_USER_DATA` (already passed by `electron/runner.cjs`).
   - Open the same SQLite DB the Electron app uses at `<userData>/telegramcrm.db` directly (read-only shared with WAL) so we don't need an HTTP bridge yet.
   - Install Telethon (bundled in the packaged Python; in dev fall back to system pip install).

2. **Connect every account** (`status != 'frozen'` and `auto_disabled = 0`)
   - Load `.session` file from `TCRM_SESSIONS_DIR/<phone>.session` (or create from `session_data` blob if present).
   - Use per-account `api_id` / `api_hash` (fallback to `telegram_api_credentials` row via `api_credential_id`).
   - If the account has a `proxy_id`, look up the proxy row and pass `(socks5, host, port, user, pass)` to Telethon. Otherwise connect direct.
   - On success: set `status='active'`, `last_active=now`, clear `disabled_reason`.
   - On failure: set `status='disconnected'` or `'frozen'` (AuthKeyError / UserDeactivated), write `disabled_reason`, keep retrying with backoff.

3. **Keep online**
   - Every 30s: for each connected client, call `client.is_connected()` + a cheap `get_me()` ping; on drop, reconnect.
   - Every 60s: `UPDATE telegram_accounts SET last_active = now` for still-online accounts.
   - Heartbeat log line every 10s (already scaffolded) now includes `online=<n>/<total>`.

4. **Receive messages**
   - Register `@client.on(events.NewMessage(incoming=True))` per account.
   - On event: upsert into `conversations` (match by `telegram_id`), insert into `messages` (`direction='incoming'`), bump `unread_count`, mark `has_reply=1` if it's a reply to us. Reuses existing tables — no schema change.

5. **Send messages (task queue)**
   - Poll `campaign_recipients` where `status='pending'` (limit 25 per tick, every 5s).
   - For each: claim by setting `status='sending'`, `sending_started_at=now`; send via the assigned account's Telethon client; on success mark `sent`, insert outgoing `messages` row, bump `messages_sent_today`; on FloodWait store `restricted_until`; on PeerFlood set `auto_disabled=1`.
   - Also drain a simple `outbound_messages` queue table (created if missing) that the Seat Chat UI writes into for live replies.

6. **Shutdown**
   - On SIGINT/SIGTERM: disconnect all clients, close DB, exit 0. (`_stop` flag already scaffolded.)

## UI changes

- `RunnerStatus` component (already re-added) shows `online / total` accounts + last heartbeat time. IPC channel `runner:status` payload extended with `{ accountsOnline, accountsTotal, lastHeartbeatAt }`.
- No other UI changes; existing Accounts / Conversations / Campaigns pages already read from the same SQLite tables the runner writes.

## Files touched

- `resources/runner/unified_runner.py` — replace skeleton with full worker (~500 lines split into `db.py`, `clients.py`, `sender.py`, `receiver.py` under `resources/runner/`).
- `resources/runner/requirements.txt` — new; pins `telethon`, `python-socks`, `cryptg`.
- `electron/runner.cjs` — on first launch, if `resources/python` exists, run `python -m pip install -r requirements.txt --target resources/runner/_vendor` once; add `_vendor` to `PYTHONPATH`. In dev, use system `pip install --user`.
- `electron/main.cjs` — pass `TCRM_DB_PATH` env var to the runner.
- `src/components/dashboard/RunnerStatus.tsx` — render new fields from status payload.

## Out of scope

- No proxy auto-testing / rotation (uses whatever proxy row is assigned).
- No new-account login flow from the runner (still done via existing import).
- No cloud/Supabase calls — everything local.

## Technical notes

- Telethon is asyncio; the runner becomes an `asyncio.run(main())` with one task per account plus a scheduler task.
- SQLite writes from Python use `PRAGMA journal_mode=WAL` (already set) — safe alongside Electron's `better-sqlite3`. All writes wrapped in short transactions.
- `cryptg` gives a 10x speed-up for message decryption; optional but included.
