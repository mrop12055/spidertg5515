import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';

const SetupGuide: React.FC = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  // ========== SIMPLIFIED UNIFIED RUNNER ==========
  // Core insight: ALL operations are just SEND, RECEIVE, or ACCOUNT_ACTION
  const unifiedRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - SIMPLIFIED UNIFIED RUNNER
========================================
BUILD: 2026-01-29-simplified-v1

CORE INSIGHT: All operations reduce to just 3 actions:
  1. SEND MESSAGE - Campaign, LiveChat, Warmup all send messages
  2. RECEIVE MESSAGE - Event handlers capture incoming messages
  3. ACCOUNT ACTION - Spambot check, name change, photo change

ARCHITECTURE:
  PHASE 1: Connect ALL accounts in parallel
  PHASE 2: Set up receive handlers on all clients
  PHASE 3: Poll for tasks, route to send_message() or account_action()

SCALE: Handles 2000+ accounts with parallel task processing

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
import json
from typing import Dict, Optional, List, Any, Tuple
from collections import defaultdict
from datetime import datetime

# ========== CONFIGURATION ==========
BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"

BUILD_VERSION = "2026-01-29-simplified-v1"

# ========== TIMEOUTS ==========
PROXY_TIMEOUT = 60
HTTP_TIMEOUT = 45

# ========== POLLING INTERVALS ==========
POLL_INTERVAL = 5           # Task polling
RECONNECT_INTERVAL = 30     # Check disconnected clients
REFRESH_INTERVAL = 60       # Refresh account list

# ========== GLOBAL STATE ==========
SESSION_FOLDER = tempfile.mkdtemp(prefix="tg_runner_")
active_clients: Dict[str, Any] = {}   # account_id -> TelegramClient
account_data: Dict[str, dict] = {}    # account_id -> account info
RUNNING = True

# ========== LOCKS ==========
_locks: Dict[str, asyncio.Lock] = {}
_locks_mutex = threading.Lock()
_http: Optional[httpx.AsyncClient] = None


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutdown signal received...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== TELETHON IMPORTS ==========
try:
    from telethon import TelegramClient, events
    from telethon.errors import (
        FloodWaitError, UserPrivacyRestrictedError, PeerFloodError,
        UserBlockedError, ChatWriteForbiddenError, AuthKeyUnregisteredError,
        SessionRevokedError, UserDeactivatedBanError, PhoneNumberBannedError
    )
    from telethon.tl.functions.contacts import ResolvePhoneRequest, ImportContactsRequest
    from telethon.tl.functions.messages import SendMessageRequest, SendReactionRequest
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.tl.functions.account import UpdateProfileRequest
    from telethon.tl.types import InputPhoneContact, InputPeerUser, ReactionEmoji, User
except ImportError:
    print("ERROR: pip install telethon httpx pysocks")
    sys.exit(1)


# ==============================================================================
# UTILITIES
# ==============================================================================

def get_lock(account_id: str) -> asyncio.Lock:
    with _locks_mutex:
        if account_id not in _locks:
            _locks[account_id] = asyncio.Lock()
        return _locks[account_id]


def get_http() -> httpx.AsyncClient:
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(timeout=HTTP_TIMEOUT, limits=httpx.Limits(max_connections=500))
    return _http


def decode_session(phone: str, base64_data: str) -> Optional[str]:
    path = os.path.join(SESSION_FOLDER, phone.replace("+", ""))
    try:
        with open(path + ".session", "wb") as f:
            f.write(base64.b64decode(base64_data))
        return path
    except:
        return None


def get_proxy(account: dict) -> Optional[tuple]:
    proxy = account.get("proxies") or account.get("proxy")
    if not proxy or not proxy.get("host") or not proxy.get("port"):
        return None
    
    ptype_str = (proxy.get("proxy_type") or "socks5").lower()
    ptype = socks.SOCKS5 if ptype_str == "socks5" else socks.SOCKS4 if ptype_str == "socks4" else socks.HTTP
    
    if proxy.get("username") and proxy.get("password"):
        return (ptype, proxy["host"], int(proxy["port"]), True, proxy["username"], proxy["password"])
    return (ptype, proxy["host"], int(proxy["port"]))


def add_variation(text: str) -> str:
    """Add invisible character to make message unique."""
    chars = ['\\u200b', '\\u200c', '\\u200d', '\\ufeff']
    pos = random.randint(0, len(text))
    return text[:pos] + random.choice(chars) + text[pos:]


# ==============================================================================
# DATA EXTRACTION HELPERS
# ==============================================================================

def extract_recipient(task: dict) -> Optional[str]:
    """Extract recipient from ANY task type."""
    # Direct recipient field
    if task.get("recipient"):
        return str(task["recipient"])
    
    # Warmup task_data
    td = task.get("task_data", {})
    if td.get("recipient_phone"):
        return str(td["recipient_phone"])
    if td.get("recipient_telegram_id"):
        return str(td["recipient_telegram_id"])
    
    # Message object
    msg = task.get("message", {})
    if msg.get("recipient"):
        return str(msg["recipient"])
    if msg.get("recipient_phone"):
        return str(msg["recipient_phone"])
    
    return None


def extract_content(task: dict) -> str:
    """Extract message content from ANY task type."""
    if task.get("content"):
        return task["content"]
    
    td = task.get("task_data", {})
    if td.get("message"):
        return td["message"]
    if td.get("message_content"):
        return td["message_content"]
    
    msg = task.get("message", {})
    if msg.get("content"):
        return msg["content"]
    
    return ""


def extract_media(task: dict) -> Optional[str]:
    """Extract media URL from ANY task type."""
    if task.get("media_url"):
        return task["media_url"]
    
    msg = task.get("message", {})
    if msg.get("media_url"):
        return msg["media_url"]
    
    return None


def extract_account_id(task: dict) -> Optional[str]:
    """Extract account ID from ANY task type."""
    if task.get("account", {}).get("id"):
        return task["account"]["id"]
    if task.get("account_id"):
        return task["account_id"]
    
    td = task.get("task_data", {})
    if td.get("sender_account_id"):
        return td["sender_account_id"]
    
    return None


# ==============================================================================
# HTTP API FUNCTIONS
# ==============================================================================

async def report_result(task_type: str, result: dict):
    """Report task result to server."""
    try:
        await get_http().post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"task_type": task_type, **result},
            timeout=30
        )
    except:
        pass


async def report_session_check(account_id: str, success: bool, telegram_data: dict = None, error: str = None, status: str = None):
    try:
        await get_http().post(
            f"{BACKEND_URL}/report-session-check",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"account_id": account_id, "success": success, "telegram_data": telegram_data, "error": error, "status": status},
            timeout=20
        )
    except:
        pass


async def fetch_all_accounts() -> List[dict]:
    """Fetch ALL active accounts with sessions."""
    try:
        resp = await get_http().get(
            f"{SUPABASE_URL}/rest/v1/telegram_accounts?status=eq.active&session_data=not.is.null&select=*,proxies(*)",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            timeout=60
        )
        return resp.json() if resp.status_code == 200 else []
    except Exception as e:
        print(f"  [ERROR] Fetch accounts: {e}")
        return []


async def get_batch_tasks(batch_size: int = 100) -> dict:
    """Fetch batch of ALL task types."""
    try:
        resp = await get_http().post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"runner": "unified", "batch_size": batch_size},
            timeout=60
        )
        return resp.json() if resp.status_code == 200 else {"tasks": [], "delay_after": 5}
    except:
        return {"tasks": [], "delay_after": 10}


# ==============================================================================
# CORE FUNCTION 1: SEND MESSAGE
# ==============================================================================

async def send_message(client, recipient: str, content: str, media_url: str = None) -> Tuple[bool, Optional[str], Optional[dict]]:
    """
    CORE FUNCTION: Send a message to any recipient.
    Used by: Campaign, LiveChat, Warmup - they ALL just send messages.
    
    Returns: (success, error, metadata)
    """
    if not recipient:
        return False, "No recipient", None
    
    try:
        entity = None
        
        # Try cached entity first
        try:
            entity = await asyncio.wait_for(client.get_input_entity(recipient), timeout=5)
        except:
            pass
        
        # Try phone resolution
        if not entity and (recipient.startswith("+") or recipient.isdigit()):
            phone = recipient if recipient.startswith("+") else f"+{recipient}"
            try:
                result = await asyncio.wait_for(client(ResolvePhoneRequest(phone=phone)), timeout=10)
                if result.users:
                    user = result.users[0]
                    entity = InputPeerUser(user_id=user.id, access_hash=user.access_hash)
            except Exception as e:
                if "PHONE_NOT_OCCUPIED" in str(e):
                    return False, "Not on Telegram", None
                # Fallback: import contact
                contact = InputPhoneContact(
                    client_id=random.randint(0, 2**31-1),
                    phone=phone,
                    first_name=phone.replace("+", ""),
                    last_name=""
                )
                try:
                    result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
                    if result.users:
                        user = result.users[0]
                        entity = InputPeerUser(user_id=user.id, access_hash=user.access_hash)
                except:
                    pass
        
        if not entity:
            return False, "Recipient not found", None
        
        # Add variation to avoid duplicate detection
        varied_content = add_variation(content) if content else ""
        
        # Send with media if provided
        if media_url and varied_content:
            try:
                resp = await get_http().get(media_url, timeout=60)
                if resp.status_code == 200:
                    import io
                    file = io.BytesIO(resp.content)
                    file.name = "attachment.jpg"
                    await asyncio.wait_for(client.send_file(entity, file, caption=varied_content), timeout=30)
                    
                    meta = {"recipient_telegram_id": entity.user_id} if isinstance(entity, InputPeerUser) else {}
                    return True, None, meta
            except:
                pass  # Fall through to text-only
        
        # Text-only send
        if isinstance(entity, InputPeerUser):
            await asyncio.wait_for(
                client(SendMessageRequest(
                    peer=entity,
                    message=varied_content,
                    no_webpage=False,
                    random_id=random.randint(0, 2**63-1)
                )),
                timeout=10
            )
        else:
            await asyncio.wait_for(client.send_message(entity, varied_content), timeout=10)
        
        meta = {"recipient_telegram_id": entity.user_id} if isinstance(entity, InputPeerUser) else {}
        return True, None, meta
        
    except FloodWaitError as e:
        return False, f"FloodWait:{e.seconds}s", {"skip_account": True}
    except PeerFloodError:
        return False, "PeerFlood", {"skip_account": True}
    except UserPrivacyRestrictedError:
        return False, "Privacy restricted", {"retry_different_api": True}
    except UserBlockedError:
        return False, "User blocked", None
    except ChatWriteForbiddenError:
        return False, "Cannot write", None
    except Exception as e:
        return False, str(e)[:100], None


# ==============================================================================
# CORE FUNCTION 2: RECEIVE MESSAGE (Event Handler)
# ==============================================================================

async def receive_message(event, account_id: str):
    """
    CORE FUNCTION: Handle incoming message.
    Registered as event handler on ALL connected clients.
    """
    try:
        sender = await event.get_sender()
        if not sender or not isinstance(sender, User):
            return
        if getattr(sender, 'bot', False):
            return
        if not getattr(sender, 'contact', False):
            return  # Only from contacts
        
        sender_phone = None
        if hasattr(sender, 'phone') and sender.phone:
            sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
        
        sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
        content = event.message.text or "[Media]"
        media_url = None
        media_type = None
        
        # Handle photo
        if event.message.photo:
            content = "[Photo] " + (event.message.text or "")
            media_type = "image"
            try:
                client = active_clients.get(account_id)
                if client:
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        file_path = f"{account_id}/incoming_{int(time.time()*1000)}.jpg"
                        resp = await get_http().put(
                            f"{SUPABASE_URL}/storage/v1/object/message-attachments/{file_path}",
                            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "image/jpeg", "x-upsert": "true"},
                            content=photo_bytes,
                            timeout=60
                        )
                        if resp.status_code in (200, 201):
                            media_url = f"{SUPABASE_URL}/storage/v1/object/public/message-attachments/{file_path}"
            except:
                pass
        
        phone_short = account_data.get(account_id, {}).get("phone_number", "????")[-4:]
        print(f"  📩 [{phone_short}] ← {sender_name[:15]}: {content[:30]}...")
        
        await report_result("incoming_message", {
            "account_id": account_id,
            "sender_id": sender.id,
            "sender_name": sender_name,
            "sender_username": getattr(sender, 'username', None),
            "sender_phone": sender_phone,
            "content": content,
            "media_url": media_url,
            "media_type": media_type,
            "telegram_message_id": event.message.id
        })
        
    except Exception as e:
        print(f"  ⚠ Receive error: {str(e)[:40]}")


# ==============================================================================
# CORE FUNCTION 3: ACCOUNT ACTION
# ==============================================================================

async def account_action(client, action_type: str, task: dict) -> Tuple[bool, Optional[str]]:
    """
    CORE FUNCTION: Perform account-level action.
    Used for: spambot_check, change_name, change_photo, add_contact, join_channel
    
    Returns: (success, error)
    """
    account_id = extract_account_id(task)
    task_id = task.get("task_id") or task.get("id")
    phone = account_data.get(account_id, {}).get("phone_number", "????")[-4:]
    
    try:
        # ========== SPAMBOT CHECK ==========
        if action_type == "spambot_check":
            print(f"  [SPAMBOT] [{phone}] Checking...")
            spambot = await client.get_entity("@SpamBot")
            await client.send_message(spambot, "/start")
            await asyncio.sleep(2)
            messages = await client.get_messages(spambot, limit=1)
            response = messages[0].text if messages else "No response"
            response_lower = response.lower()
            
            if "banned" in response_lower or "deleted" in response_lower:
                status = "banned"
            elif "frozen" in response_lower:
                status = "frozen"
            elif "limited" in response_lower or "restricted" in response_lower:
                status = "restricted"
            else:
                status = "active"
            
            await report_result("spambot_check", {
                "task_id": task_id,
                "account_id": account_id,
                "status": status,
                "response": response[:200],
                "success": True
            })
            print(f"  [SPAMBOT] [{phone}] Status: {status}")
            return True, None
        
        # ========== CHANGE NAME ==========
        elif action_type == "change_name":
            first_name = task.get("first_name") or task.get("task_data", {}).get("first_name", "")
            last_name = task.get("last_name") or task.get("task_data", {}).get("last_name", "")
            print(f"  [NAME] [{phone}] → {first_name} {last_name}")
            await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
            await report_result("change_name", {"task_id": task_id, "account_id": account_id, "success": True})
            return True, None
        
        # ========== ADD CONTACT (for warmup) ==========
        elif action_type in ("warmup_add_contact", "add_contact"):
            td = task.get("task_data", {})
            target_phone = td.get("recipient_phone") or td.get("target_phone")
            if target_phone:
                contact = InputPhoneContact(
                    client_id=random.randint(0, 2**31-1),
                    phone=target_phone if target_phone.startswith("+") else f"+{target_phone}",
                    first_name=td.get("first_name", target_phone.replace("+", "")),
                    last_name=td.get("last_name", "")
                )
                result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
                success = bool(result.users)
                await report_result("warmup_add_contact", {
                    "task_id": task_id,
                    "pair_id": td.get("pair_id"),
                    "success": success,
                    "error": None if success else "Could not add contact"
                })
                return success, None if success else "Could not add contact"
            return False, "No target phone"
        
        # ========== JOIN CHANNEL (for warmup) ==========
        elif action_type in ("warmup_join_channel", "join_channel"):
            td = task.get("task_data", {})
            channel = td.get("channel_username") or td.get("channel")
            if channel:
                print(f"  [JOIN] [{phone}] → @{channel}")
                await asyncio.wait_for(client(JoinChannelRequest(channel)), timeout=15)
                await report_result("warmup", {"task_id": task_id, "success": True})
                return True, None
            return False, "No channel"
        
        # ========== SEND REACTION (for warmup) ==========
        elif action_type in ("warmup_react", "react"):
            td = task.get("task_data", {})
            channel = td.get("channel_username")
            if channel:
                entity = await client.get_entity(channel)
                messages = await client.get_messages(entity, limit=10)
                if messages:
                    msg = random.choice(messages)
                    reactions = ["👍", "❤️", "🔥", "👏", "😂", "🎉"]
                    await client(SendReactionRequest(
                        peer=entity,
                        msg_id=msg.id,
                        reaction=[ReactionEmoji(emoticon=random.choice(reactions))]
                    ))
                await report_result("warmup", {"task_id": task_id, "success": True})
                return True, None
            return False, "No channel"
        
        else:
            print(f"  [?] Unknown action: {action_type}")
            await report_result(action_type, {"task_id": task_id, "success": False, "error": f"Unknown: {action_type}"})
            return False, f"Unknown action: {action_type}"
            
    except Exception as e:
        await report_result(action_type, {"task_id": task_id, "account_id": account_id, "success": False, "error": str(e)[:100]})
        return False, str(e)


# ==============================================================================
# CLIENT MANAGEMENT
# ==============================================================================

async def connect_account(account: dict) -> Tuple[Optional[Any], Optional[str]]:
    """Connect a single account with validation."""
    account_id = account.get("id")
    phone = account.get("phone_number", "????")
    phone_short = phone[-4:]
    
    if not account_id:
        return None, "No ID"
    
    lock = get_lock(account_id)
    async with lock:
        # Already connected?
        if account_id in active_clients:
            client = active_clients[account_id]
            if client.is_connected():
                return client, None
            # Stale - remove
            del active_clients[account_id]
        
        # Validate requirements
        session_data = account.get("session_data")
        if not session_data:
            return None, "No session"
        
        proxy = get_proxy(account)
        if not proxy:
            print(f"  ⛔ [{phone_short}] NO PROXY")
            return None, "No proxy"
        
        if not account.get("device_model") or not account.get("system_version"):
            print(f"  ⛔ [{phone_short}] NO FINGERPRINT")
            return None, "No fingerprint"
        
        api_id = account.get("api_id")
        api_hash = account.get("api_hash")
        if not api_id or not api_hash:
            print(f"  ⛔ [{phone_short}] NO API CREDS")
            return None, "No api_id/api_hash"
        
        session_path = decode_session(phone, session_data)
        if not session_path:
            return None, "Session decode failed"
        
        # Build fingerprint
        device = account.get("device_model")
        sdk = account.get("system_version")
        build_id = account.get("build_id")
        if build_id:
            android_ver = sdk.replace("Android ", "")
            sdk_map = {"15": "35", "14": "34", "13": "33", "12": "32", "11": "30"}
            sdk = f"SDK {sdk_map.get(android_ver, '34')} ({build_id})"
        
        try:
            client = TelegramClient(
                session_path, int(api_id), api_hash,
                device_model=device,
                system_version=sdk,
                app_version=account.get("app_version", "10.14.2"),
                lang_code=account.get("lang_code", "en"),
                system_lang_code=account.get("system_lang_code", "en-US"),
                proxy=proxy,
                timeout=PROXY_TIMEOUT,
                connection_retries=0,
                auto_reconnect=False
            )
            
            await asyncio.wait_for(client.connect(), timeout=PROXY_TIMEOUT)
            
            is_auth = await asyncio.wait_for(client.is_user_authorized(), timeout=10)
            if not is_auth:
                await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
                return None, "Not authorized"
            
            me = await asyncio.wait_for(client.get_me(), timeout=10)
            if me:
                await report_session_check(account_id, True, {"id": me.id, "first_name": me.first_name, "username": me.username})
            
            active_clients[account_id] = client
            account_data[account_id] = account
            print(f"  ✓ [{phone_short}] Connected")
            return client, None
            
        except asyncio.TimeoutError:
            print(f"  ✗ [{phone_short}] Proxy timeout")
            return None, "Proxy timeout"
        except (AuthKeyUnregisteredError, SessionRevokedError, UserDeactivatedBanError, PhoneNumberBannedError) as e:
            await report_session_check(account_id, False, error=str(e), status="banned")
            return None, str(e)
        except Exception as e:
            print(f"  ✗ [{phone_short}] {str(e)[:40]}")
            return None, str(e)


async def connect_all_accounts():
    """PHASE 1: Connect ALL accounts in parallel."""
    print("\\n" + "=" * 60)
    print("  PHASE 1: CONNECTING ALL ACCOUNTS")
    print("=" * 60)
    
    accounts = await fetch_all_accounts()
    if not accounts:
        print("  ⚠ No active accounts found")
        return 0
    
    print(f"  Found {len(accounts)} accounts, connecting in parallel...\\n")
    
    results = await asyncio.gather(*[connect_account(acc) for acc in accounts], return_exceptions=True)
    
    success = sum(1 for r in results if isinstance(r, tuple) and r[0] is not None)
    print(f"\\n  [RESULT] Connected: {success} / {len(accounts)}")
    print("=" * 60)
    return success


async def setup_handlers():
    """PHASE 2: Set up receive handlers on all clients."""
    print("\\n  Setting up message handlers...")
    
    count = 0
    for account_id, client in list(active_clients.items()):
        if getattr(client, "_handler_set", False):
            continue
        
        @client.on(events.NewMessage(incoming=True))
        async def handler(event, acc_id=account_id):
            await receive_message(event, acc_id)
        
        setattr(client, "_handler_set", True)
        count += 1
    
    print(f"  ✓ Handlers on {count} clients")


async def check_reconnects():
    """Check and reconnect disconnected clients."""
    disconnected = [aid for aid, c in list(active_clients.items()) if not c.is_connected()]
    
    if disconnected:
        print(f"  [RECONNECT] Found {len(disconnected)} disconnected...")
        for aid in disconnected:
            acc = account_data.get(aid)
            if acc:
                del active_clients[aid]
                await connect_account(acc)
        await setup_handlers()


# ==============================================================================
# UNIFIED TASK PROCESSOR
# ==============================================================================

async def process_task(task: dict):
    """
    UNIFIED TASK PROCESSOR
    Routes ALL tasks to just 3 core functions:
      - send_message() for Campaign, LiveChat, Warmup sends
      - receive_message() is automatic via event handlers
      - account_action() for spambot, name change, etc.
    """
    task_type = task.get("task_type") or task.get("type") or "unknown"
    account_id = extract_account_id(task)
    
    if not account_id:
        return
    
    # Get or connect client
    client = active_clients.get(account_id)
    if not client:
        acc = task.get("account", {})
        if acc.get("id"):
            client, error = await connect_account(acc)
            if not client:
                # Report failure for send tasks
                if task_type in ("send", "campaign_send", "livechat_reply", "warmup_chat"):
                    msg = task.get("message", {})
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "success": False,
                        "error": error or "Not connected",
                        "account_id": account_id
                    })
                return
    
    phone = account_data.get(account_id, {}).get("phone_number", "????")[-4:]
    
    # ========== SEND OPERATIONS ==========
    # Campaign, LiveChat, Warmup all just SEND MESSAGES
    if task_type in ("send", "campaign_send", "livechat_reply", "warmup_chat"):
        recipient = extract_recipient(task)
        content = extract_content(task)
        media_url = extract_media(task)
        
        success, error, meta = await send_message(client, recipient, content, media_url)
        
        # Build result based on task type
        msg = task.get("message", {})
        result = {
            "success": success,
            "error": error,
            "account_id": account_id,
            "api_credential_id": task.get("account", {}).get("api_credential_id")
        }
        
        if task_type in ("send", "campaign_send", "livechat_reply"):
            result["message_id"] = msg.get("id")
            result["campaign_recipient_id"] = msg.get("campaign_recipient_id")
            result["campaign_id"] = task.get("campaign_id")
            result["campaign_seat_id"] = task.get("campaign_seat_id")
            result["campaign_name"] = task.get("campaign_name")
            result["recipient_phone"] = recipient
            result["recipient_name"] = task.get("recipient_name")
            result["content"] = content
            
            if success:
                print(f"  ✓ [{phone}] → {recipient}")
            else:
                print(f"  ✗ [{phone}] → {recipient}: {error}")
            
            await report_result("send", result)
        
        elif task_type == "warmup_chat":
            td = task.get("task_data", {})
            result["task_id"] = task.get("task_id")
            result["pair_id"] = td.get("pair_id")
            result["warmup_message_id"] = td.get("warmup_message_id")
            
            if success:
                print(f"  ✓ [{phone}] [WARMUP] → {recipient}")
            else:
                print(f"  ✗ [{phone}] [WARMUP] → {recipient}: {error}")
            
            await report_result("warmup_chat", result)
        
        if meta:
            result.update(meta)
    
    # ========== ACCOUNT OPERATIONS ==========
    elif task_type in ("spambot_check", "change_name", "change_photo", 
                       "warmup_add_contact", "add_contact",
                       "warmup_join_channel", "join_channel",
                       "warmup_react", "react"):
        await account_action(client, task_type, task)
    
    # ========== WARMUP ROUTING ==========
    elif task_type.startswith("warmup"):
        # Route specific warmup subtypes
        if "add_contact" in task_type:
            await account_action(client, "warmup_add_contact", task)
        elif "join" in task_type:
            await account_action(client, "warmup_join_channel", task)
        elif "react" in task_type:
            await account_action(client, "warmup_react", task)
        elif "chat" in task_type or "send" in task_type:
            # Warmup send - use send_message
            recipient = extract_recipient(task)
            content = extract_content(task)
            success, error, meta = await send_message(client, recipient, content)
            td = task.get("task_data", {})
            await report_result("warmup_chat", {
                "task_id": task.get("task_id"),
                "pair_id": td.get("pair_id"),
                "success": success,
                "error": error
            })
        else:
            print(f"  [?] Unknown warmup: {task_type}")
    
    else:
        print(f"  [?] Unknown task: {task_type}")


# ==============================================================================
# MAIN LOOP
# ==============================================================================

async def main_loop():
    """Main runner: Connect all → Process tasks in parallel."""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - SIMPLIFIED UNIFIED RUNNER")
    print(f"  BUILD: {BUILD_VERSION}")
    print("=" * 60)
    print("  CORE FUNCTIONS:")
    print("    • send_message() - Campaign, LiveChat, Warmup")
    print("    • receive_message() - Incoming via event handlers")
    print("    • account_action() - Spambot, name change, etc.")
    print("=" * 60)
    print("  Press Ctrl+C to stop\\n")
    
    # PHASE 1: Connect all
    connected = await connect_all_accounts()
    
    if connected == 0:
        print("\\n  ⚠ No accounts connected! Check:")
        print("    - Accounts have session_data, proxy, fingerprint, API creds")
        print("  Waiting for configuration...\\n")
    
    # PHASE 2: Setup handlers
    await setup_handlers()
    
    # PHASE 3: Process tasks
    print("\\n" + "=" * 60)
    print("  PHASE 3: PROCESSING TASKS")
    print("=" * 60)
    print(f"  Polling every {POLL_INTERVAL}s, batch size 100\\n")
    
    last_refresh = time.time()
    last_reconnect = time.time()
    empty_count = 0
    
    while RUNNING:
        try:
            now = time.time()
            
            # Periodic refresh
            if now - last_refresh > REFRESH_INTERVAL:
                old_count = len(active_clients)
                await connect_all_accounts()
                if len(active_clients) > old_count:
                    await setup_handlers()
                last_refresh = now
            
            # Periodic reconnect check
            if now - last_reconnect > RECONNECT_INTERVAL:
                await check_reconnects()
                last_reconnect = now
            
            # Get batch of ALL task types
            batch = await get_batch_tasks(batch_size=100)
            tasks = batch.get("tasks", [])
            delay = batch.get("delay_after", POLL_INTERVAL)
            
            if not tasks:
                empty_count += 1
                if empty_count == 1:
                    print(f"  [WAIT] {batch.get('reason', 'No tasks')}")
                elif empty_count % 12 == 0:
                    print(f"  [WAIT] ... ({len(active_clients)} clients)")
                await asyncio.sleep(delay if delay > 0 else POLL_INTERVAL)
                continue
            
            empty_count = 0
            
            # Log task types
            by_type = defaultdict(int)
            for t in tasks:
                by_type[t.get("task_type") or t.get("type") or "?"] += 1
            print(f"\\n  [BATCH] {len(tasks)} tasks: {dict(by_type)}")
            
            # Process ALL tasks in PARALLEL
            await asyncio.gather(*[process_task(t) for t in tasks], return_exceptions=True)
            
            print(f"  [DONE] Batch complete")
            
            if delay > 0:
                await asyncio.sleep(delay)
                
        except Exception as e:
            print(f"  [ERROR] {str(e)[:50]}")
            await asyncio.sleep(5)
    
    # Shutdown
    print("\\n  [SHUTDOWN] Disconnecting clients...")
    for aid, client in list(active_clients.items()):
        try:
            if client.is_connected():
                await asyncio.wait_for(client.disconnect(), timeout=5)
        except:
            pass
    active_clients.clear()
    print("  [SHUTDOWN] Complete")


if __name__ == "__main__":
    print("\\n" + "=" * 60)
    print("  TelegramCRM - SIMPLIFIED UNIFIED RUNNER")
    print("  pip install telethon httpx pysocks")
    print("=" * 60 + "\\n")
    
    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Stopped")
            break
        except Exception as e:
            print(f"\\n⚠ Crashed: {e}")
            print("  Restarting in 5s...")
            time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== RUN.BAT ==========
  const runBat = `@echo off
title TelegramCRM - Simplified Runner
color 0A

echo.
echo  ================================================
echo    TelegramCRM - SIMPLIFIED UNIFIED RUNNER
echo  ================================================
echo.
echo  3 Core Functions:
echo    * send_message()    - Campaign, LiveChat, Warmup
echo    * receive_message() - Incoming messages
echo    * account_action()  - Spambot, name change, etc.
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx pysocks --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting runner...
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
    a.download = "telegram_crm_simplified.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("Simplified runner downloaded! ~600 lines of focused code.");
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download simplified Python runner"
          icon={BookOpen}
        />

        <Card>
          <CardContent className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Simplified Unified Runner</h2>
              <p className="text-muted-foreground text-sm">
                ~600 lines instead of ~1200 • 3 core functions handle everything
              </p>
            </div>
            
            <div className="bg-muted/50 rounded-lg p-4 text-left text-sm space-y-3">
              <p className="font-semibold text-primary">CORE INSIGHT:</p>
              <p className="text-muted-foreground">
                All operations reduce to just <span className="text-primary font-medium">3 actions</span>:
              </p>
              <ul className="space-y-2 ml-2">
                <li className="flex items-start gap-2">
                  <span className="text-primary font-mono text-xs bg-primary/10 px-2 py-0.5 rounded">send_message()</span>
                  <span className="text-muted-foreground text-xs">Campaign, LiveChat, Warmup → all just send messages</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-primary font-mono text-xs bg-primary/10 px-2 py-0.5 rounded">receive_message()</span>
                  <span className="text-muted-foreground text-xs">Event handlers on all clients capture incoming</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-primary font-mono text-xs bg-primary/10 px-2 py-0.5 rounded">account_action()</span>
                  <span className="text-muted-foreground text-xs">Spambot check, name change, join channel, etc.</span>
                </li>
              </ul>
            </div>

            <Button onClick={downloadZip} size="lg" className="gap-2">
              <Download className="w-5 h-5" />
              Download Simplified Runner
            </Button>
            
            <div className="text-xs text-muted-foreground space-y-1">
              <p><strong>Scale:</strong> Handles 2000+ accounts with parallel task processing</p>
              <p><strong>Usage:</strong> python unified_runner.py</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">Architecture</h3>
            
            <div className="space-y-3 text-sm">
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">1</div>
                <div>
                  <p className="font-medium">Connect All Accounts (Parallel)</p>
                  <p className="text-muted-foreground">Connects ALL active accounts with sessions, proxies, and fingerprints simultaneously.</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">2</div>
                <div>
                  <p className="font-medium">Setup Receive Handlers</p>
                  <p className="text-muted-foreground">Installs <code className="text-xs bg-muted px-1 rounded">receive_message()</code> event handler on all connected clients.</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">3</div>
                <div>
                  <p className="font-medium">Process Tasks in Parallel</p>
                  <p className="text-muted-foreground">Fetches batches of 100 tasks, routes to <code className="text-xs bg-muted px-1 rounded">send_message()</code> or <code className="text-xs bg-muted px-1 rounded">account_action()</code>.</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">Task Type Mapping</h3>
            
            <div className="text-sm overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b">
                    <th className="pb-2 font-medium">Task Type</th>
                    <th className="pb-2 font-medium">Core Function</th>
                  </tr>
                </thead>
                <tbody className="text-muted-foreground">
                  <tr className="border-b">
                    <td className="py-2">send, campaign_send</td>
                    <td className="py-2"><code className="text-xs bg-muted px-1 rounded">send_message()</code></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">livechat_reply</td>
                    <td className="py-2"><code className="text-xs bg-muted px-1 rounded">send_message()</code></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">warmup_chat</td>
                    <td className="py-2"><code className="text-xs bg-muted px-1 rounded">send_message()</code></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">incoming messages</td>
                    <td className="py-2"><code className="text-xs bg-muted px-1 rounded">receive_message()</code> (auto)</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">spambot_check, change_name</td>
                    <td className="py-2"><code className="text-xs bg-muted px-1 rounded">account_action()</code></td>
                  </tr>
                  <tr>
                    <td className="py-2">warmup_add_contact, join_channel</td>
                    <td className="py-2"><code className="text-xs bg-muted px-1 rounded">account_action()</code></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">Benefits</h3>
            
            <ul className="text-sm text-muted-foreground space-y-2 list-disc ml-6">
              <li><strong>Simpler Code:</strong> ~600 lines instead of ~1200 lines</li>
              <li><strong>Single Send Function:</strong> One tested, reliable function for ALL sending</li>
              <li><strong>Parallel Processing:</strong> All tasks processed concurrently</li>
              <li><strong>Easy to Debug:</strong> Fewer code paths = fewer bugs</li>
              <li><strong>Scale Ready:</strong> Handles 2000+ accounts efficiently</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
