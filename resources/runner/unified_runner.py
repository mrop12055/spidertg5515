"""TelegramCRM local runner — Telethon worker.

Runs alongside the Electron app. Reads accounts / campaigns / outbound-messages
straight from the same SQLite DB (`data.db`) the app writes to, using WAL for
safe concurrent access with better-sqlite3.

Environment (set by electron/runner.cjs):
  TCRM_DB_PATH        absolute path to <userData>/data.db
  TCRM_SESSIONS_DIR   dir holding <phone>.session files
  TCRM_FILES_DIR      dir for outgoing attachments (optional)
  TCRM_USER_DATA      app data root
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sqlite3
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

# Make bundled vendor deps importable when the packaged app installs them
# into resources/runner/_vendor.
_VENDOR = os.path.join(os.path.dirname(__file__), "_vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)

try:
    from telethon import TelegramClient, events, errors  # type: ignore
    from telethon.sessions import StringSession  # type: ignore
except Exception as e:  # pragma: no cover
    print(f"[runner] FATAL: telethon import failed: {e}", flush=True)
    print("[runner] deps not installed — runner will idle", flush=True)
    TelegramClient = None  # type: ignore
    events = None  # type: ignore
    errors = None  # type: ignore
    StringSession = None  # type: ignore

DB_PATH = os.environ.get("TCRM_DB_PATH", "")
SESSIONS_DIR = os.environ.get("TCRM_SESSIONS_DIR", "")
FILES_DIR = os.environ.get("TCRM_FILES_DIR", "")

_stop = asyncio.Event() if False else None  # created inside main()
CLIENTS: Dict[str, "AccountWorker"] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(msg: str) -> None:
    print(f"[runner] {msg}", flush=True)


# ---------------------------------------------------------------------------
# DB helpers — a tiny wrapper. Every write opens its own short-lived
# connection so we never hold the SQLite file lock.
# ---------------------------------------------------------------------------

def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def db_all(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with db_connect() as c:
        return c.execute(sql, params).fetchall()


def db_one(sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
    with db_connect() as c:
        return c.execute(sql, params).fetchone()


import re as _re
_TABLE_RE = _re.compile(r"^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([\w.]+)", _re.I)


def _emit_change(sql: str) -> None:
    m = _TABLE_RE.match(sql or "")
    if m:
        print(f"#CHANGE {m.group(1)}", flush=True)


def db_exec(sql: str, params: tuple = ()) -> None:
    with db_connect() as c:
        c.execute(sql, params)
    _emit_change(sql)



def ensure_outbound_table() -> None:
    with db_connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS outbound_messages (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                conversation_id TEXT,
                recipient_phone TEXT,
                recipient_username TEXT,
                recipient_telegram_id INTEGER,
                content TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                failed_reason TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                sent_at TEXT
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_messages(status)")


# ---------------------------------------------------------------------------
# Per-account worker
# ---------------------------------------------------------------------------

class AccountWorker:
    def __init__(self, row: sqlite3.Row):
        self.id: str = row["id"]
        self.phone: str = row["phone_number"]
        self.api_id: Optional[str] = row["api_id"]
        self.api_hash: Optional[str] = row["api_hash"]
        self.session_data: Optional[str] = row["session_data"]
        self.proxy_id: Optional[str] = row["proxy_id"]
        self.device_model = row["device_model"] or "PC"
        self.system_version = row["system_version"] or "Windows 10"
        self.app_version = row["app_version"] or "1.0"
        self.lang_code = row["lang_code"] or "en"
        self.system_lang_code = row["system_lang_code"] or "en"
        self.client: Optional[TelegramClient] = None
        self.connected: bool = False
        self.last_error: Optional[str] = None

    def _resolve_api(self) -> tuple[Optional[str], Optional[str]]:
        if self.api_id and self.api_hash:
            return self.api_id, self.api_hash
        row = db_one(
            "SELECT api_id, api_hash FROM telegram_api_credentials WHERE id = "
            "(SELECT api_credential_id FROM telegram_accounts WHERE id = ?)",
            (self.id,),
        )
        if row:
            return row["api_id"], row["api_hash"]
        return None, None

    def _resolve_proxy(self):
        if not self.proxy_id:
            return None
        row = db_one("SELECT * FROM proxies WHERE id = ?", (self.proxy_id,))
        if not row:
            return None
        try:
            import socks  # type: ignore
        except Exception:
            import python_socks  # type: ignore
            # Telethon accepts (type, host, port, user, pass, rdns) tuples too.
        ptype = (row["proxy_type"] or "socks5").lower()
        proxy_kind = 2  # SOCKS5
        if ptype == "socks4":
            proxy_kind = 1
        elif ptype in ("http", "https"):
            proxy_kind = 3
        return (
            proxy_kind,
            row["host"],
            int(row["port"]),
            True,
            row["username"] or None,
            row["password"] or None,
        )

    async def connect(self) -> bool:
        api_id, api_hash = self._resolve_api()
        if not api_id or not api_hash:
            self.last_error = "missing api_id/api_hash"
            self._mark("disconnected", self.last_error)
            return False

        # Prefer file session under SESSIONS_DIR; fall back to StringSession blob.
        session_path = os.path.join(SESSIONS_DIR, f"{self.phone.lstrip('+')}.session")
        session: Any = session_path
        if not os.path.exists(session_path) and self.session_data:
            try:
                session = StringSession(self.session_data)
            except Exception:
                session = session_path

        proxy = None
        try:
            proxy = self._resolve_proxy()
        except Exception as e:
            _log(f"{self.phone}: proxy resolve failed: {e}")

        try:
            self.client = TelegramClient(
                session,
                int(api_id),
                api_hash,
                device_model=self.device_model,
                system_version=self.system_version,
                app_version=self.app_version,
                lang_code=self.lang_code,
                system_lang_code=self.system_lang_code,
                proxy=proxy,
                connection_retries=3,
                retry_delay=2,
                timeout=15,
            )
            await self.client.connect()
            if not await self.client.is_user_authorized():
                self.last_error = "not authorized (needs login)"
                self._mark("disconnected", self.last_error)
                await self._safe_disconnect()
                return False
            me = await self.client.get_me()
            self.connected = True
            self.last_error = None
            with db_connect() as c:
                c.execute(
                    """
                    UPDATE telegram_accounts
                    SET status = 'active',
                        last_active = ?,
                        telegram_id = COALESCE(?, telegram_id),
                        username = COALESCE(?, username),
                        first_name = COALESCE(?, first_name),
                        last_name = COALESCE(?, last_name),
                        disabled_reason = NULL,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        _now(),
                        getattr(me, "id", None),
                        getattr(me, "username", None),
                        getattr(me, "first_name", None),
                        getattr(me, "last_name", None),
                        _now(),
                        self.id,
                    ),
                )
            print("#CHANGE telegram_accounts", flush=True)

            self._register_handlers()
            _log(f"{self.phone}: connected as @{getattr(me, 'username', None) or me.id}")
            return True
        except errors.rpcerrorlist.UserDeactivatedBanError:
            self.last_error = "banned"
            self._mark("frozen", self.last_error)
        except errors.rpcerrorlist.AuthKeyUnregisteredError:
            self.last_error = "auth key unregistered"
            self._mark("frozen", self.last_error)
        except errors.rpcerrorlist.PhoneNumberBannedError:
            self.last_error = "phone banned"
            self._mark("frozen", self.last_error)
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            self._mark("disconnected", self.last_error)
        await self._safe_disconnect()
        return False

    def _mark(self, status: str, reason: Optional[str]) -> None:
        db_exec(
            "UPDATE telegram_accounts SET status = ?, disabled_reason = ?, updated_at = ? WHERE id = ?",
            (status, reason, _now(), self.id),
        )

    async def _safe_disconnect(self) -> None:
        self.connected = False
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
            self.client = None

    def _register_handlers(self) -> None:
        if not self.client or not events:
            return

        @self.client.on(events.NewMessage(incoming=True))
        async def _incoming(evt):  # noqa: ANN001
            try:
                await self._on_incoming(evt)
            except Exception as e:
                _log(f"{self.phone}: incoming handler error: {e}")

    async def _on_incoming(self, evt) -> None:  # noqa: ANN001
        try:
            sender = await evt.get_sender()
        except Exception:
            sender = None
        tg_id = getattr(sender, "id", None) or evt.chat_id
        username = getattr(sender, "username", None)
        first_name = getattr(sender, "first_name", None)
        last_name = getattr(sender, "last_name", None)
        display = " ".join(x for x in [first_name, last_name] if x) or username or str(tg_id)

        # Find/create conversation for (account_id, telegram_id)
        row = db_one(
            "SELECT id FROM conversations WHERE account_id = ? AND recipient_telegram_id = ?",
            (self.id, tg_id),
        )
        if row:
            conv_id = row["id"]
        else:
            conv_id = str(uuid.uuid4())
            db_exec(
                """
                INSERT INTO conversations
                    (id, account_id, recipient_telegram_id, recipient_username,
                     recipient_name, unread_count, last_message_at, last_message_content,
                     last_message_direction, has_reply, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'incoming', 1, ?, ?)
                """,
                (conv_id, self.id, tg_id, username, display, _now(),
                 (evt.raw_text or "")[:200], _now(), _now()),
            )

        content = evt.raw_text or ""
        db_exec(
            """
            INSERT INTO messages
                (id, account_id, conversation_id, telegram_message_id, content,
                 direction, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'incoming', 'delivered', ?)
            """,
            (str(uuid.uuid4()), self.id, conv_id, evt.id, content, _now()),
        )
        db_exec(
            """
            UPDATE conversations
            SET unread_count = unread_count + 1,
                last_message_at = ?,
                last_message_content = ?,
                last_message_direction = 'incoming',
                has_reply = 1,
                updated_at = ?
            WHERE id = ?
            """,
            (_now(), content[:200], _now(), conv_id),
        )

    async def send_text(self, target: str | int, text: str) -> tuple[bool, Optional[int], Optional[str]]:
        if not self.client or not self.connected:
            return False, None, "not connected"
        try:
            entity = await self.client.get_entity(target)
            msg = await self.client.send_message(entity, text)
            return True, msg.id, None
        except errors.rpcerrorlist.FloodWaitError as e:
            secs = int(getattr(e, "seconds", 60))
            until = datetime.fromtimestamp(time.time() + secs, tz=timezone.utc).isoformat()
            db_exec(
                "UPDATE telegram_accounts SET restricted_until = ?, updated_at = ? WHERE id = ?",
                (until, _now(), self.id),
            )
            return False, None, f"FloodWait {secs}s"
        except errors.rpcerrorlist.PeerFloodError:
            db_exec(
                "UPDATE telegram_accounts SET auto_disabled = 1, disabled_reason = ?, updated_at = ? WHERE id = ?",
                ("PeerFlood", _now(), self.id),
            )
            return False, None, "PeerFlood"
        except Exception as e:
            return False, None, f"{type(e).__name__}: {e}"

    async def ping(self) -> bool:
        if not self.client:
            return False
        try:
            if not self.client.is_connected():
                await self.client.connect()
            await self.client.get_me()
            self.connected = True
            db_exec(
                "UPDATE telegram_accounts SET last_active = ?, updated_at = ? WHERE id = ?",
                (_now(), _now(), self.id),
            )
            return True
        except Exception as e:
            self.connected = False
            self.last_error = f"{type(e).__name__}: {e}"
            self._mark("disconnected", self.last_error)
            return False


# ---------------------------------------------------------------------------
# Supervisor
# ---------------------------------------------------------------------------

async def load_accounts() -> list[sqlite3.Row]:
    return db_all(
        """
        SELECT * FROM telegram_accounts
        WHERE COALESCE(auto_disabled, 0) = 0
          AND COALESCE(status, '') NOT IN ('frozen', 'banned')
        """
    )


async def connect_all(stop: asyncio.Event) -> None:
    rows = await load_accounts()
    _log(f"connecting {len(rows)} account(s)")
    # Cap concurrent connect attempts.
    sem = asyncio.Semaphore(10)

    async def worker(row: sqlite3.Row) -> None:
        async with sem:
            if stop.is_set():
                return
            aw = AccountWorker(row)
            ok = await aw.connect()
            if ok:
                CLIENTS[aw.id] = aw

    await asyncio.gather(*(worker(r) for r in rows), return_exceptions=True)
    _log(f"connected {len(CLIENTS)}/{len(rows)} account(s)")


async def keepalive_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        for aw in list(CLIENTS.values()):
            if stop.is_set():
                break
            if not await aw.ping():
                # try reconnect
                await aw._safe_disconnect()
                await aw.connect()
        try:
            await asyncio.wait_for(stop.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass


async def reconcile_loop(stop: asyncio.Event) -> None:
    """Pick up newly-added or re-enabled accounts."""
    while not stop.is_set():
        try:
            rows = await load_accounts()
            known = set(CLIENTS.keys())
            for row in rows:
                if row["id"] in known:
                    continue
                aw = AccountWorker(row)
                if await aw.connect():
                    CLIENTS[aw.id] = aw
            # drop workers whose account was disabled
            for aid in list(CLIENTS.keys()):
                if not any(r["id"] == aid for r in rows):
                    aw = CLIENTS.pop(aid, None)
                    if aw:
                        await aw._safe_disconnect()
        except Exception as e:
            _log(f"reconcile error: {e}")
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
        except asyncio.TimeoutError:
            pass


async def sender_loop(stop: asyncio.Event) -> None:
    """Drain campaign_recipients (pending) and outbound_messages."""
    while not stop.is_set():
        try:
            await _drain_campaigns()
            await _drain_outbound()
        except Exception as e:
            _log(f"sender error: {e}\n{traceback.format_exc()}")
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass


async def tasks_loop(stop: asyncio.Event) -> None:
    """Process account_check_tasks, block_contact_tasks, contact_import_tasks."""
    try:
        from tasks import HANDLERS, block_contact, import_contacts  # type: ignore
    except Exception as e:
        _log(f"tasks module unavailable: {e}")
        return
    while not stop.is_set():
        try:
            await _drain_account_check_tasks(HANDLERS)
            await _drain_block_tasks(block_contact)
            await _drain_import_tasks(import_contacts)
        except Exception as e:
            _log(f"tasks error: {e}\n{traceback.format_exc()}")
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass


def _parse_result_params(raw) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else dict(raw)
    except Exception:
        return {}


async def _drain_account_check_tasks(handlers) -> None:
    rows = db_all(
        "SELECT * FROM account_check_tasks WHERE status='pending' ORDER BY created_at LIMIT 25"
    )
    for r in rows:
        ttype = r["task_type"]
        handler = handlers.get(ttype)
        if not handler:
            db_exec(
                "UPDATE account_check_tasks SET status='failed', result=?, completed_at=?, updated_at=? WHERE id=?",
                (json.dumps({"error": f"unknown task_type {ttype}"}), _now(), _now(), r["id"]),
            )
            continue
        aw = CLIENTS.get(r["account_id"])
        if not aw or not aw.connected:
            continue  # try again once account is online
        # claim
        db_exec(
            "UPDATE account_check_tasks SET status='running', updated_at=? WHERE id=? AND status='pending'",
            (_now(), r["id"]),
        )
        params = _parse_result_params(r["result"])
        try:
            result = await handler(aw, params, FILES_DIR)
            db_exec(
                "UPDATE account_check_tasks SET status='completed', result=?, completed_at=?, updated_at=? WHERE id=?",
                (json.dumps(result, default=str), _now(), _now(), r["id"]),
            )
            # sync_profile also writes back to telegram_accounts
            if ttype == "sync_profile" and isinstance(result, dict):
                db_exec(
                    """UPDATE telegram_accounts SET username=COALESCE(?,username),
                       first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name),
                       telegram_id=COALESCE(?,telegram_id), updated_at=? WHERE id=?""",
                    (result.get("username"), result.get("first_name"),
                     result.get("last_name"), result.get("id"), _now(), aw.id),
                )
            if ttype == "spambot_check" and isinstance(result, dict):
                db_exec(
                    "UPDATE telegram_accounts SET spambot_status=?, last_spambot_check=?, updated_at=? WHERE id=?",
                    (result.get("status"), _now(), _now(), aw.id),
                )
            _log(f"{aw.phone}: task {ttype} OK")
        except Exception as e:
            db_exec(
                "UPDATE account_check_tasks SET status='failed', result=?, completed_at=?, updated_at=? WHERE id=?",
                (json.dumps({"error": f"{type(e).__name__}: {e}"}), _now(), _now(), r["id"]),
            )
            _log(f"{aw.phone}: task {ttype} FAILED: {e}")


async def _drain_block_tasks(handler) -> None:
    rows = db_all(
        "SELECT * FROM block_contact_tasks WHERE status='pending' ORDER BY created_at LIMIT 25"
    )
    for r in rows:
        aw = CLIENTS.get(r["account_id"])
        if not aw or not aw.connected:
            continue
        db_exec("UPDATE block_contact_tasks SET status='running' WHERE id=?", (r["id"],))
        try:
            result = await handler(aw, {
                "action": r["action"],
                "target_phone": r["target_phone"],
                "target_username": r["target_username"],
                "target_telegram_id": r["target_telegram_id"],
            }, FILES_DIR)
            db_exec(
                "UPDATE block_contact_tasks SET status='completed', result=?, completed_at=? WHERE id=?",
                (json.dumps(result), _now(), r["id"]),
            )
        except Exception as e:
            db_exec(
                "UPDATE block_contact_tasks SET status='failed', result=?, completed_at=? WHERE id=?",
                (json.dumps({"error": str(e)}), _now(), r["id"]),
            )


async def _drain_import_tasks(handler) -> None:
    rows = db_all(
        "SELECT * FROM contact_import_tasks WHERE status='pending' ORDER BY created_at LIMIT 5"
    )
    for r in rows:
        aw = CLIENTS.get(r["account_id"])
        if not aw or not aw.connected:
            continue
        db_exec("UPDATE contact_import_tasks SET status='running', current_account_id=? WHERE id=?",
                (aw.id, r["id"]))
        try:
            phones = json.loads(r["phone_numbers"] or "[]")
            result = await handler(aw, {"phone_numbers": phones}, FILES_DIR)
            db_exec(
                """UPDATE contact_import_tasks SET status='completed', result=?,
                   valid_numbers=?, completed_at=? WHERE id=?""",
                (json.dumps(result), json.dumps(result.get("phones", [])), _now(), r["id"]),
            )
        except Exception as e:
            db_exec(
                "UPDATE contact_import_tasks SET status='failed', result=?, completed_at=? WHERE id=?",
                (json.dumps({"error": str(e)}), _now(), r["id"]),
            )



async def _drain_campaigns() -> None:
    rows = db_all(
        """
        SELECT r.*, c.message_template
        FROM campaign_recipients r
        JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.status = 'pending' AND c.status = 'running'
        ORDER BY r.scheduled_at NULLS FIRST
        LIMIT 25
        """
    )
    for r in rows:
        acct_id = r["sent_by_account_id"]
        aw = CLIENTS.get(acct_id) if acct_id else None
        if not aw:
            # pick any online account
            aw = next(iter(CLIENTS.values()), None)
        if not aw:
            return
        # claim
        db_exec(
            "UPDATE campaign_recipients SET status='sending', sending_started_at=?, sent_by_account_id=? WHERE id=? AND status='pending'",
            (_now(), aw.id, r["id"]),
        )
        text = (r["message_template"] or "").replace("{name}", r["name"] or "")
        ok, msg_id, err = await aw.send_text(r["phone_number"], text)
        if ok:
            db_exec(
                "UPDATE campaign_recipients SET status='sent', sent_at=? WHERE id=?",
                (_now(), r["id"]),
            )
            db_exec(
                "UPDATE campaigns SET sent_count = COALESCE(sent_count,0) + 1 WHERE id=?",
                (r["campaign_id"],),
            )
            db_exec(
                "UPDATE telegram_accounts SET messages_sent_today = COALESCE(messages_sent_today,0)+1, success_count = COALESCE(success_count,0)+1, last_campaign_send_at=?, updated_at=? WHERE id=?",
                (_now(), _now(), aw.id),
            )
        else:
            db_exec(
                "UPDATE campaign_recipients SET status='failed', failed_reason=?, retry_count=COALESCE(retry_count,0)+1 WHERE id=?",
                (err, r["id"]),
            )
            db_exec(
                "UPDATE campaigns SET failed_count = COALESCE(failed_count,0) + 1 WHERE id=?",
                (r["campaign_id"],),
            )
            db_exec(
                "UPDATE telegram_accounts SET failure_count = COALESCE(failure_count,0)+1, updated_at=? WHERE id=?",
                (_now(), aw.id),
            )


async def _drain_outbound() -> None:
    rows = db_all("SELECT * FROM outbound_messages WHERE status='pending' LIMIT 25")
    for r in rows:
        aw = CLIENTS.get(r["account_id"])
        if not aw:
            continue
        db_exec("UPDATE outbound_messages SET status='sending' WHERE id=?", (r["id"],))
        target: Any = (
            r["recipient_telegram_id"]
            or r["recipient_username"]
            or r["recipient_phone"]
        )
        ok, msg_id, err = await aw.send_text(target, r["content"])
        if ok:
            db_exec(
                "UPDATE outbound_messages SET status='sent', sent_at=? WHERE id=?",
                (_now(), r["id"]),
            )
            if r["conversation_id"]:
                db_exec(
                    """
                    INSERT INTO messages (id, account_id, conversation_id, telegram_message_id,
                        content, direction, status, created_at)
                    VALUES (?, ?, ?, ?, ?, 'outgoing', 'sent', ?)
                    """,
                    (str(uuid.uuid4()), aw.id, r["conversation_id"], msg_id, r["content"], _now()),
                )
                db_exec(
                    """
                    UPDATE conversations SET last_message_at=?, last_message_content=?,
                        last_message_direction='outgoing', updated_at=? WHERE id=?
                    """,
                    (_now(), (r["content"] or "")[:200], _now(), r["conversation_id"]),
                )
        else:
            db_exec(
                "UPDATE outbound_messages SET status='failed', failed_reason=? WHERE id=?",
                (err, r["id"]),
            )


async def heartbeat_loop(stop: asyncio.Event) -> None:
    tick = 0
    while not stop.is_set():
        tick += 1
        online = sum(1 for aw in CLIENTS.values() if aw.connected)
        _log(f"heartbeat {tick} online={online}/{len(CLIENTS)}")
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def async_main() -> int:
    if TelegramClient is None:
        # Idle so Electron still reports "running" while we're unusable.
        _log("Telethon unavailable — idling. Install runner deps.")
        while True:
            await asyncio.sleep(30)

    if not DB_PATH or not os.path.exists(DB_PATH):
        _log(f"FATAL: DB_PATH invalid: {DB_PATH!r}")
        return 2

    os.makedirs(SESSIONS_DIR, exist_ok=True) if SESSIONS_DIR else None
    ensure_outbound_table()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _signal(*_):
        _log("shutdown signal received")
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal)
        except (NotImplementedError, RuntimeError):
            signal.signal(sig, lambda *_: stop.set())

    _log(f"starting python={sys.version.split()[0]}")
    _log(f"db={DB_PATH}")
    _log(f"sessions={SESSIONS_DIR}")

    await connect_all(stop)

    tasks = [
        asyncio.create_task(heartbeat_loop(stop)),
        asyncio.create_task(keepalive_loop(stop)),
        asyncio.create_task(reconcile_loop(stop)),
        asyncio.create_task(sender_loop(stop)),
        asyncio.create_task(tasks_loop(stop)),
    ]

    await stop.wait()
    _log("stopping workers…")
    for t in tasks:
        t.cancel()
    for aw in list(CLIENTS.values()):
        await aw._safe_disconnect()
    _log("stopped")
    return 0


def main() -> int:
    try:
        return asyncio.run(async_main())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
