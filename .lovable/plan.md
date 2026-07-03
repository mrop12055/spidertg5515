# Convert to a standalone Windows desktop app (no cloud)

Goal: run the whole system on your PC — no database, no edge functions, no internet dependency (except Telegram itself). The Python runner lives inside the app and starts automatically. Auto-updates come from GitHub Releases.

This is a full rewrite of the data + backend layers. Frontend pages/UI stay. I'll do it in phases so you can test each step before we move on.

---

## What changes vs today

- **No Lovable Cloud.** No Supabase database, no edge functions, no storage buckets.
- **All data lives on your PC** in `%APPDATA%/TelegramCRM/`:
  - `data.db` — a local SQLite file (all tables: accounts, campaigns, conversations, messages, proxies, materials, contacts, logs).
  - `files/` — attachments and material pictures.
  - `sessions/` — Telegram `.session` files.
  - `logs/` — runner log files.
- **Backend logic runs in the Electron main process.** The 2,190 lines of edge-function logic (`runner-tasks`, `admin-api`, `utilities`) are ported to Node modules and exposed to the React UI over IPC.
- **Python runner is bundled and auto-started.** No manual download. Main process spawns `unified_runner.exe` on launch, restarts it if it crashes, and stops it on quit.
- **Access code login stays** (`SPIDER77`) — pure client-side lock.
- **Auto-update via GitHub Releases** — you publish a new build to a repo, users click "Check for updates" in the app.
- **Accounts without a proxy still run** (direct connection). Runner already handles this; I'll remove any UI/queries that block them.
- **Inactive/frozen accounts are skipped** by the runner and hidden from campaign selection.

Starting fresh — no data migration from the current cloud project.

---

## Phases

### Phase 1 — Local backend skeleton (no UI wiring yet)
- Add Electron shell with `base: './'` in Vite config, `electron/main.cjs`, secure `BrowserWindow`.
- Add SQLite (`better-sqlite3`) and create the schema mirroring today's tables (minus RLS/policies/grants — single-user).
- Write a `localApi` module in the main process that mirrors every edge-function endpoint we use today, plus CRUD equivalents for what the UI does directly against Supabase (accounts, campaigns, conversations, proxies, materials).
- Expose it via `contextBridge` as `window.localApi`.

### Phase 2 — Swap the data layer in the frontend
- Replace `@/integrations/supabase/client` with a thin shim (`@/lib/localClient`) that has the same `.from().select()/.insert()/.update()/.delete()` shape but forwards to `window.localApi`. This keeps all 14 hooks/pages working with minimal edits.
- Replace `supabase.functions.invoke(...)` calls with `window.localApi.call(...)`.
- Replace `supabase.storage` uploads with `window.localApi.saveFile(...)` (writes into `files/`, returns a `file://` path).
- Delete unused pieces: `src/integrations/supabase/`, `AuthContext`'s Supabase calls (keep the access-code gate), `useRunnerStatus` polling → replace with IPC event.

### Phase 3 — Bundle Python + runner
- Ship `python-build-standalone` (embedded Windows Python, ~30 MB) inside the app under `resources/python/`.
- Ship the existing runner script under `resources/runner/unified_runner.py`, adjusted to talk to `http://127.0.0.1:<port>` instead of Supabase edge functions.
- On app launch, main process spawns the runner as a child, restarts on crash (with backoff), and streams stdout/stderr into the local log store so the Logs page keeps working.
- Add Start/Stop/Restart runner controls on the Dashboard (replacing today's manual download).
- Confirm the "no proxy = direct connection" and "skip inactive/frozen" rules explicitly in the runner's account-selection query.

### Phase 4 — Auto-update
- Add `electron-updater` wired to a GitHub Releases repo (public or private with token).
- Add a "Check for updates" button in the sidebar footer + a startup check.
- Document the publish flow (below).

### Phase 5 — Package and ship
- Use `@electron/packager` (per the sandbox constraints) to produce a Windows `.zip` you can unpack and run.
- For a proper `.exe` installer with auto-update, we generate an NSIS installer in a separate GitHub Actions workflow on your side (I'll include the workflow file). The sandbox itself can't produce `.exe` installers.

---

## How updates will work for you

1. You (or I, from Lovable) push changes to the connected GitHub repo.
2. A GitHub Actions workflow builds the Windows installer and publishes it as a Release.
3. Your installed app sees the new release, shows "Update available", installs on next restart.

You'll need a GitHub repo connected to this project (Plus menu → GitHub → Connect project) before Phase 4. I'll flag it when we get there.

---

## Trade-offs to know

- **Big refactor.** ~30 tables, 2,190 lines of edge-function logic, and every hook/page touching Supabase all get rewired. Phases 1–2 alone are the bulk of the work.
- **Data is per-PC.** If you install on a second computer, it starts empty. Add a backup/restore (export/import `data.db`) later if needed.
- **App size ≈ 150–200 MB** installed (Electron ~100 MB + Python ~30 MB + Node modules). Normal for this stack.
- **No cloud sync** for conversations means if your PC is off, incoming Telegram messages queue on Telegram's side until the runner reconnects. Same as today's runner behavior.
- **Preview inside Lovable will still work** for pure UI changes after Phase 2, but anything backend-shaped won't run in the browser preview because it depends on Electron IPC. We'll add a small mock so pages don't crash in the browser.

---

## Technical notes (for reference)

- Stack additions: `electron`, `@electron/packager`, `better-sqlite3`, `electron-updater`, `python-build-standalone` (bundled as a resource, not an npm dep).
- SQLite schema is generated from the current Postgres schema, dropping `auth.users` FKs, RLS, policies, and role grants. Triggers become Node-side hooks in `localApi`.
- IPC surface: one `invoke('api', { resource, action, payload })` channel plus event channels for `runner:log`, `runner:status`, `update:available`.
- Runner-to-app transport: a local HTTP server on `127.0.0.1` (random free port at launch, injected into runner via env var) — reuses today's runner code shape almost 1:1.
- Frontend `supabase` client shim keeps the `.from(table).select().eq().in().order().limit()` chainable API so hooks don't need rewrites; it compiles to a single `localApi.query({...})` call.

---

## What I need from you to start

Just say go and I'll begin with Phase 1. When we hit Phase 4, I'll pause and ask you to connect the project to GitHub.
