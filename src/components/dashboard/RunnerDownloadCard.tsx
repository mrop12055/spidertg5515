import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';

const RunnerDownloadCard: React.FC = () => {

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  // ========== ULTRA-SIMPLIFIED RUNNER ==========
  // Campaign = send message, Conversation = send message, Warmup = send message
  // They're ALL the same: send_message(account, recipient, content)
  const runnerBuild = "2026-07-03-optional-proxy-v15";

  const unifiedRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - ULTRA-SIMPLIFIED RUNNER
=====================================
BUILD: ${runnerBuild}

TRUTH: Campaign, Conversations, Warmup are ALL the same thing.
       They all just SEND MESSAGES from an account to a recipient.

ONLY 2 CORE FUNCTIONS:
  1. send_message(client, recipient, content) - ALL sending operations
  2. account_action(client, action, params) - Non-message actions

Install: pip install telethon httpx pysocks
Usage: python unified_runner.py
"""

import os
import sys
import base64
import tempfile
import asyncio
import httpx
import socks
import threading
import random
import time
import signal
import traceback as tb_module
from typing import Dict, Optional, List, Any, Tuple
from collections import defaultdict

# ========== GLOBAL CRASH HANDLER ==========
# Catches crashes in background threads (e.g. Telethon update loops)
def _global_thread_exception(args):
    print(f"\\n{'='*50}")
    print(f"  [THREAD-CRASH] Unhandled exception in thread: {args.thread.name if args.thread else 'unknown'}")
    print(f"  Exception type: {args.exc_type.__name__}")
    print(f"  Exception: {args.exc_value}")
    tb_module.print_exception(args.exc_type, args.exc_value, args.exc_traceback)
    sys.stdout.flush()
    sys.stderr.flush()
    print(f"{'='*50}")
    sys.stdout.flush()

threading.excepthook = _global_thread_exception

def _asyncio_exception_handler(loop, context):
    msg = context.get("message", "No message")
    exc = context.get("exception")
    
    # Silently ignore known transient networking errors (proxy/VPS instability)
    if exc:
        exc_name = type(exc).__name__
        err_str = str(exc)
        # IncompleteReadError = MTProto handshake cut by proxy mid-frame; Telethon auto-reconnects
        if exc_name in ("IncompleteReadError", "ConnectionResetError", "ConnectionAbortedError", "TimeoutError"):
            print(f"  [NET] {exc_name} (proxy dropped connection) - Telethon will reconnect")
            sys.stdout.flush()
            return
        if isinstance(exc, OSError):
            if "WinError 121" in err_str or "semaphore timeout" in err_str.lower():
                print(f"  [NET] Windows semaphore timeout (proxy/network glitch) - ignored")
                sys.stdout.flush()
                return
            if "WinError 10054" in err_str or "WinError 10053" in err_str or "forcibly closed" in err_str.lower():
                print(f"  [NET] Connection reset by proxy - Telethon will reconnect")
                sys.stdout.flush()
                return
        # "shielded future" wrapping is just noise; check the underlying message
        if "shielded future" in str(context.get("message", "")).lower() and exc_name == "IncompleteReadError":
            return
    
    print(f"\\n{'='*50}")
    print(f"  [ASYNCIO-CRASH] Unhandled asyncio exception: {msg}")
    if exc:
        print(f"  Exception type: {type(exc).__name__}")
        print(f"  Exception: {exc}")
        tb_module.print_exception(type(exc), exc, exc.__traceback__)
    sys.stdout.flush()
    sys.stderr.flush()
    print(f"{'='*50}")
    sys.stdout.flush()

# ========== CONFIG ==========
BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
BUILD_VERSION = "${runnerBuild}"

# ========== STATE ==========
SESSION_FOLDER = tempfile.mkdtemp(prefix="tg_")
clients: Dict[str, Any] = {}      # account_id -> TelegramClient
accounts: Dict[str, dict] = {}    # account_id -> account info
RUNNING = True

# Unique instance ID to detect multiple runners fighting over same accounts
import uuid as _uuid_mod
RUNNER_INSTANCE_ID = str(_uuid_mod.uuid4())[:8]

# Track processed message IDs to avoid re-sending to backend
# Key format: "{account_id}_{telegram_message_id}"
processed_message_ids = set()

# Track when the runner was last offline (fetched from backend)
last_offline_at: Optional[str] = None

_locks: Dict[str, asyncio.Lock] = {}
_locks_mutex = threading.Lock()
_http: Optional[httpx.AsyncClient] = None


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except Exception:
        value = default
    return max(minimum, min(maximum, value))


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except Exception:
        value = default
    return max(minimum, min(maximum, value))


# Residential/mobile proxies often fail when too many MTProto handshakes start at once.
# Defaults are conservative; override with env vars if your provider can handle more.
CONNECT_CONCURRENCY = _env_int("TG_CONNECT_CONCURRENCY", 5, 1, 15)
CONNECT_TIMEOUT_SECONDS = _env_int("TG_CONNECT_TIMEOUT_SECONDS", 90, 30, 180)
CONNECT_BATCH_PAUSE_SECONDS = _env_float("TG_CONNECT_BATCH_PAUSE_SECONDS", 2.0, 0.0, 30.0)


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== TELETHON ==========
try:
    from telethon import TelegramClient, events
    from telethon.errors import (
        FloodWaitError, UserPrivacyRestrictedError, PeerFloodError,
        UserBlockedError, ChatWriteForbiddenError, AuthKeyUnregisteredError,
        SessionRevokedError, UserDeactivatedBanError, PhoneNumberBannedError
    )
    try:
        from telethon.errors import PersistentTimestampOutdatedError
    except ImportError:
        class PersistentTimestampOutdatedError(Exception):
            pass
    from telethon.tl.functions.contacts import ResolvePhoneRequest, ImportContactsRequest
    from telethon.tl.functions.messages import SendMessageRequest, SendReactionRequest
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.tl.functions.account import UpdateProfileRequest
    from telethon.tl.types import InputPhoneContact, InputPeerUser, ReactionEmoji, User
except ImportError:
    print("ERROR: pip install telethon httpx pysocks")
    sys.exit(1)


# ==============================================================================
# HELPERS
# ==============================================================================

def get_lock(aid: str) -> asyncio.Lock:
    with _locks_mutex:
        if aid not in _locks:
            _locks[aid] = asyncio.Lock()
        return _locks[aid]


def get_http() -> httpx.AsyncClient:
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(timeout=45, limits=httpx.Limits(max_connections=500))
    return _http


def decode_session(phone: str, b64: str) -> Optional[str]:
    path = os.path.join(SESSION_FOLDER, phone.replace("+", ""))
    session_file = path + ".session"
    try:
        raw = base64.b64decode(b64)
        # Skip rewrite if file already exists with identical content
        # Prevents corruption when parallel tasks decode the same session
        if os.path.exists(session_file):
            with open(session_file, "rb") as f:
                existing = f.read()
            if existing == raw:
                return path
        with open(session_file, "wb") as f:
            f.write(raw)
        return path
    except:
        return None


def get_proxy(acc: dict) -> Optional[tuple]:
    p = acc.get("proxies") or acc.get("proxy")
    if not p or not p.get("host"):
        return None
    ptype = socks.SOCKS5 if (p.get("proxy_type") or "socks5").lower() == "socks5" else socks.HTTP
    if p.get("username"):
        return (ptype, p["host"], int(p["port"]), True, p["username"], p["password"])
    return (ptype, p["host"], int(p["port"]))


def variate(text: str) -> str:
    """Add invisible char to make message unique."""
    pos = random.randint(0, len(text))
    return text[:pos] + random.choice(['\\u200b', '\\u200c', '\\u200d']) + text[pos:]


# ==============================================================================
# API
# ==============================================================================

async def report(task_type: str, data: dict):
    """Report task result to unified endpoint."""
    try:
        await get_http().post(
            f"{BACKEND_URL}/runner-tasks/report",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"results": [{"task_type": task_type, **data}]}, timeout=30
        )
    except:
        pass


async def update_account_status(acc_id: str, status: str, reason: str = None, auto_disabled: bool = False):
    """Update account status in database when connection fails/succeeds."""
    try:
        data = {"status": status}
        if reason:
            data["disabled_reason"] = reason[:200]
        if auto_disabled:
            data["auto_disabled"] = True
        
        await get_http().patch(
            f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{acc_id}",
            headers={
                "apikey": SUPABASE_KEY, 
                "Authorization": f"Bearer {SUPABASE_KEY}", 
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            json=data, timeout=15
        )
    except:
        pass


async def update_proxy_status(proxy_id: str, status: str, error_msg: str = None):
    """Update proxy status when connection fails."""
    try:
        await get_http().patch(
            f"{SUPABASE_URL}/rest/v1/proxies?id=eq.{proxy_id}",
            headers={
                "apikey": SUPABASE_KEY, 
                "Authorization": f"Bearer {SUPABASE_KEY}", 
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            json={"status": status}, timeout=15
        )
        
        # Log proxy error if there's an error message
        if error_msg:
            await get_http().post(
                f"{SUPABASE_URL}/rest/v1/proxy_errors",
                headers={
                    "apikey": SUPABASE_KEY, 
                    "Authorization": f"Bearer {SUPABASE_KEY}", 
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal"
                },
                json={"proxy_id": proxy_id, "error_type": "connection", "error_message": error_msg[:200]}, timeout=15
            )
    except:
        pass


async def lock_accounts(account_ids: list):
    """Lock accounts in DB so no other runner instance can connect them."""
    if not account_ids:
        return
    try:
        await get_http().post(
            f"{BACKEND_URL}/runner-tasks/lock",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"account_ids": account_ids, "server_id": RUNNER_INSTANCE_ID}, timeout=15
        )
        print(f"  [SESSION-LOCK] Locked {len(account_ids)} accounts for instance {RUNNER_INSTANCE_ID}")
    except Exception as e:
        print(f"  [SESSION-LOCK] Lock failed: {e}")


async def unlock_all_accounts():
    """Release all account locks held by this runner instance."""
    try:
        await get_http().post(
            f"{BACKEND_URL}/runner-tasks/unlock",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"server_id": RUNNER_INSTANCE_ID}, timeout=15
        )
        print(f"  [SESSION-LOCK] Unlocked all accounts for instance {RUNNER_INSTANCE_ID}")
    except Exception as e:
        print(f"  [SESSION-LOCK] Unlock failed: {e}")


async def get_tasks(include_accounts: bool = True) -> dict:
    """Fetch tasks from backend. Accounts payload can be disabled to avoid huge responses."""
    try:
        r = await get_http().post(
            f"{BACKEND_URL}/runner-tasks/get",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"runner": "unified", "include_accounts": include_accounts, "server_id": RUNNER_INSTANCE_ID}, timeout=60
        )
        data = r.json() if r.status_code == 200 else {"tasks": [], "accounts": []}
        
        # DUPLICATE RUNNER GUARD: If backend says another instance is active, EXIT immediately
        if data.get("duplicate_runner"):
            print(f"\\n{'='*50}")
            print(f"  ⛔ DUPLICATE RUNNER BLOCKED!")
            print(f"  Another instance ({data.get('active_instance', '?')}) is already running.")
            print(f"  This instance ({RUNNER_INSTANCE_ID}) will now EXIT.")
            print(f"  {data.get('message', '')}")
            print(f"{'='*50}\\n")
            sys.stdout.flush()
            os._exit(1)
        
        return data
    except:
        return {"tasks": [], "accounts": []}


# ==============================================================================
# CORE FUNCTION 1: SEND MESSAGE
# ==============================================================================
# Campaign sends message. Conversation sends message. Warmup sends message.
# They're ALL the same. One function handles everything.

async def send_message(client, recipient: str, content: str, media_url: str = None) -> Tuple[bool, Optional[str], dict]:
    """
    THE ONLY SEND FUNCTION.
    Campaign? This function. Conversation reply? This function. Warmup? This function.
    """
    if not recipient:
        return False, "No recipient", {}
    
    try:
        entity = None
        
        # Try to get entity
        try:
            entity = await asyncio.wait_for(client.get_input_entity(recipient), timeout=5)
        except:
            pass
        
        # Phone resolution
        if not entity and (recipient.startswith("+") or recipient.isdigit()):
            phone = recipient if recipient.startswith("+") else f"+{recipient}"
            
            # First try ResolvePhoneRequest (works if user allows phone lookup)
            try:
                result = await asyncio.wait_for(client(ResolvePhoneRequest(phone=phone)), timeout=10)
                if result.users:
                    u = result.users[0]
                    entity = InputPeerUser(user_id=u.id, access_hash=u.access_hash)
            except Exception as e:
                err_str = str(e).upper()
                if "PHONE_NOT_OCCUPIED" in err_str:
                    return False, "Not on Telegram", {}
                # For any other error (privacy, not found, etc.), try importing contact
                pass
            
            # If ResolvePhone didn't work, try ImportContacts (works for most numbers)
            if not entity:
                try:
                    contact = InputPhoneContact(
                        client_id=random.randint(0, 2**31-1), 
                        phone=phone, 
                        first_name=phone.replace("+", "")[-10:],  # Last 10 digits as name
                        last_name=""
                    )
                    result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
                    if result.users:
                        u = result.users[0]
                        entity = InputPeerUser(user_id=u.id, access_hash=u.access_hash)
                        print(f"    [CONTACT] Imported {phone} → User {u.id}")
                    elif result.imported:
                        # Contact imported but user list empty - try getting entity now
                        try:
                            entity = await asyncio.wait_for(client.get_input_entity(phone), timeout=5)
                        except:
                            pass
                except Exception as e:
                    print(f"    [CONTACT] Import failed for {phone}: {str(e)[:500]}")
        
        if not entity:
            return False, "Recipient not found", {}
        
        text = variate(content) if content else ""
        
        # Send with media
        if media_url and text:
            try:
                r = await get_http().get(media_url, timeout=60)
                if r.status_code == 200:
                    import io
                    f = io.BytesIO(r.content)
                    f.name = "file.jpg"
                    await asyncio.wait_for(client.send_file(entity, f, caption=text), timeout=30)
                    return True, None, {"recipient_telegram_id": entity.user_id if isinstance(entity, InputPeerUser) else None}
            except:
                pass
        
        # Text only
        if isinstance(entity, InputPeerUser):
            await asyncio.wait_for(client(SendMessageRequest(peer=entity, message=text, no_webpage=False, random_id=random.randint(0,2**63-1))), timeout=10)
        else:
            await asyncio.wait_for(client.send_message(entity, text), timeout=10)
        
        return True, None, {"recipient_telegram_id": entity.user_id if isinstance(entity, InputPeerUser) else None}
        
    except FloodWaitError as e:
        return False, f"FloodWait:{e.seconds}s", {"skip_account": True}
    except PeerFloodError:
        return False, "PeerFlood", {"skip_account": True}
    except UserPrivacyRestrictedError:
        return False, "Privacy restricted", {}
    except UserBlockedError:
        return False, "Blocked", {}
    except Exception as e:
        return False, str(e)[:80], {}


# ==============================================================================
# CORE FUNCTION 2: ACCOUNT ACTION (ALL ACTIONS)
# ==============================================================================
# Everything that's NOT sending a message: profile changes, contacts, channels, etc.

async def account_action(client, action: str, task: dict) -> Tuple[bool, Optional[str]]:
    """
    ALL ACCOUNT ACTIONS IN ONE FUNCTION:
    - Profile: change_name, change_photo, change_bio, change_username
    - Contacts: add_contact, delete_contact, block_contact, unblock_contact
    - Channels: join_channel, leave_channel, react
    - Checks: spambot_check, session_check
    """
    task_id = task.get("task_id") or task.get("id")
    acc_id = task.get("account", {}).get("id") or task.get("account_id")
    td = task.get("task_data", {})
    phone = accounts.get(acc_id, {}).get("phone_number", "????")[-4:]
    
    try:
        # ==========================================================
        # PROFILE ACTIONS
        # ==========================================================
        
        if action == "change_name":
            fn = task.get("first_name") or td.get("first_name", "")
            ln = task.get("last_name") or td.get("last_name", "")
            print(f"  [NAME] [{phone}] → {fn} {ln}")
            await client(UpdateProfileRequest(first_name=fn, last_name=ln))
            await report("change_name", {"task_id": task_id, "account_id": acc_id, "success": True, "first_name": fn, "last_name": ln})
            return True, None
        
        elif action == "change_photo":
            photo_url = task.get("photo_url") or td.get("photo_url")
            print(f"  [PHOTO] [{phone}] Updating...")
            if photo_url:
                from telethon.tl.functions.photos import UploadProfilePhotoRequest, DeletePhotosRequest
                from telethon.tl.functions.users import GetFullUserRequest
                
                # Download photo
                r = await get_http().get(photo_url, timeout=60)
                if r.status_code == 200:
                    import io
                    import os
                    # Telegram requires a file with proper extension
                    # Extract extension from URL or default to .jpg
                    ext = os.path.splitext(photo_url.split('?')[0])[1].lower()
                    if ext not in ('.jpg', '.jpeg', '.png'):
                        ext = '.jpg'
                    
                    # Create file-like object with proper name attribute
                    photo_bytes = io.BytesIO(r.content)
                    photo_bytes.name = f"photo{ext}"
                    photo_file = await client.upload_file(photo_bytes)
                    
                    # Delete old photos first (optional)
                    try:
                        full = await client(GetFullUserRequest("me"))
                        if full.full_user.profile_photo:
                            await client(DeletePhotosRequest([full.full_user.profile_photo]))
                    except:
                        pass
                    
                    # Upload new photo
                    await client(UploadProfilePhotoRequest(file=photo_file))
                    await report("change_photo", {"task_id": task_id, "account_id": acc_id, "success": True})
                    print(f"  [PHOTO] [{phone}] ✓ Updated")
                    return True, None
            return False, "No photo URL"
        
        elif action == "change_bio":
            bio = task.get("bio") or td.get("bio", "")
            print(f"  [BIO] [{phone}] → {bio[:30]}...")
            await client(UpdateProfileRequest(about=bio))
            await report("change_bio", {"task_id": task_id, "account_id": acc_id, "success": True})
            return True, None
        
        elif action == "change_username":
            username = task.get("username") or td.get("username", "")
            print(f"  [USERNAME] [{phone}] → @{username}")
            from telethon.tl.functions.account import UpdateUsernameRequest
            await client(UpdateUsernameRequest(username=username))
            await report("change_username", {"task_id": task_id, "account_id": acc_id, "success": True, "username": username})
            return True, None
        
        # ==========================================================
        # CONTACT ACTIONS
        # ==========================================================
        
        elif action in ("add_contact", "warmup_add_contact", "import_contact"):
            target_phone = td.get("recipient_phone") or td.get("target_phone") or task.get("target_phone")
            first_name = td.get("first_name") or task.get("first_name") or (target_phone.replace("+", "") if target_phone else "Contact")
            last_name = td.get("last_name") or task.get("last_name", "")
            
            if target_phone:
                print(f"  [CONTACT+] [{phone}] Adding {target_phone}...")
                contact = InputPhoneContact(
                    client_id=random.randint(0, 2**31-1),
                    phone=target_phone if target_phone.startswith("+") else f"+{target_phone}",
                    first_name=first_name,
                    last_name=last_name
                )
                result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
                success = bool(result.users)
                await report("add_contact", {
                    "task_id": task_id, 
                    "account_id": acc_id,
                    "pair_id": td.get("pair_id"),
                    "target_phone": target_phone,
                    "success": success,
                    "telegram_id": result.users[0].id if result.users else None
                })
                return success, None if success else "Could not add contact"
            return False, "No phone number"
        
        elif action == "delete_contact":
            from telethon.tl.functions.contacts import DeleteContactsRequest
            target = td.get("target_phone") or td.get("target_telegram_id") or task.get("target")
            
            if target:
                print(f"  [CONTACT-] [{phone}] Removing {target}...")
                try:
                    entity = await client.get_input_entity(target)
                    await client(DeleteContactsRequest([entity]))
                    await report("delete_contact", {"task_id": task_id, "account_id": acc_id, "success": True})
                    return True, None
                except:
                    return False, "Contact not found"
            return False, "No target"
        
        elif action == "block_contact":
            from telethon.tl.functions.contacts import BlockRequest
            target = td.get("target_phone") or td.get("target_telegram_id") or task.get("target_phone")
            
            if target:
                print(f"  [BLOCK] [{phone}] Blocking {target}...")
                try:
                    entity = await client.get_input_entity(target)
                    await client(BlockRequest(entity))
                    await report("block_contact", {"task_id": task_id, "account_id": acc_id, "target": str(target), "success": True})
                    return True, None
                except:
                    return False, "User not found"
            return False, "No target"
        
        elif action == "unblock_contact":
            from telethon.tl.functions.contacts import UnblockRequest
            target = td.get("target_phone") or td.get("target_telegram_id") or task.get("target")
            
            if target:
                print(f"  [UNBLOCK] [{phone}] Unblocking {target}...")
                try:
                    entity = await client.get_input_entity(target)
                    await client(UnblockRequest(entity))
                    await report("unblock_contact", {"task_id": task_id, "account_id": acc_id, "success": True})
                    return True, None
                except:
                    return False, "User not found"
            return False, "No target"
        
        # ==========================================================
        # CHANNEL ACTIONS
        # ==========================================================
        
        elif action in ("join_channel", "join", "warmup_join_channel"):
            channel = td.get("channel_username") or td.get("channel") or task.get("channel")
            
            if channel:
                print(f"  [JOIN] [{phone}] → @{channel}")
                try:
                    await asyncio.wait_for(client(JoinChannelRequest(channel)), timeout=20)
                    await report("join_channel", {"task_id": task_id, "account_id": acc_id, "channel": channel, "success": True})
                    return True, None
                except Exception as e:
                    if "already" in str(e).lower():
                        await report("join_channel", {"task_id": task_id, "account_id": acc_id, "channel": channel, "success": True})
                        return True, None
                    raise
            return False, "No channel"
        
        elif action in ("leave_channel", "leave"):
            from telethon.tl.functions.channels import LeaveChannelRequest
            channel = td.get("channel_username") or td.get("channel") or task.get("channel")
            
            if channel:
                print(f"  [LEAVE] [{phone}] ← @{channel}")
                entity = await client.get_entity(channel)
                await client(LeaveChannelRequest(entity))
                await report("leave_channel", {"task_id": task_id, "account_id": acc_id, "channel": channel, "success": True})
                return True, None
            return False, "No channel"
        
        elif action in ("react", "warmup_react", "send_reaction"):
            channel = td.get("channel_username") or td.get("channel") or task.get("channel")
            emoji = td.get("emoji") or task.get("emoji") or random.choice(["👍", "❤️", "🔥", "👏", "😂"])
            
            if channel:
                print(f"  [REACT] [{phone}] {emoji} → @{channel}")
                entity = await client.get_entity(channel)
                msgs = await client.get_messages(entity, limit=10)
                if msgs:
                    msg = random.choice(msgs)
                    await client(SendReactionRequest(peer=entity, msg_id=msg.id, reaction=[ReactionEmoji(emoticon=emoji)]))
                    await report("react", {"task_id": task_id, "account_id": acc_id, "success": True})
                    return True, None
                return False, "No messages to react"
            return False, "No channel"
        
        elif action == "view_channel":
            from telethon.tl.functions.messages import GetHistoryRequest
            channel = td.get("channel_username") or td.get("channel") or task.get("channel")
            
            if channel:
                print(f"  [VIEW] [{phone}] → @{channel}")
                entity = await client.get_entity(channel)
                await client(GetHistoryRequest(peer=entity, limit=20, offset_id=0, offset_date=None, add_offset=0, max_id=0, min_id=0, hash=0))
                await report("view_channel", {"task_id": task_id, "account_id": acc_id, "success": True})
                return True, None
            return False, "No channel"
        
        # ==========================================================
        # CHECK ACTIONS
        # ==========================================================
        
        elif action == "spambot_check":
            print(f"  [SPAMBOT] [{phone}] Checking...")
            bot = await client.get_entity("@SpamBot")
            await client.send_message(bot, "/start")
            await asyncio.sleep(3)
            msgs = await client.get_messages(bot, limit=1)
            resp = msgs[0].text if msgs else ""
            resp_lower = resp.lower()
            
            if "banned" in resp_lower or "deleted" in resp_lower or "deactivated" in resp_lower:
                status = "banned"
            elif "frozen" in resp_lower:
                status = "frozen"
            elif "limited" in resp_lower or "restricted" in resp_lower or "cannot" in resp_lower:
                status = "restricted"
            else:
                status = "active"
            
            await report("spambot_check", {
                "task_id": task_id,
                "account_id": acc_id,
                "status": status,
                "response": resp[:300],
                "success": True
            })
            print(f"  [SPAMBOT] [{phone}] → {status}")
            return True, None
        
        elif action == "session_check":
            print(f"  [SESSION] [{phone}] Verifying...")
            me = await asyncio.wait_for(client.get_me(), timeout=10)
            if me:
                await report("session_check", {
                    "task_id": task_id,
                    "account_id": acc_id,
                    "success": True,
                    "telegram_id": me.id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username
                })
                print(f"  [SESSION] [{phone}] ✓ Valid")
                return True, None
            return False, "get_me returned None"
        
        elif action == "get_me":
            me = await client.get_me()
            await report("get_me", {
                "task_id": task_id,
                "account_id": acc_id,
                "success": True,
                "data": {"id": me.id, "first_name": me.first_name, "last_name": me.last_name, "username": me.username, "phone": me.phone}
            })
            return True, None
        
        # ==========================================================
        # DIALOG/CHAT ACTIONS
        # ==========================================================
        
        elif action == "get_dialogs":
            print(f"  [DIALOGS] [{phone}] Fetching...")
            dialogs = await asyncio.wait_for(client.get_dialogs(limit=50), timeout=15)
            dialog_list = []
            for d in dialogs:
                dialog_list.append({
                    "id": d.id,
                    "name": d.name,
                    "unread": d.unread_count,
                    "is_user": d.is_user,
                    "is_group": d.is_group,
                    "is_channel": d.is_channel
                })
            await report("get_dialogs", {"task_id": task_id, "account_id": acc_id, "dialogs": dialog_list, "success": True})
            return True, None
        
        elif action == "read_messages":
            target = td.get("target") or td.get("chat_id") or task.get("target")
            if target:
                entity = await asyncio.wait_for(client.get_input_entity(target), timeout=10)
                try:
                    await asyncio.wait_for(client.send_read_acknowledge(entity), timeout=10)
                except Exception as read_err:
                    if "Frozen" in type(read_err).__name__ or "frozen" in str(read_err).lower():
                        await update_account_status(acc_id, "frozen", "Frozen by Telegram", auto_disabled=True)
                        return False, "Account frozen by Telegram"
                    raise
                await report("read_messages", {"task_id": task_id, "account_id": acc_id, "success": True})
                return True, None
            return False, "No target"
        
        elif action == "delete_chat":
            from telethon.tl.functions.messages import DeleteHistoryRequest
            target = td.get("target") or td.get("chat_id") or task.get("target")
            if target:
                print(f"  [DELETE] [{phone}] Deleting chat with {target}...")
                entity = await client.get_input_entity(target)
                await client(DeleteHistoryRequest(peer=entity, max_id=0, revoke=True))
                await report("delete_chat", {"task_id": task_id, "account_id": acc_id, "success": True})
                return True, None
            return False, "No target"
        
        # ==========================================================
        # SYNC PROFILE
        # ==========================================================
        
        elif action == "sync_profile":
            print(f"  [SYNC] [{phone}] Fetching profile from Telegram...")
            me = await asyncio.wait_for(client.get_me(), timeout=15)
            
            if me:
                import base64
                
                avatar_url = None
                try:
                    # Download profile photo directly as bytes
                    photo_bytes = await client.download_profile_photo(me, bytes)
                    if photo_bytes:
                        # Convert to base64 for edge function to upload
                        b64 = base64.b64encode(photo_bytes).decode()
                        avatar_url = f"data:image/jpeg;base64,{b64}"
                        print(f"  [SYNC] [{phone}] Downloaded profile photo ({len(photo_bytes)} bytes)")
                except Exception as e:
                    print(f"  [SYNC] [{phone}] Photo download failed: {e}")
                
                await report("sync_profile", {
                    "task_id": task_id,
                    "account_id": acc_id,
                    "success": True,
                    "telegram_id": me.id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username,
                    "phone": me.phone,
                    "avatar_url": avatar_url
                })
                print(f"  [SYNC] [{phone}] ✓ {me.first_name or ''} {me.last_name or ''} (@{me.username or 'none'})")
                return True, None
            return False, "get_me returned None"
        
        # ==========================================================
        # PRIVACY SETTINGS
        # ==========================================================
        
        elif action == "privacy_settings":
            from telethon.tl.functions.account import SetPrivacyRequest
            from telethon.tl.types import (
                InputPrivacyKeyPhoneNumber, InputPrivacyKeyStatusTimestamp,
                InputPrivacyKeyPhoneCall, InputPrivacyKeyProfilePhoto,
                InputPrivacyValueAllowAll, InputPrivacyValueAllowContacts,
                InputPrivacyValueDisallowAll
            )
            
            settings = td or {}
            if not settings and task.get("result"):
                try:
                    import json
                    settings = json.loads(task.get("result", "{}"))
                except:
                    settings = {}
            
            hide_phone = settings.get("hidePhone", False)
            hide_last_seen = settings.get("hideLastSeen", False)
            disable_calls = settings.get("disableCalls", False)
            hide_photo = settings.get("hideProfilePhoto", False)
            
            print(f"  [PRIVACY] [{phone}] Applying: phone={hide_phone}, lastSeen={hide_last_seen}, calls={disable_calls}, photo={hide_photo}")
            
            await client(SetPrivacyRequest(
                key=InputPrivacyKeyPhoneNumber(),
                rules=[InputPrivacyValueDisallowAll()] if hide_phone else [InputPrivacyValueAllowContacts()]
            ))
            await client(SetPrivacyRequest(
                key=InputPrivacyKeyStatusTimestamp(),
                rules=[InputPrivacyValueDisallowAll()] if hide_last_seen else [InputPrivacyValueAllowAll()]
            ))
            await client(SetPrivacyRequest(
                key=InputPrivacyKeyPhoneCall(),
                rules=[InputPrivacyValueDisallowAll()] if disable_calls else [InputPrivacyValueAllowContacts()]
            ))
            await client(SetPrivacyRequest(
                key=InputPrivacyKeyProfilePhoto(),
                rules=[InputPrivacyValueDisallowAll()] if hide_photo else [InputPrivacyValueAllowAll()]
            ))
            
            await report("privacy_settings", {"task_id": task_id, "account_id": acc_id, "success": True, "settings": settings})
            print(f"  [PRIVACY] [{phone}] ✓ Applied")
            return True, None
        
        # ==========================================================
        # CHANGE PASSWORD (2FA)
        # ==========================================================
        
        elif action == "change_password":
            from telethon.tl.functions.account import GetPasswordRequest, UpdatePasswordSettingsRequest
            from telethon.tl.types import InputCheckPasswordEmpty
            from telethon.password import compute_check, compute_hash
            
            settings = td or {}
            if not settings and task.get("result"):
                try:
                    import json
                    settings = json.loads(task.get("result", "{}"))
                except:
                    settings = {}
            
            existing_pw = settings.get("existing_password")
            new_pw = settings.get("new_password")
            
            if not new_pw:
                return False, "No new password provided"
            
            print(f"  [2FA] [{phone}] Setting cloud password...")
            
            try:
                pwd = await client(GetPasswordRequest())
                
                if pwd.has_password and existing_pw:
                    check = compute_check(pwd, existing_pw.encode())
                    new_hash = compute_hash(pwd.new_algo, new_pw.encode())
                    
                    from telethon.tl.types.account import PasswordInputSettings
                    await client(UpdatePasswordSettingsRequest(
                        password=check,
                        new_settings=PasswordInputSettings(
                            new_algo=pwd.new_algo,
                            new_password_hash=new_hash,
                            hint=""
                        )
                    ))
                elif not pwd.has_password:
                    new_hash = compute_hash(pwd.new_algo, new_pw.encode())
                    
                    from telethon.tl.types.account import PasswordInputSettings
                    await client(UpdatePasswordSettingsRequest(
                        password=InputCheckPasswordEmpty(),
                        new_settings=PasswordInputSettings(
                            new_algo=pwd.new_algo,
                            new_password_hash=new_hash,
                            hint=""
                        )
                    ))
                else:
                    return False, "Account has 2FA but no existing password provided"
                
                await report("change_password", {"task_id": task_id, "account_id": acc_id, "success": True})
                print(f"  [2FA] [{phone}] ✓ Password set")
                return True, None
                
            except Exception as e:
                if "PASSWORD_HASH_INVALID" in str(e):
                    return False, "Existing password is incorrect"
                raise
        
        # ==========================================================
        # LOGOUT OTHER SESSIONS
        # ==========================================================
        
        elif action == "logout_sessions":
            from telethon.tl.functions.account import GetAuthorizationsRequest, ResetAuthorizationRequest
            
            print(f"  [LOGOUT] [{phone}] Terminating other sessions...")
            
            auths = await client(GetAuthorizationsRequest())
            terminated = 0
            
            for auth in auths.authorizations:
                if not auth.current:
                    try:
                        await client(ResetAuthorizationRequest(hash=auth.hash))
                        terminated += 1
                    except:
                        pass
            
            await report("logout_sessions", {
                "task_id": task_id, 
                "account_id": acc_id, 
                "success": True, 
                "terminated_count": terminated
            })
            print(f"  [LOGOUT] [{phone}] ✓ Terminated {terminated} session(s)")
            return True, None
        
        # ==========================================================
        # UNKNOWN ACTION
        # ==========================================================
        
        else:
            print(f"  [?] [{phone}] Unknown action: {action}")
            await report(action, {"task_id": task_id, "account_id": acc_id, "success": False, "error": f"Unknown action: {action}"})
            return False, f"Unknown action: {action}"
            
    except Exception as e:
        error_msg = str(e)[:100]
        print(f"  [ERROR] [{phone}] {action}: {error_msg}")
        await report(action, {"task_id": task_id, "account_id": acc_id, "success": False, "error": error_msg})
        return False, error_msg


# ==============================================================================
# INCOMING MESSAGE HANDLER
# ==============================================================================

async def on_message(event, acc_id: str):
    """Handle incoming messages - registered on all clients."""
    try:
        # Only process private messages (DMs)
        if not event.is_private:
            return
        
        sender = await event.get_sender()
        if not sender or not isinstance(sender, User) or getattr(sender, 'bot', False):
            return
        
        # REMOVED contact filter - let backend handle conversation matching
        # All private messages from real users are now reported
        # Backend will create/update conversations based on existing campaign recipients
        
        phone = None
        if hasattr(sender, 'phone') and sender.phone:
            phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
        
        name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
        content = event.message.text or ""
        
        # Download media if present
        media_url = None
        media_type = None
        if event.message.media:
            try:
                # Skip large files (>5MB) to prevent memory issues
                file_size_check = getattr(event.message.media, 'document', None)
                if file_size_check and hasattr(file_size_check, 'size') and file_size_check.size > 5 * 1024 * 1024:
                    if event.message.video:
                        media_type = "video"
                    elif event.message.document:
                        media_type = "document"
                    else:
                        media_type = "media"
                    content = content or f"[{media_type.capitalize()} - too large]"
                    print(f"  [MEDIA] Skipped large file ({file_size_check.size / 1024 / 1024:.1f} MB)")
                else:
                    media_bytes = await asyncio.wait_for(event.message.download_media(bytes), timeout=30)
                    if media_bytes:
                        b64 = base64.b64encode(media_bytes).decode()
                        if event.message.photo:
                            media_type = "image"
                            media_url = f"data:image/jpeg;base64,{b64}"
                        elif event.message.video:
                            media_type = "video"
                            media_url = f"data:video/mp4;base64,{b64}"
                        elif event.message.document:
                            media_type = "document"
                            media_url = f"data:application/octet-stream;base64,{b64}"
                        
                        if not content:
                            content = f"[{media_type.capitalize()}]"
            except Exception as e:
                print(f"  [MEDIA] Download failed: {e}")
                if not content:
                    content = "[Media]"
        
        if not content:
            content = "[Media]"
        
        acc = accounts.get(acc_id, {})
        print(f"  📩 [{acc.get('phone_number','?')[-4:]}] ← {name[:12]}: {content[:25]}...")
        
        # Track message to avoid duplicate processing in catch-up
        msg_key = f"{acc_id}_{event.message.id}"
        processed_message_ids.add(msg_key)
        
        await report("incoming_message", {
            "account_id": acc_id,
            "sender_id": sender.id,
            "sender_name": name,
            "sender_username": getattr(sender, 'username', None),
            "sender_phone": phone,
            "content": content,
            "telegram_message_id": event.message.id,
            "media_url": media_url,
            "media_type": media_type
        })
    except Exception as e:
        acc = accounts.get(acc_id, {})
        phone = acc.get('phone_number', '?')[-4:]
        print(f"  [MSG-ERR] [{phone}] Error handling incoming: {str(e)[:80]}")


# ==============================================================================
# FETCH UNREAD MESSAGES (CATCH-UP ON RECONNECTION)
# ==============================================================================

async def fetch_unread_messages(client, acc_id: str, offline_since: Optional[str] = None):
    """Fetch and report unread messages from contacts after reconnection.
    Uses last_offline_at if available, otherwise defaults to 24h window."""
    global last_offline_at
    acc = accounts.get(acc_id, {})
    phone = acc.get("phone_number", "????")[-4:]
    
    from datetime import datetime, timedelta, timezone
    
    # Determine cutoff time based on last offline timestamp
    # Priority: 1) Function parameter, 2) Global last_offline_at, 3) 24h default
    cutoff_time = None
    cutoff_source = "24h default"
    
    if offline_since:
        try:
            cutoff_time = datetime.fromisoformat(offline_since.replace('Z', '+00:00'))
            # Add 1-hour buffer to catch edge cases
            cutoff_time = cutoff_time - timedelta(hours=1)
            cutoff_source = "last_offline_at"
        except:
            pass
    elif last_offline_at:
        try:
            cutoff_time = datetime.fromisoformat(last_offline_at.replace('Z', '+00:00'))
            cutoff_time = cutoff_time - timedelta(hours=1)
            cutoff_source = "global last_offline_at"
        except:
            pass
    
    # Fallback to 24h window, also cap at 24h max
    if cutoff_time is None:
        cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
    else:
        # Cap at 24h maximum (older messages unlikely to be relevant)
        min_cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        if cutoff_time < min_cutoff:
            cutoff_time = min_cutoff
            cutoff_source += " (capped at 24h)"
    
    hours_back = (datetime.now(timezone.utc) - cutoff_time).total_seconds() / 3600
    
    try:
        print(f"  [CATCHUP] [{phone}] Fetching unread messages (last {hours_back:.1f}h, {cutoff_source})...")
        dialogs = await asyncio.wait_for(client.get_dialogs(limit=100), timeout=15)
        
        total_fetched = 0
        skipped_old = 0
        users_with_messages = 0
        
        for dialog in dialogs:
            # Only process direct user chats (not groups/channels)
            if not dialog.is_user:
                continue
            
            entity = dialog.entity
            
            # Skip bots
            if getattr(entity, 'bot', False):
                continue
            
            # REMOVED contact filter - sync all unread messages from users
            # Backend will handle conversation matching
            
            # Skip if no unread messages
            if dialog.unread_count == 0:
                continue
            
            # Fetch unread messages from this contact
            messages = await client.get_messages(
                dialog.entity, 
                limit=min(dialog.unread_count, 50)  # Cap at 50 per contact
            )
            
            for msg in reversed(messages):  # Process oldest first
                if not msg.text and not msg.media:
                    continue
                
                # SKIP our own outgoing messages - only process incoming from recipient
                if msg.out:
                    continue
                
                # SKIP messages older than 24 hours
                if msg.date and msg.date < cutoff_time:
                    skipped_old += 1
                    continue
                    
                sender_phone = None
                if hasattr(entity, 'phone') and entity.phone:
                    sender_phone = f"+{entity.phone}" if not entity.phone.startswith('+') else entity.phone
                
                name = f"{entity.first_name or ''} {entity.last_name or ''}".strip() or str(entity.id)
                content = msg.text or ""
                
                # Detect media type WITHOUT downloading (no memory spike during catchup)
                media_url = None
                media_type = None
                if msg.media:
                    if msg.photo:
                        media_type = "image"
                    elif msg.video:
                        media_type = "video"
                    elif msg.document:
                        media_type = "document"
                    else:
                        media_type = "media"
                    
                    if not content:
                        content = f"[{media_type.capitalize()}]"
                
                if not content:
                    content = "[Media]"
                
                # Skip if we already processed this message (client-side deduplication)
                msg_key = f"{acc_id}_{msg.id}"
                if msg_key in processed_message_ids:
                    continue
                
                await report("incoming_message", {
                    "account_id": acc_id,
                    "sender_id": entity.id,
                    "sender_name": name,
                    "sender_username": getattr(entity, 'username', None),
                    "sender_phone": sender_phone,
                    "content": content,
                    "telegram_message_id": msg.id,
                    "media_url": media_url,
                    "media_type": media_type
                })
                
                # Mark as processed
                processed_message_ids.add(msg_key)
                total_fetched += 1
            
            users_with_messages += 1
            
            # Always mark messages as read (even old ones)
            try:
                await asyncio.wait_for(client.send_read_acknowledge(dialog.entity), timeout=10)
            except Exception as read_err:
                err_name = type(read_err).__name__
                if "Frozen" in err_name or "frozen" in str(read_err).lower():
                    print(f"  [FROZEN] [{phone}] Account is frozen by Telegram - disabling")
                    await update_account_status(acc_id, "frozen", "Frozen by Telegram (ReadHistory failed)", auto_disabled=True)
                    # Remove from active clients to stop further operations
                    if acc_id in clients:
                        try:
                            await clients[acc_id].disconnect()
                        except:
                            pass
                        del clients[acc_id]
                    return
                else:
                    print(f"  [CATCHUP] [{phone}] Could not mark as read: {err_name}")
        
        if total_fetched > 0 or skipped_old > 0:
            print(f"  [CATCHUP] [{phone}] Synced {total_fetched} messages from {users_with_messages} users, skipped {skipped_old} old")
        else:
            print(f"  [CATCHUP] [{phone}] No unread messages")
            
    except Exception as e:
        import traceback
        print(f"  [CATCHUP] [{phone}] Error: {type(e).__name__}: {str(e)}")
        traceback.print_exc()
        sys.stdout.flush()


# ==============================================================================
# CLIENT MANAGEMENT
# ==============================================================================

async def connect(acc: dict) -> Tuple[Optional[Any], Optional[str]]:
    """Connect a single account. Reports failures to database."""
    aid = acc.get("id")
    phone = acc.get("phone_number", "????")
    proxy_id = acc.get("proxy_id")
    
    if not aid:
        return None, "No ID"
    
    async with get_lock(aid):
        # FIX: Disconnect stale client BEFORE creating a new one
        # Without this, Telegram sees 2 connections with same auth key and revokes BOTH
        if aid in clients:
            old = clients[aid]
            try:
                still_alive = await asyncio.wait_for(asyncio.to_thread(old.is_connected), timeout=2)
            except Exception:
                still_alive = False
            if still_alive:
                return old, None
            # Old client exists but is dead — disconnect it properly
            print(f"  [CLEANUP] [{phone[-4:]}] Disconnecting stale client before reconnect")
            try:
                await asyncio.wait_for(old.disconnect(), timeout=5)
            except Exception:
                pass
            del clients[aid]
        
        # Validation checks - report specific failures
        if not acc.get("session_data"):
            await update_account_status(aid, "disconnected", "No session data")
            return None, "No session"
        
        # Proxy is optional on desktop — connect directly if not assigned.
        if not get_proxy(acc):
            print(f"  [PROXY] [{phone[-4:]}] No proxy - connecting directly from local PC")
        
        if not acc.get("device_model") or not acc.get("api_id"):
            await update_account_status(aid, "disconnected", "Missing fingerprint or API credentials", auto_disabled=True)
            return None, "No fingerprint/API"
        
        path = decode_session(phone, acc["session_data"])
        if not path:
            await update_account_status(aid, "disconnected", "Session file decode failed", auto_disabled=True)
            return None, "Session decode failed"
        
        # Debug: Show proxy being used
        p_data = acc.get("proxies") or acc.get("proxy")
        if p_data:
            print(f"  [PROXY] [{phone[-4:]}] Using: {p_data.get('host')}:{p_data.get('port')} ({p_data.get('proxy_type', 'socks5')})")
        else:
            print(f"  [PROXY] [{phone[-4:]}] WARNING: No proxy configured!")
        
        try:
            client = TelegramClient(
                path, int(acc["api_id"]), acc["api_hash"],
                device_model=acc["device_model"],
                system_version=acc.get("system_version", "Android 12"),
                app_version=acc.get("app_version", "10.14.2"),
                proxy=get_proxy(acc),
                timeout=CONNECT_TIMEOUT_SECONDS, connection_retries=1, auto_reconnect=False
            )
            
            await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT_SECONDS)
            
            if not await asyncio.wait_for(client.is_user_authorized(), timeout=10):
                await client.disconnect()
                await update_account_status(aid, "disconnected", "Session not authorized/revoked", auto_disabled=True)
                return None, "Not authorized"
            
            clients[aid] = client
            accounts[aid] = acc
            print(f"  ✓ [{phone[-4:]}] Connected")
            return client, None
            
        except asyncio.TimeoutError:
            # Proxy timeout - mark both account and proxy
            error_msg = f"Connection timeout ({CONNECT_TIMEOUT_SECONDS}s) - proxy/provider overloaded or unreachable"
            print(f"  ✗ [{phone[-4:]}] TIMEOUT")
            await update_account_status(aid, "disconnected", error_msg, auto_disabled=True)
            if proxy_id:
                await update_proxy_status(proxy_id, "error", error_msg)
            return None, error_msg
            
        except (AuthKeyUnregisteredError, SessionRevokedError) as e:
            # Session invalid - account needs re-auth
            error_msg = f"Session revoked: {str(e)[:50]}"
            print(f"  ✗ [{phone[-4:]}] SESSION REVOKED")
            await update_account_status(aid, "disconnected", error_msg, auto_disabled=True)
            return None, error_msg
            
        except (UserDeactivatedBanError, PhoneNumberBannedError) as e:
            # Account banned
            error_msg = f"Account banned: {str(e)[:50]}"
            print(f"  ✗ [{phone[-4:]}] BANNED")
            await update_account_status(aid, "banned", error_msg, auto_disabled=True)
            return None, error_msg
            
        except Exception as e:
            error_str = str(e)
            print(f"  ✗ [{phone[-4:]}] {error_str[:30]}")
            
            # Check if it's a proxy-related error
            proxy_errors = ["proxy", "socks", "connection refused", "network unreachable", "host unreachable", "timed out"]
            is_proxy_error = any(pe in error_str.lower() for pe in proxy_errors)
            
            if is_proxy_error:
                await update_account_status(aid, "disconnected", f"Proxy error: {error_str[:100]}", auto_disabled=True)
                if proxy_id:
                    await update_proxy_status(proxy_id, "error", error_str[:100])
            else:
                await update_account_status(aid, "disconnected", error_str[:100], auto_disabled=True)
            
            return None, error_str


async def connect_all_from_response(accs: List[dict]) -> Tuple[int, set]:
    """
    Connect accounts from /runner-tasks/get response.
    Returns (count_connected, set_of_newly_connected_account_ids).
    Only prints header and runs catch-up for accounts that actually needed connecting.
    """
    if not accs:
        return 0, set()
    
    # Snapshot which accounts are already connected (defensive: some stale clients can block)
    already_connected = set()
    for aid, c in list(clients.items()):
        if not c:
            continue
        try:
            ok = await asyncio.wait_for(asyncio.to_thread(c.is_connected), timeout=2)
            if ok:
                already_connected.add(aid)
        except Exception:
            # treat as disconnected
            pass
    
    # Find accounts that need connecting (missing or disconnected)
    to_connect = [acc for acc in accs if acc.get("id") not in already_connected]
    
    # If nothing to connect, return silently
    if not to_connect:
        return len(already_connected), set()
    
    # Print header only when we actually have something to connect
    print("\\n" + "="*50)
    print("  CONNECTING ACCOUNTS")
    print("="*50)
    print(f"  Found {len(to_connect)} account(s) to connect (already connected: {len(already_connected)})...\\n")
    
    print(f"  Connection throttle: {CONNECT_CONCURRENCY} at a time, timeout {CONNECT_TIMEOUT_SECONDS}s")
    sys.stdout.flush()
    
    # Connect in small waves. Starting 25 Telegram+SOCKS handshakes at once can
    # trigger WinError 121 even when each proxy works manually in Telegram.
    results = []
    for start in range(0, len(to_connect), CONNECT_CONCURRENCY):
        batch = to_connect[start:start + CONNECT_CONCURRENCY]
        batch_no = (start // CONNECT_CONCURRENCY) + 1
        total_batches = (len(to_connect) + CONNECT_CONCURRENCY - 1) // CONNECT_CONCURRENCY
        print(f"  [CONNECT] Wave {batch_no}/{total_batches}: {len(batch)} account(s)")
        sys.stdout.flush()
        batch_results = await asyncio.gather(*[connect(a) for a in batch], return_exceptions=True)
        results.extend(batch_results)
        if start + CONNECT_CONCURRENCY < len(to_connect) and CONNECT_BATCH_PAUSE_SECONDS > 0:
            await asyncio.sleep(CONNECT_BATCH_PAUSE_SECONDS)

    ok = sum(1 for r in results if isinstance(r, tuple) and r[0])
    print(f"\\n  Connected: {ok}/{len(to_connect)} (total active: {len(already_connected) + ok})")
    
    # Track which accounts were newly connected
    newly_connected = set()
    for i, acc in enumerate(to_connect):
        if isinstance(results[i], tuple) and results[i][0]:
            aid = acc.get("id")
            if aid:
                newly_connected.add(aid)
    
    # SESSION LOCK: Lock newly connected accounts in the database
    # This prevents any other runner instance from connecting the same accounts
    if newly_connected:
        await lock_accounts(list(newly_connected))
    
    # Also renew locks for already-connected accounts (heartbeat for locks)
    if already_connected:
        await lock_accounts(list(already_connected))
    
    # Fetch unread messages in PARALLEL for all newly connected accounts (catch-up)
    # Uses last_offline_at for smart time-based fetching.
    # IMPORTANT: Put a hard timeout per account so one stuck Telethon call can't block startup.
    if newly_connected:
        print(f"\\n  [CATCHUP] Running catch-up for {len(newly_connected)} newly connected account(s)...")
        sys.stdout.flush()
        async def _catchup_one(aid: str):
            try:
                phone = (accounts.get(aid, {}).get("phone_number") or "????")[-4:]
                print(f"  [CATCHUP] [{phone}] Starting...")
                sys.stdout.flush()
                # Keep this short so startup never appears "stuck".
                await asyncio.wait_for(fetch_unread_messages(clients[aid], aid, last_offline_at), timeout=45)
                print(f"  [CATCHUP] [{phone}] Done")
                sys.stdout.flush()
            except asyncio.TimeoutError:
                phone_short = (accounts.get(aid, {}).get('phone_number') or '????')[-4:]
                print(f"  [CATCHUP] [{phone_short}] TIMEOUT - removing broken client (will reconnect next cycle)")
                sys.stdout.flush()
                try:
                    bad_client = clients.pop(aid, None)
                    if bad_client:
                        await bad_client.disconnect()
                except:
                    pass
            except Exception as e:
                import traceback
                phone_short = (accounts.get(aid, {}).get('phone_number') or '????')[-4:]
                print(f"  [CATCHUP] [{phone_short}] Error: {type(e).__name__}: {str(e)}")
                traceback.print_exc()
                sys.stdout.flush()
                # Remove broken client so it doesn't crash handler registration or task loop
                try:
                    bad_client = clients.pop(aid, None)
                    if bad_client:
                        await bad_client.disconnect()
                except:
                    pass
                print(f"  [CATCHUP] [{phone_short}] Removed (will reconnect next cycle)")
                sys.stdout.flush()

        await asyncio.gather(
            *[_catchup_one(aid) for aid in newly_connected if aid in clients],
            return_exceptions=True,
        )

        print("  [CATCHUP] All catch-up tasks finished (continuing startup)")
        sys.stdout.flush()
    
    return len(already_connected) + ok, newly_connected


async def setup_handlers():
    """Set up incoming message handlers with defensive error handling."""
    count = 0
    items = list(clients.items())
    total = len(items)
    started = time.time()
    for idx, (aid, client) in enumerate(items, start=1):
        if getattr(client, "_h", False):
            continue
        
        try:
            # Progress marker (helps identify the exact account where it hangs)
            if idx == 1 or idx % 25 == 0 or idx == total:
                print(f"  [HANDLER] Registering {idx}/{total} ({count} ok so far)...")
                sys.stdout.flush()

            # Check if client is still connected before registering handler.
            # IMPORTANT: do this defensively; some stale connections can block.
            connected = False
            try:
                connected = await asyncio.wait_for(asyncio.to_thread(client.is_connected), timeout=2)
            except Exception:
                connected = False
            
            if not connected:
                print(f"  [HANDLER] Skipping unresponsive/disconnected client {aid[:8]}...")
                continue
            
            @client.on(events.NewMessage(incoming=True))
            async def handler(event, a=aid):
                await on_message(event, a)
            
            setattr(client, "_h", True)
            count += 1
        except Exception as e:
            print(f"  [HANDLER] Failed to register for {aid[:8]}: {str(e)[:30]}")
            continue
    
    if count > 0:
        took = time.time() - started
        print(f"  [HANDLERS] Registered {count} new message handlers in {took:.1f}s")
        sys.stdout.flush()


# ==============================================================================
# UNIFIED TASK PROCESSOR
# ==============================================================================

async def process(task: dict):
    """
    ULTRA-SIMPLE TASK PROCESSOR
    
    If task needs to send a message → send_message()
    If task is an account action → account_action()
    
    That's it. Campaign, Conversation, Warmup - all the same.
    """
    tt = task.get("task_type") or task.get("type") or ""
    acc = task.get("account", {})
    aid = acc.get("id") or task.get("account_id") or task.get("task_data", {}).get("sender_account_id")
    
    if not aid:
        return
    
    # Get client
    client = clients.get(aid)
    if not client:
        client, err = await connect(acc) if acc.get("id") else (None, "No account data")
        if not client:
            return
    
    phone = accounts.get(aid, {}).get("phone_number", "????")[-4:]
    
    # ========== MESSAGE SENDING ==========
    # Campaign, Conversation, Warmup - they ALL just send messages
    if tt in ("send", "campaign_send", "livechat_reply", "warmup_chat") or ("send" in tt and "warmup" in tt):
        # Extract data - works for ANY task type
        msg = task.get("message", {})
        td = task.get("task_data", {})
        
        # Extract recipient - handle both string and object formats
        raw_recipient = (
            task.get("recipient") or 
            td.get("recipient_phone") or 
            td.get("recipient_telegram_id") or 
            msg.get("recipient") or 
            msg.get("recipient_phone")
        )
        
        # If recipient is a dict (from campaign), extract the phone/telegram_id
        if isinstance(raw_recipient, dict):
            recipient = (
                raw_recipient.get("phone") or 
                raw_recipient.get("telegram_id") or 
                raw_recipient.get("username") or 
                ""
            )
        else:
            recipient = raw_recipient
        content = msg.get("content") or td.get("message") or td.get("message_content") or task.get("content") or ""
        media = msg.get("media_url") or task.get("media_url")
        
        # SEND THE MESSAGE - same function for everything
        success, error, meta = await send_message(client, str(recipient) if recipient else "", content, media)
        
        if success:
            print(f"  ✓ [{phone}] → {str(recipient)[:15]}")
        else:
            print(f"  ✗ [{phone}] → {str(recipient)[:15]}: {error}")
        
        # Report based on task type
        if "warmup" in tt:
            await report("warmup_chat", {
                "task_id": task.get("task_id"),
                "pair_id": td.get("pair_id"),
                "warmup_message_id": td.get("warmup_message_id"),
                "success": success,
                "error": error
            })
        else:
            await report("send", {
                "message_id": msg.get("id") or task.get("message_id"),
                "campaign_recipient_id": task.get("campaign_recipient_id") or msg.get("campaign_recipient_id"),
                "campaign_id": task.get("campaign_id"),
                "campaign_seat_id": task.get("campaign_seat_id"),
                "account_id": aid,
                "api_credential_id": acc.get("api_credential_id"),
                "recipient_phone": recipient,
                "content": content,
                "success": success,
                "error": error,
                **meta
            })
    
    # ========== ALL ACCOUNT ACTIONS ==========
    # Profile actions
    elif tt in ("change_name", "change_photo", "change_bio", "change_username"):
        await account_action(client, tt, task)
    
    # Contact actions
    elif tt in ("add_contact", "delete_contact", "block_contact", "unblock_contact", "import_contact"):
        await account_action(client, tt, task)
    elif "add_contact" in tt:
        await account_action(client, "add_contact", task)
    elif "block" in tt:
        await account_action(client, "block_contact" if "unblock" not in tt else "unblock_contact", task)
    
    # Channel actions
    elif tt in ("join_channel", "leave_channel", "view_channel"):
        await account_action(client, tt, task)
    elif "join" in tt:
        await account_action(client, "join_channel", task)
    elif "leave" in tt:
        await account_action(client, "leave_channel", task)
    elif "react" in tt:
        await account_action(client, "react", task)
    
    # Check actions
    elif tt in ("spambot_check", "session_check", "get_me", "sync_profile"):
        await account_action(client, tt, task)
    
    # Privacy/Security actions
    elif tt in ("privacy_settings", "change_password", "logout_sessions"):
        await account_action(client, tt, task)
    
    # Dialog/chat actions
    elif tt in ("get_dialogs", "read_messages", "delete_chat"):
        await account_action(client, tt, task)
    
    # Warmup non-send actions
    elif tt.startswith("warmup") and "chat" not in tt and "send" not in tt:
        await account_action(client, tt, task)
    
    # Unknown - try to handle as account action anyway
    else:
        print(f"  [?] Unknown task type: {tt} - trying as account action")
        await account_action(client, tt, task)


# ==============================================================================
# MAIN LOOP
# ==============================================================================

async def main():
    global RUNNING
    
    # Install asyncio exception handler to catch background task crashes
    loop = asyncio.get_event_loop()
    loop.set_exception_handler(_asyncio_exception_handler)
    
    print("="*50)
    print("  TelegramCRM - ULTRA-SIMPLIFIED RUNNER")
    print(f"  BUILD: {BUILD_VERSION}")
    print(f"  INSTANCE: {RUNNER_INSTANCE_ID}")
    print("="*50)
    print("  TRUTH: Campaign = Conversation = Warmup")
    print("         They ALL just send messages!")
    print("="*50)
    print("  2 CORE FUNCTIONS:")
    print("    • send_message() - ALL sending")
    print("    • account_action() - Non-message ops")
    print("="*50 + "\\n")
    sys.stdout.flush()
    
    # Initial fetch to get accounts and connect them
    global last_offline_at
    print("  Fetching accounts from backend...")
    sys.stdout.flush()
    initial = await get_tasks(include_accounts=True)
    initial_accounts = initial.get("accounts", [])
    
    # Store the last offline timestamp from backend for smart catch-up
    last_offline_at = initial.get("last_offline_at")
    if last_offline_at:
        print(f"  Runner last offline at: {last_offline_at}")
    else:
        print("  No last_offline_at found, using 24h default for catch-up")
    sys.stdout.flush()
    
    print("  [PHASE] Starting connect_all_from_response...")
    sys.stdout.flush()
    _, _ = await connect_all_from_response(initial_accounts)
    print("  [PHASE] connect_all_from_response DONE")
    sys.stdout.flush()
    
    print("  [PHASE] Setting up handlers...")
    sys.stdout.flush()
    
    try:
        await setup_handlers()
    except Exception as e:
        import traceback
        print(f"  [WARN] Handler setup error (non-fatal): {str(e)}")
        traceback.print_exc()
        print("  [WARN] Continuing to main loop - handlers will retry on next refresh cycle")
        sys.stdout.flush()
    
    print("  [DEBUG] Handlers registered, entering main loop...")
    sys.stdout.flush()
    
    print("\\n" + "="*50)
    print("  PROCESSING TASKS + LISTENING FOR MESSAGES")
    print("="*50 + "\\n")
    sys.stdout.flush()
    
    empty = 0
    last_refresh = time.time()
    
    while RUNNING:
        try:
            # Get tasks (backend controls batch size from admin settings)
            # For large fleets, avoid returning the full accounts payload on every poll.
            need_accounts = (time.time() - last_refresh > 60)
            batch = await get_tasks(include_accounts=need_accounts)
            tasks = batch.get("tasks", [])
            batch_accounts = batch.get("accounts", [])
            
            # Check for new/disconnected accounts only when we requested accounts
            if need_accounts and batch_accounts:
                _, newly_connected = await connect_all_from_response(batch_accounts)
                if newly_connected:
                    try:
                        await setup_handlers()
                    except Exception as e:
                        import traceback
                        print(f"  [WARN] Handler re-registration failed: {str(e)}")
                        traceback.print_exc()
                        sys.stdout.flush()
                last_refresh = time.time()
            
            if not tasks:
                empty += 1
                if empty == 1 or empty % 12 == 0:
                    print(f"  [WAIT] No tasks ({len(clients)} clients listening)")
                await asyncio.sleep(batch.get("delay_after", 5))
                continue
            
            empty = 0
            
            # Log
            by_type = defaultdict(int)
            for t in tasks:
                by_type[t.get("task_type") or "?"] += 1
            print(f"\\n  [BATCH] {len(tasks)} tasks: {dict(by_type)}")
            
            # Process ALL in parallel
            await asyncio.gather(*[process(t) for t in tasks], return_exceptions=True)
            print("  [DONE]")
            
            await asyncio.sleep(batch.get("delay_after", 2))
            
        except PersistentTimestampOutdatedError:
            print("  [WARN] Telegram internal sync issue (PersistentTimestampOutdated) - ignoring")
            sys.stdout.flush()
            await asyncio.sleep(2)
        except Exception as e:
            if "PersistentTimestamp" in str(e):
                print("  [WARN] Telegram internal sync issue - ignoring")
                sys.stdout.flush()
                await asyncio.sleep(2)
                continue
            import traceback
            print(f"  [ERROR] Main loop exception: {str(e)}")
            traceback.print_exc()
            sys.stdout.flush()
            await asyncio.sleep(5)
    
    # Shutdown - release all session locks FIRST, then disconnect
    print("\\n  [SHUTDOWN]...")
    await unlock_all_accounts()
    for c in clients.values():
        try:
            await asyncio.wait_for(c.disconnect(), timeout=5)
        except:
            pass
    print("  Done!")


BOOT_COUNT = 0

if __name__ == "__main__":
    print("\\n" + "="*50)
    print("  pip install telethon httpx pysocks")
    print("="*50 + "\\n")
    
    while True:
        BOOT_COUNT += 1
        boot_time = time.strftime("%Y-%m-%d %H:%M:%S")
        print(f"\\n[BOOT] #{BOOT_COUNT} at {boot_time}")
        if BOOT_COUNT > 1:
            print(f"  ↑ This is a RESTART (boot #{BOOT_COUNT}), not a periodic refresh")
            # CRITICAL: Clear stale clients from previous event loop
            print(f"  [CLEANUP] Clearing {len(clients)} stale clients from previous loop...")
            clients.clear()
            accounts.clear()
            # Release session locks from previous crash so we can re-acquire them
            try:
                import httpx as _hx
                _hx.post(
                    f"{BACKEND_URL}/runner-tasks/unlock",
                    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
                    json={"server_id": RUNNER_INSTANCE_ID}, timeout=15
                )
                print(f"  [SESSION-LOCK] Released stale locks for instance {RUNNER_INSTANCE_ID}")
            except:
                pass
        
        try:
            asyncio.run(main())
            # If main() exits cleanly (RUNNING = False), break the loop
            if not RUNNING:
                print("  ✓ Clean shutdown")
                break
        except KeyboardInterrupt:
            print("\\n⏹ Stopped")
            break
        except PersistentTimestampOutdatedError:
            print("\\n⚠ Telegram internal sync issue (PersistentTimestampOutdated) - continuing...")
            time.sleep(2)
            RUNNING = True
        except Exception as e:
            if "PersistentTimestamp" in str(e):
                print("\\n⚠ Telegram internal sync issue - continuing...")
                time.sleep(2)
                RUNNING = True
                continue
            import traceback
            print(f"\\n⚠ CRASHED! Full error below:")
            print(f"  Exception type: {type(e).__name__}")
            print(f"  Exception message: {str(e)}")
            traceback.print_exc()
            sys.stdout.flush()
            print(f"  Restarting in 5s...")
            time.sleep(5)
            RUNNING = True
`;

  // ========== RUN.BAT ==========
  const runBat = `@echo off
title TelegramCRM - Ultra-Simplified Runner
color 0A

echo.
echo  ================================================
echo    TelegramCRM - ULTRA-SIMPLIFIED RUNNER
echo  ================================================
echo.
echo  TRUTH: Campaign = Conversation = Warmup
echo         They ALL just send messages!
echo.
echo  2 Core Functions:
echo    * send_message()    - ALL sending
echo    * account_action()  - Non-message ops
echo.

cd /d "%~dp0"

echo  Installing requirements...
py -m pip install telethon httpx pysocks --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks --quiet 2>nul
)
echo  Done!
echo.

py unified_runner.py
if errorlevel 1 (
    python unified_runner.py
)

pause
`;

  // ========== REQUIREMENTS.TXT ==========
  const requirementsTxt = `telethon>=1.34.0
httpx>=0.27.0
pysocks>=1.7.1
`;

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    folder?.file("unified_runner.py", unifiedRunnerPy);
    folder?.file("requirements.txt", requirementsTxt);
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Cache-bust downloads so the user never accidentally runs an old script
    a.download = `telegram_crm_${runnerBuild}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success(`Runner downloaded: ${runnerBuild}`);
  };

  return (
    <Card className="mt-8">
      <CardContent className="p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Python Runner</h2>
          <p className="text-sm text-muted-foreground">
            Download and run this on your PC to power the app. Build: {runnerBuild}
          </p>
        </div>
        <Button onClick={downloadZip} size="lg" className="gap-2 shrink-0">
          <Download className="w-5 h-5" />
          Download Runner
        </Button>
      </CardContent>
    </Card>
  );
};

export default RunnerDownloadCard;

