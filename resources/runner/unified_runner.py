"""TelegramCRM local runner — Phase 3.

Talks ONLY to the Electron app's local HTTP server on 127.0.0.1. No cloud.

Env from electron/runner.cjs:
  TCRM_API_URL         http://127.0.0.1:<port>
  TCRM_API_TOKEN       per-launch bearer token
  TCRM_SESSIONS_DIR    where .session files live
  TCRM_FILES_DIR       where attachments live
  TCRM_USER_DATA       app data root

What it does:
  1. Heartbeat every 10s.
  2. Load all active accounts, connect each with Telethon (proxy optional).
  3. Register an incoming-message handler per account -> POST /messages/incoming.
  4. Poll /tasks/get every 5s; for each task, send via one of the connected
     clients and POST /tasks/report.

Install (bundled Python already has these):
  pip install telethon httpx pysocks
"""

from __future__ import annotations

import asyncio
import base64
import os
import signal
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    import httpx
except ImportError:
    print("[runner] missing dependency: httpx (pip install httpx)", flush=True)
    sys.exit(1)

try:
    from telethon import TelegramClient, events
    from telethon.errors import (
        FloodWaitError,
        PeerFloodError,
        UserPrivacyRestrictedError,
        UserDeactivatedBanError,
        AuthKeyUnregisteredError,
    )
except ImportError:
    print("[runner] missing dependency: telethon (pip install telethon pysocks)", flush=True)
    sys.exit(1)

try:
    import socks  # noqa: F401 (used by Telethon when proxy is set)
except ImportError:
    socks = None  # proxy support disabled if pysocks missing

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------
API_URL = os.environ.get("TCRM_API_URL", "").rstrip("/")
API_TOKEN = os.environ.get("TCRM_API_TOKEN", "")
SESSIONS_DIR = os.environ.get("TCRM_SESSIONS_DIR", tempfile.gettempdir())
FILES_DIR = os.environ.get("TCRM_FILES_DIR", tempfile.gettempdir())

HEARTBEAT_SECONDS = 10
TASK_POLL_SECONDS = 5
CONNECT_TIMEOUT = 30

_stop = asyncio.Event()
_clients: Dict[str, TelegramClient] = {}   # account_id -> client
_accounts: Dict[str, dict] = {}            # account_id -> account row

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[runner] {msg}", flush=True)


def _handle_signal(signum, _frame):
    log(f"signal {signum} received, stopping")
    try:
        asyncio.get_event_loop().call_soon_threadsafe(_stop.set)
    except RuntimeError:
        _stop.set()


def auth_headers() -> Dict[str, str]:
    return {"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"}


async def api_get(client: httpx.AsyncClient, path: str) -> dict:
    r = await client.get(f"{API_URL}{path}", headers=auth_headers(), timeout=15)
    if r.status_code >= 400:
        log(f"GET {path} -> {r.status_code}: {r.text[:500]}")
    r.raise_for_status()
    return r.json()


async def api_post(client: httpx.AsyncClient, path: str, body: dict) -> dict:
    r = await client.post(f"{API_URL}{path}", headers=auth_headers(), json=body, timeout=15)
    if r.status_code >= 400:
        log(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    r.raise_for_status()
    return r.json()


def decode_session(phone: str, session_b64: str) -> Optional[str]:
    """Write the base64 session_data blob to disk, return the path (no .session)."""
    if not session_b64:
        return None
    try:
        raw = base64.b64decode(session_b64)
    except Exception as e:
        log(f"[{phone}] session decode failed: {e}")
        return None
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    path = os.path.join(SESSIONS_DIR, f"{phone.replace('+','')}.session")
    with open(path, "wb") as f:
        f.write(raw)
    return path[:-len(".session")] if path.endswith(".session") else path


def build_proxy(acc: dict):
    p = acc.get("proxy")
    if not p or not socks:
        return None
    ptype = socks.SOCKS5 if (p.get("proxy_type") or "socks5").lower() == "socks5" else socks.HTTP
    return (ptype, p["host"], int(p["port"]), True, p.get("username") or None, p.get("password") or None)


# ---------------------------------------------------------------------------
# per-account setup
# ---------------------------------------------------------------------------

async def _on_incoming(client: httpx.AsyncClient, account_id: str, event) -> None:
    """Forward inbound Telegram messages to the local API."""
    try:
        sender = await event.get_sender()
        phone = getattr(sender, "phone", None)
        username = getattr(sender, "username", None)
        name = " ".join(filter(None, [getattr(sender, "first_name", None), getattr(sender, "last_name", None)])) or None
        tid = getattr(sender, "id", None)
        content = event.message.message or ""
        await api_post(client, "/messages/incoming", {
            "account_id": account_id,
            "from_phone": ("+" + phone) if phone else None,
            "from_username": username,
            "from_telegram_id": tid,
            "from_name": name,
            "content": content,
            "telegram_message_id": event.message.id,
        })
    except Exception as e:
        log(f"incoming handler error: {e}")


async def connect_account(http: httpx.AsyncClient, acc: dict) -> Optional[TelegramClient]:
    aid = acc["id"]
    phone = acc.get("phone_number") or "unknown"
    if not acc.get("session_data"):
        log(f"[{phone}] skipped: no session_data")
        return None
    if not acc.get("api_id") or not acc.get("api_hash"):
        log(f"[{phone}] skipped: missing api_id / api_hash")
        return None
    session_path = decode_session(phone, acc["session_data"])
    if not session_path:
        return None
    proxy = build_proxy(acc)
    if proxy is None:
        log(f"[{phone}] connecting directly (no proxy)")
    else:
        log(f"[{phone}] connecting via {proxy[1]}:{proxy[2]}")
    try:
        client = TelegramClient(
            session_path, int(acc["api_id"]), acc["api_hash"],
            device_model=acc.get("device_model") or "PC",
            system_version=acc.get("system_version") or "Windows 10",
            app_version=acc.get("app_version") or "1.0",
            lang_code=acc.get("lang_code") or "en",
            system_lang_code=acc.get("system_lang_code") or "en",
            proxy=proxy, timeout=CONNECT_TIMEOUT, auto_reconnect=True,
        )
        await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT)
        if not await client.is_user_authorized():
            log(f"[{phone}] not authorized, session invalid")
            await api_post(http, "/accounts/status", {
                "account_id": aid, "status": "disconnected",
                "ban_reason": "session not authorized", "auto_disabled": True,
            })
            await client.disconnect()
            return None

        # Register live inbound handler.
        @client.on(events.NewMessage(incoming=True))
        async def _h(ev):
            await _on_incoming(http, aid, ev)

        log(f"[{phone}] connected OK")
        return client
    except AuthKeyUnregisteredError:
        log(f"[{phone}] auth key unregistered (deleted from device)")
        await api_post(http, "/accounts/status", {
            "account_id": aid, "status": "disconnected",
            "ban_reason": "auth key unregistered", "auto_disabled": True,
        })
    except UserDeactivatedBanError:
        log(f"[{phone}] account banned")
        await api_post(http, "/accounts/status", {
            "account_id": aid, "status": "banned",
            "ban_reason": "account banned", "auto_disabled": True,
        })
    except Exception as e:
        log(f"[{phone}] connect failed: {type(e).__name__}: {e}")
    return None


# ---------------------------------------------------------------------------
# task loop
# ---------------------------------------------------------------------------

async def send_task(http: httpx.AsyncClient, task: dict) -> None:
    recipient_id = task["id"]
    recipient_phone = task.get("phone_number") or ""
    template = task.get("message_template") or ""
    name = task.get("name") or ""
    content = template.replace("{name}", name).replace("{phone}", recipient_phone)

    if not _clients:
        await api_post(http, "/tasks/report", {
            "recipient_id": recipient_id, "status": "failed",
            "failed_reason": "no connected accounts",
        })
        return

    # Simple round-robin: pick any connected client. Real logic (per-account
    # limits, per-campaign account restrictions) will be added incrementally.
    account_id = next(iter(_clients))
    client = _clients[account_id]
    try:
        target = recipient_phone if recipient_phone.startswith("+") else (recipient_phone or task.get("username") or "")
        if not target:
            raise ValueError("no recipient target")
        entity = await client.get_entity(target)
        await client.send_message(entity, content)
        await api_post(http, "/tasks/report", {
            "recipient_id": recipient_id, "status": "sent",
            "sent_by_account_id": account_id,
        })
        log(f"sent -> {target}")
    except FloodWaitError as e:
        await api_post(http, "/tasks/report", {
            "recipient_id": recipient_id, "status": "pending",
            "failed_reason": f"flood wait {e.seconds}s",
        })
    except (PeerFloodError, UserPrivacyRestrictedError) as e:
        await api_post(http, "/tasks/report", {
            "recipient_id": recipient_id, "status": "failed",
            "failed_reason": type(e).__name__, "sent_by_account_id": account_id,
        })
    except Exception as e:
        await api_post(http, "/tasks/report", {
            "recipient_id": recipient_id, "status": "failed",
            "failed_reason": f"{type(e).__name__}: {e}"[:200],
            "sent_by_account_id": account_id,
        })
        log(f"send failed: {e}")


async def task_loop(http: httpx.AsyncClient) -> None:
    while not _stop.is_set():
        try:
            resp = await api_post(http, "/tasks/get", {"batch_size": 20})
            tasks = resp.get("tasks", [])
            if tasks:
                log(f"picked {len(tasks)} task(s)")
                for t in tasks:
                    if _stop.is_set(): break
                    await send_task(http, t)
        except Exception as e:
            log(f"task loop error: {e}")
        try:
            await asyncio.wait_for(_stop.wait(), timeout=TASK_POLL_SECONDS)
        except asyncio.TimeoutError:
            pass


async def heartbeat_loop(http: httpx.AsyncClient) -> None:
    while not _stop.is_set():
        try:
            await api_post(http, "/heartbeat", {"runner": "unified", "server_id": "local"})
        except Exception as e:
            log(f"heartbeat error: {e}")
        try:
            await asyncio.wait_for(_stop.wait(), timeout=HEARTBEAT_SECONDS)
        except asyncio.TimeoutError:
            pass


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

async def main_async() -> int:
    if not API_URL or not API_TOKEN:
        log("FATAL: TCRM_API_URL / TCRM_API_TOKEN not set")
        return 1

    log(f"python={sys.version.split()[0]}")
    log(f"api={API_URL}")
    log(f"sessions={SESSIONS_DIR}")

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handle_signal)
        except (ValueError, OSError):
            pass

    async with httpx.AsyncClient() as http:
        # Load accounts and connect them all.
        try:
            resp = await api_get(http, "/accounts")
        except Exception as e:
            log(f"failed to load accounts: {e}")
            return 1
        accs = resp.get("accounts", [])
        log(f"loaded {len(accs)} active account(s)")
        for acc in accs:
            _accounts[acc["id"]] = acc
            client = await connect_account(http, acc)
            if client:
                _clients[acc["id"]] = client

        log(f"connected {len(_clients)}/{len(accs)} account(s)")

        # Kick off the loops.
        hb = asyncio.create_task(heartbeat_loop(http))
        tl = asyncio.create_task(task_loop(http))

        await _stop.wait()

        log("shutting down")
        for t in (hb, tl):
            t.cancel()
        for aid, client in list(_clients.items()):
            try: await client.disconnect()
            except Exception: pass

    log("stopped cleanly")
    return 0


def main() -> int:
    try:
        return asyncio.run(main_async())
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        log(f"fatal: {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
