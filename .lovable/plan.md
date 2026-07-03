# Full Local-First Desktop Pivot

Goal: each PC runs a fully self-contained desktop app. All account/campaign/conversation data lives in a local SQLite DB inside the Electron user-data folder. The Python runner talks only to the local Electron app over `http://127.0.0.1:<port>`. No cloud sync between PCs.

## Scope decisions (locked in)
- Login stays cloud-based (SPIDER77 gate + Supabase auth) — only the app data moves local.
- No cross-PC sync. Each PC is an island.
- Existing cloud data gets a one-time **Export → JSON file → Import** flow so users can seed a new PC.
- Web preview keeps rendering (uses the same UI, empty stub data via `localClient` fallback).

## Phase plan

### Phase 1 — Local schema + API surface
- Expand `electron/db.cjs` SQLite schema to mirror every cloud table currently used: `telegram_accounts`, `telegram_api_credentials`, `proxies`, `campaigns`, `campaign_recipients`, `campaign_accounts`, `conversations`, `messages`, `runner_heartbeats`, `lifetime_stats`, `app_settings`, `material_*`, `contacts_data`, `blocked_contacts`, `account_check_tasks`, `contact_import_tasks`, `maturation_tasks`, `interaction_scheduler`, `scheduled_interactions`, `proxy_errors`, `vps_logs`.
- Expand `electron/api.cjs` to handle every `op` the frontend sends: `select` (with filters/order/limits), `insert`, `update`, `upsert`, `delete`, plus RPC-style calls (`increment_messages_sent_today`, `sync_campaign_counters`, etc.) reimplemented in JS.
- Add a real-time change bus so `.channel().on('postgres_changes')` subscribers on the frontend still fire when local rows change.
- Add a local HTTP server (bound to `127.0.0.1:<random-port>`) exposing the same endpoints the Python runner used to call on `runner-tasks` / `admin-api` / `utilities` edge functions.

### Phase 2 — Frontend switchover
- Flip every page/hook from `@/integrations/supabase/client` to `@/lib/localClient`:
  - `useAccounts`, `useCampaigns`, `useConversations`, `useMessages`, `useProxies`, `useProxyErrors`, `useDashboardStats`, `useAppSettings`, `useUniqueConversations`, `useRunnerStatus`, `useAppUpdater`, plus the pages that import supabase directly (`Accounts.tsx`, `Campaigns.tsx`, `Conversations.tsx`, `Proxies.tsx`, `Material.tsx`, `Logs.tsx`, `Dashboard.tsx`, `CreateCampaignDialog.tsx`, `AccountScheduler.tsx`, `RecentErrorsCard.tsx`, `TaskQueueCard.tsx`).
- Keep `AuthContext` on cloud Supabase (login only).
- `localClient` stub keeps returning empty data in the browser preview so `id-preview` still renders without crashing.

### Phase 3 — Python runner rewrite
- Point `unified_runner.py` at the local Electron HTTP API instead of `SUPABASE_URL`.
- New env vars from Electron: `TCRM_API_URL`, `TCRM_API_TOKEN` (shared secret so only this PC's runner can call the local API).
- Drop cloud auth headers, drop server_id duplicate-blocking (no longer needed — one runner per PC by design), keep proxy-optional behavior added in v15.
- Bump build tag to `v16-local-only`.

### Phase 4 — Data portability
- **Export** button on Dashboard: writes a `tcrm-backup-<timestamp>.json` file containing all local tables (or downloads from the current cloud DB for first-time seeding).
- **Import** button: reads the JSON file, upserts into local SQLite.
- One-off migration helper: on first launch of the new desktop build, offer to pull the user's existing cloud data into local SQLite.

### Phase 5 — Cleanup
- Mark cloud edge functions (`runner-tasks`, `admin-api`, `utilities`) as legacy — leave deployed for a grace period but the app no longer calls them.
- Update memory notes: architecture is now local-first per-PC; runner concurrency rules no longer apply.

## Technical notes
- SQLite via `better-sqlite3` (already in use).
- Local HTTP server: tiny Node `http` module inside Electron main, listens on `127.0.0.1` with an auth token in `Authorization` header.
- Real-time simulation: `electron/api.cjs` emits IPC events on writes; `localClient.channel().on()` subscribes to them.
- File storage: attachments stored under `<userData>/files/`, referenced by relative path in the messages table (already how Electron dirs are laid out).
- Sessions (`.session` files): already stored under `<userData>/sessions/`.

## Risks & mitigations
- **Big surface area** — done in 5 phases so the app never fully breaks; each phase is testable on its own.
- **Real-time parity** — frontend heavily relies on postgres_changes. The IPC bridge must fire on every write; missing one = stale UI.
- **Data loss risk** — Phase 4 (Export/Import) ships in the same release as Phase 2 so users can back up before switching.

## Delivery order in this session
I'll start with **Phase 1** (schema + local API expansion) since everything else depends on it. That's a large single change — I'll pause at the end of Phase 1 for you to test before moving to Phase 2.
