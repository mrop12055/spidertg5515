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

  // ========== UNIFIED RUNNER - SINGLE FILE FOR EVERYTHING ==========
  const unifiedRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - UNIFIED RUNNER
============================
BUILD: 2026-01-29-unified-v1

ARCHITECTURE: Connect ALL accounts FIRST, then process ALL task types.

This single file replaces:
- config.py
- client_manager.py
- campaign_runner.py
- live_chat_listener.py
- account_manager.py
- warmup_runner.py

WORKFLOW:
=========
PHASE 1: CONNECT ALL ACCOUNTS
  - Fetch all active accounts with sessions from server
  - Connect ALL in parallel (with proxy + fingerprint validation)
  - Store connected clients in memory pool
  
PHASE 2: PROCESS TASKS (continuous loop)
  - Poll server for ALL task types (campaign, livechat, warmup, account)
  - Route tasks to appropriate handlers using pre-connected clients
  - Handle incoming messages via event handlers on connected clients

PER-ACCOUNT API SYSTEM:
  - Each account uses its own api_id/api_hash from JSON metadata
  - Device fingerprints come from JSON (device, sdk, app_version)
  - NO fingerprint generation - must be provided during upload

CRITICAL RULES:
  - NO ACCOUNT RUNS WITHOUT PROXY AND FINGERPRINT
  - Proxy failures = immediate disconnect, admin must fix
  - All clients stay connected until shutdown

Install: pip install telethon httpx pysocks aiohttp

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
import string
import time
import signal
import json
from typing import Dict, Optional, List, Any, Set, Tuple
from collections import defaultdict
from datetime import datetime, timezone, timedelta

# ========== CONFIGURATION ==========
BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_URL_BASE = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"

BUILD_VERSION = "2026-01-29-unified-v1"

# ========== TIMEOUTS ==========
PROXY_CONNECTION_TIMEOUT = 60
HTTP_TIMEOUT_DISPATCH = 90
HTTP_TIMEOUT_REPORT = 60
HTTP_TIMEOUT_UPLOAD = 120
HTTP_TIMEOUT_DEFAULT = 45

# ========== POLLING INTERVALS ==========
POLL_INTERVAL_TASKS = 5      # How often to poll for new tasks
POLL_INTERVAL_ACCOUNTS = 60  # How often to refresh account list
RECONNECT_CHECK_INTERVAL = 30  # How often to check for disconnected clients

# ========== GLOBAL STATE ==========
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_unified_")
active_clients: Dict[str, Any] = {}  # account_id -> TelegramClient
account_data: Dict[str, dict] = {}   # account_id -> account info
message_queues: Dict[str, Any] = {}
RUNNING = True

# ========== PER-ACCOUNT LOCKS (prevents SQLite "database is locked") ==========
_connection_locks: Dict[str, asyncio.Lock] = {}
_connection_locks_mutex = threading.Lock()
_http_client: Optional[httpx.AsyncClient] = None

# ========== ERROR TRACKING ==========
_network_error_count = 0
_last_network_error_time = 0
MAX_NETWORK_BACKOFF = 120

# ========== PROXY ERROR PATTERNS ==========
PROXY_ERROR_PATTERNS = [
    "semaphore timeout", "winerror 121", "connection refused", 
    "proxy", "socks", "timed out", "timeout", "cannot connect",
    "connection reset", "connection closed", "no route"
]

ACCOUNT_ERROR_PATTERNS = {
    "frozen": "frozen",
    "deleted": "banned",
    "deactivated": "banned", 
    "banned": "banned",
    "auth_key_unregistered": "disconnected",
    "session_revoked": "disconnected",
    "user_deactivated": "banned",
    "access_token_expired": "disconnected",
    "restricted": "restricted",
    "phone_number_banned": "banned",
    "input_user_deactivated": "banned"
}

# ========== WARMUP CONSTANTS ==========
WARMUP_CHANNELS = ["telegram", "durov", "tginfo", "techcrunch"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😂", "🎉", "💯", "⭐"]


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
        RPCError, FloodWaitError, UserPrivacyRestrictedError,
        UserBannedInChannelError, ChatWriteForbiddenError, SlowModeWaitError,
        PeerFloodError, UserDeactivatedBanError, AuthKeyUnregisteredError,
        SessionRevokedError, UserBlockedError, PhoneNumberBannedError,
        PhoneNumberInvalidError, InputUserDeactivatedError, UsernameNotOccupiedError,
        UsernameInvalidError, ChannelPrivateError, ChatAdminRequiredError,
        UserNotMutualContactError, MessageNotModifiedError, MediaEmptyError,
        UserAlreadyParticipantError, ReactionInvalidError, MessageIdInvalidError,
        ChannelInvalidError, InviteHashExpiredError
    )
    from telethon.tl.functions.contacts import ResolvePhoneRequest, ImportContactsRequest, GetContactsRequest
    from telethon.tl.functions.messages import SendMessageRequest, SendReactionRequest
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.tl.functions.account import UpdateProfileRequest
    from telethon.tl.functions.photos import UploadProfilePhotoRequest
    from telethon.tl.types import InputPhoneContact, InputPeerUser, ReactionEmoji, User
except ImportError:
    print("ERROR: Telethon not installed. Run: pip install telethon")
    sys.exit(1)


# ==============================================================================
# SECTION 1: UTILITY FUNCTIONS
# ==============================================================================

def get_account_lock(account_id: str) -> asyncio.Lock:
    with _connection_locks_mutex:
        if account_id not in _connection_locks:
            _connection_locks[account_id] = asyncio.Lock()
        return _connection_locks[account_id]


def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT_DEFAULT,
            limits=httpx.Limits(max_connections=500, max_keepalive_connections=100)
        )
    return _http_client


def reset_http_client():
    global _http_client
    if _http_client is not None:
        try:
            asyncio.create_task(_http_client.aclose())
        except:
            pass
        _http_client = None


def is_network_error(error_str: str) -> bool:
    patterns = [
        "network", "connection", "timeout", "unreachable", "reset",
        "winerror 64", "winerror 121", "semaphore", "socket", "dns",
        "host", "refused", "closed", "broken pipe"
    ]
    error_lower = error_str.lower()
    return any(p in error_lower for p in patterns)


def detect_account_status(error_str: str) -> str:
    error_lower = error_str.lower()
    for pattern, status in ACCOUNT_ERROR_PATTERNS.items():
        if pattern in error_lower:
            return status
    return "disconnected"


def decode_session_file(phone_number: str, base64_data: str) -> Optional[str]:
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    try:
        session_bytes = base64.b64decode(base64_data)
        with open(session_path + ".session", "wb") as f:
            f.write(session_bytes)
        return session_path
    except Exception as e:
        print(f"  [ERROR] Session decode: {e}")
        return None


def get_proxy_settings(account: dict, task_proxy: dict = None) -> Optional[tuple]:
    proxy = task_proxy or account.get("proxy") or account.get("proxies")
    if not proxy:
        return None
    
    proxy_type = (proxy.get("proxy_type") or proxy.get("type") or "socks5").lower()
    host = proxy.get("host")
    port = proxy.get("port")
    username = proxy.get("username")
    password = proxy.get("password")
    
    if not host or not port:
        return None
    
    if proxy_type == "socks5":
        ptype = socks.SOCKS5
    elif proxy_type == "socks4":
        ptype = socks.SOCKS4
    else:
        ptype = socks.HTTP
    
    if username and password:
        return (ptype, host, int(port), True, username, password)
    return (ptype, host, int(port))


def add_message_variation(content: str) -> str:
    variations = ['\\u200b', '\\u200c', '\\u200d', '\\ufeff']
    pos = random.randint(0, len(content))
    return content[:pos] + random.choice(variations) + content[pos:]


# ==============================================================================
# SECTION 2: HTTP API FUNCTIONS
# ==============================================================================

async def log_error(runner: str, message: str):
    try:
        http = get_http_client()
        await http.post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"task_type": "log_error", "runner_name": runner, "message": message},
            timeout=10
        )
    except:
        pass


async def report_result(task_type: str, result: dict):
    try:
        http = get_http_client()
        await http.post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"task_type": task_type, **result},
            timeout=HTTP_TIMEOUT_REPORT
        )
    except Exception as e:
        if not is_network_error(str(e)):
            print(f"  [REPORT ERROR] {str(e)[:50]}")


async def report_batch_results(results: list) -> bool:
    try:
        http = get_http_client()
        response = await http.post(
            f"{BACKEND_URL}/report-batch-results",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"results": results},
            timeout=HTTP_TIMEOUT_REPORT
        )
        return response.status_code == 200
    except:
        return False


async def report_session_check(account_id: str, success: bool, telegram_data: dict = None, error: str = None, status: str = None):
    try:
        http = get_http_client()
        await http.post(
            f"{BACKEND_URL}/report-session-check",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={
                "account_id": account_id,
                "success": success,
                "telegram_data": telegram_data,
                "error": error,
                "status": status
            },
            timeout=HTTP_TIMEOUT_REPORT
        )
    except:
        pass


async def save_session_to_db(account_id: str, phone: str):
    try:
        session_path = os.path.join(SESSION_FOLDER, phone.replace("+", "") + ".session")
        if os.path.exists(session_path):
            with open(session_path, "rb") as f:
                session_data = base64.b64encode(f.read()).decode("utf-8")
            
            http = get_http_client()
            await http.patch(
                f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{account_id}",
                headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json", "Prefer": "return=minimal"},
                json={"session_data": session_data},
                timeout=15
            )
    except Exception as e:
        pass


async def fetch_all_accounts() -> List[dict]:
    """Fetch ALL active accounts with sessions from the server."""
    try:
        http = get_http_client()
        response = await http.get(
            f"{SUPABASE_URL}/rest/v1/telegram_accounts?status=eq.active&session_data=not.is.null&select=*,proxies(*)",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            timeout=HTTP_TIMEOUT_DISPATCH
        )
        if response.status_code == 200:
            return response.json()
        return []
    except Exception as e:
        print(f"  [ERROR] Fetch accounts failed: {e}")
        return []


async def get_batch_tasks(runner: str = "unified", batch_size: int = 50) -> dict:
    """Fetch batch of tasks from server."""
    try:
        http = get_http_client()
        response = await http.post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"runner": runner, "batch_size": batch_size},
            timeout=HTTP_TIMEOUT_DISPATCH
        )
        if response.status_code == 200:
            return response.json()
        return {"tasks": [], "delay_after": 5}
    except Exception as e:
        print(f"  [ERROR] Get tasks failed: {str(e)[:50]}")
        return {"tasks": [], "delay_after": 10, "reason": str(e)[:50]}


async def get_next_task(runner: str = "unified") -> dict:
    """Fetch single task from server."""
    try:
        http = get_http_client()
        response = await http.post(
            f"{BACKEND_URL}/get-next-task",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"runner": runner},
            timeout=HTTP_TIMEOUT_DISPATCH
        )
        if response.status_code == 200:
            return response.json()
        return {}
    except:
        return {}


# ==============================================================================
# SECTION 3: CLIENT MANAGEMENT (CONNECT ALL ACCOUNTS)
# ==============================================================================

async def force_disconnect_client(account_id: str, reason: str = "manual"):
    """Force disconnect a client and remove from pool."""
    global active_clients
    phone = account_id[:8]
    
    client = active_clients.pop(account_id, None)
    if client:
        try:
            if hasattr(client, '_updates_handle') and client._updates_handle:
                client._updates_handle.cancel()
            if client.is_connected():
                await asyncio.wait_for(client.disconnect(), timeout=10)
            await asyncio.sleep(0.3)
            del client
            print(f"  [DISCONNECT] {phone} - {reason}")
        except:
            pass
    
    if account_id in message_queues:
        del message_queues[account_id]


async def connect_single_account(account: dict) -> Tuple[Optional[Any], Optional[str]]:
    """Connect a single account with proxy and fingerprint validation."""
    account_id = account.get("id")
    phone = account.get("phone_number", account_id[:8] if account_id else "????")
    phone_short = phone[-4:]
    
    if not account_id:
        return None, "No account ID"
    
    lock = get_account_lock(account_id)
    async with lock:
        # Check if already connected
        if account_id in active_clients:
            client = active_clients[account_id]
            if client.is_connected():
                return client, None
            else:
                # Disconnected - clean up
                await force_disconnect_client(account_id, "stale connection")
        
        # Check session data
        session_data = account.get("session_data")
        if not session_data:
            return None, "No session data"
        
        # Check proxy (MANDATORY)
        proxy_data = account.get("proxies") or account.get("proxy")
        proxy = get_proxy_settings(account)
        if not proxy:
            print(f"  ⛔ [{phone_short}] NO PROXY - skipping")
            return None, "No proxy assigned"
        
        # Check fingerprint (MANDATORY)
        device_model = account.get("device_model")
        system_version = account.get("system_version")
        if not device_model or not system_version:
            print(f"  ⛔ [{phone_short}] NO FINGERPRINT - skipping")
            return None, "No fingerprint (device_model/system_version)"
        
        # Check API credentials (MANDATORY)
        api_id = account.get("api_id")
        api_hash = account.get("api_hash")
        if not api_id or not api_hash:
            print(f"  ⛔ [{phone_short}] NO API CREDENTIALS - skipping")
            return None, "No api_id/api_hash"
        
        # Decode session
        session_path = decode_session_file(phone, session_data)
        if not session_path:
            return None, "Session decode failed"
        
        # Build enhanced fingerprint
        build_id = account.get("build_id")
        app_version = account.get("app_version") or "10.14.2"
        lang_code = account.get("lang_code") or "en"
        system_lang_code = account.get("system_lang_code") or "en-US"
        
        if build_id:
            android_ver = system_version.replace("Android ", "")
            sdk_map = {"15": "35", "14": "34", "13": "33", "12": "32", "11": "30", "10": "29"}
            sdk = sdk_map.get(android_ver, "34")
            system_version = f"SDK {sdk} ({build_id})"
        
        try:
            client = TelegramClient(
                session_path, int(api_id), api_hash,
                device_model=device_model,
                system_version=system_version,
                app_version=app_version,
                lang_code=lang_code,
                system_lang_code=system_lang_code,
                proxy=proxy,
                timeout=PROXY_CONNECTION_TIMEOUT,
                connection_retries=0,
                retry_delay=0,
                auto_reconnect=False,
                request_retries=1
            )
            
            # Connect with timeout
            try:
                await asyncio.wait_for(client.connect(), timeout=PROXY_CONNECTION_TIMEOUT)
            except asyncio.TimeoutError:
                print(f"  ✗ [{phone_short}] Proxy timeout (60s)")
                await report_result("proxy_timeout_disable", {
                    "account_id": account_id,
                    "proxy_id": proxy_data.get("id") if proxy_data else None,
                    "reason": "Proxy connection timeout"
                })
                return None, "Proxy timeout"
            except Exception as e:
                print(f"  ✗ [{phone_short}] Connect error: {str(e)[:30]}")
                return None, str(e)
            
            # Check authorization
            try:
                is_authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=10)
            except Exception as e:
                print(f"  ✗ [{phone_short}] Auth check failed: {str(e)[:30]}")
                return None, str(e)
            
            if not is_authorized:
                await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
                return None, "Not authorized"
            
            # Get user info
            try:
                me = await asyncio.wait_for(client.get_me(), timeout=10)
                if not me:
                    return None, "get_me returned None"
                
                await report_session_check(account_id, success=True, telegram_data={
                    "id": me.id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username
                })
                
            except (AuthKeyUnregisteredError, SessionRevokedError, UserDeactivatedBanError, PhoneNumberBannedError) as e:
                status = detect_account_status(str(e))
                await report_session_check(account_id, success=False, error=str(e), status=status)
                return None, str(e)
            except Exception as e:
                print(f"  ⚠ [{phone_short}] get_me warning: {str(e)[:30]}")
            
            # Store in pool
            active_clients[account_id] = client
            account_data[account_id] = account
            
            print(f"  ✓ [{phone_short}] Connected ({device_model[:15]}...)")
            return client, None
            
        except Exception as e:
            print(f"  ✗ [{phone_short}] Exception: {str(e)[:50]}")
            return None, str(e)


async def connect_all_accounts():
    """PHASE 1: Connect ALL active accounts in parallel."""
    print("\\n" + "=" * 60)
    print("  PHASE 1: CONNECTING ALL ACCOUNTS")
    print("=" * 60)
    
    accounts = await fetch_all_accounts()
    if not accounts:
        print("  ⚠ No active accounts found")
        return 0
    
    print(f"  Found {len(accounts)} active accounts with sessions")
    print(f"  Connecting in parallel (60s timeout per account)...\\n")
    
    # Connect all in parallel
    tasks = [connect_single_account(acc) for acc in accounts]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    success_count = sum(1 for r in results if isinstance(r, tuple) and r[0] is not None)
    fail_count = len(accounts) - success_count
    
    print(f"\\n  [RESULT] Connected: {success_count} | Failed: {fail_count}")
    print("=" * 60)
    
    return success_count


async def setup_message_handlers():
    """Set up incoming message handlers on ALL connected clients."""
    print("\\n  Setting up message handlers on connected clients...")
    
    handler_count = 0
    for account_id, client in list(active_clients.items()):
        try:
            if getattr(client, "_handler_set", False):
                continue
            
            @client.on(events.NewMessage(incoming=True))
            async def handler(event, acc_id=account_id):
                await handle_incoming_message(event, acc_id)
            
            setattr(client, "_handler_set", True)
            handler_count += 1
        except Exception as e:
            print(f"  ⚠ Handler setup failed for {account_id[:8]}: {str(e)[:30]}")
    
    print(f"  ✓ Handlers set up on {handler_count} clients")


async def handle_incoming_message(event, account_id: str):
    """Handle incoming message from any connected client."""
    try:
        sender = await event.get_sender()
        if not sender:
            return
        
        if not isinstance(sender, User):
            return
        if getattr(sender, 'bot', False):
            return
        
        # Only accept messages from contacts
        is_contact = getattr(sender, 'contact', False)
        if not is_contact:
            return
        
        sender_id = sender.id
        sender_username = getattr(sender, 'username', None)
        sender_phone = None
        if hasattr(sender, 'phone') and sender.phone:
            sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
        sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
        
        content = event.message.text or "[Media]"
        media_url = None
        media_type = None
        
        if event.message.photo:
            content = "[Photo] " + (event.message.text or "")
            media_type = "image"
            # Download and upload photo
            try:
                client = active_clients.get(account_id)
                if client:
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        
                        http = get_http_client()
                        upload_response = await http.put(
                            f"{SUPABASE_URL}/storage/v1/object/message-attachments/{file_path}",
                            headers={
                                "apikey": SUPABASE_KEY,
                                "Authorization": f"Bearer {SUPABASE_KEY}",
                                "Content-Type": "image/jpeg",
                                "x-upsert": "true"
                            },
                            content=photo_bytes,
                            timeout=HTTP_TIMEOUT_UPLOAD
                        )
                        if upload_response.status_code in (200, 201):
                            media_url = f"{SUPABASE_URL}/storage/v1/object/public/message-attachments/{file_path}"
            except:
                pass
        
        account = account_data.get(account_id, {})
        account_phone = account.get("phone_number", account_id[:8])
        print(f"  📩 [{account_phone[-4:]}] ← {sender_name[:15]}: {content[:30]}...")
        
        await report_result("incoming_message", {
            "account_id": account_id,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "sender_username": sender_username,
            "sender_phone": sender_phone,
            "sender_avatar": None,
            "content": content,
            "media_url": media_url,
            "media_type": media_type,
            "telegram_message_id": event.message.id
        })
        
    except Exception as e:
        if not is_network_error(str(e)):
            print(f"  ⚠ Message handler error: {str(e)[:50]}")


async def reconnect_disconnected_clients():
    """Check for and reconnect any disconnected clients."""
    global active_clients
    
    disconnected = []
    for account_id, client in list(active_clients.items()):
        try:
            if not client.is_connected():
                disconnected.append(account_id)
        except:
            disconnected.append(account_id)
    
    if disconnected:
        print(f"  [RECONNECT] Found {len(disconnected)} disconnected clients, reconnecting...")
        for acc_id in disconnected:
            account = account_data.get(acc_id)
            if account:
                await force_disconnect_client(acc_id, "reconnecting")
                await connect_single_account(account)
        await setup_message_handlers()


# ==============================================================================
# SECTION 4: TASK HANDLERS
# ==============================================================================

async def send_message(client, recipient: str, content: str, media_url: str = None, recipient_name: str = None, account_id: str = None) -> Tuple[bool, Optional[str], Optional[dict]]:
    """Send a message to a recipient."""
    try:
        # Normalize recipient
        recipient_str = str(recipient) if recipient else ""
        if not recipient_str:
            return False, "No recipient", None
        
        # Try to resolve entity
        entity = None
        
        # Strategy 1: Cached entity
        try:
            entity = await asyncio.wait_for(client.get_input_entity(recipient_str), timeout=5)
        except:
            pass
        
        # Strategy 2: Phone number
        if not entity and (recipient_str.startswith("+") or recipient_str.isdigit()):
            phone = recipient_str if recipient_str.startswith("+") else f"+{recipient_str}"
            try:
                result = await asyncio.wait_for(client(ResolvePhoneRequest(phone=phone)), timeout=10)
                if result.users:
                    user = result.users[0]
                    entity = InputPeerUser(user_id=user.id, access_hash=user.access_hash)
            except Exception as e:
                if "PHONE_NOT_OCCUPIED" in str(e):
                    return False, "User not on Telegram", None
                # Fallback to import
                contact = InputPhoneContact(
                    client_id=random.randint(0, 2**31 - 1),
                    phone=phone,
                    first_name=recipient_name or phone.replace("+", ""),
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
            return False, "Could not find recipient", None
        
        # Add variation
        varied_content = add_message_variation(content)
        
        # Send with media if provided
        if media_url:
            try:
                http = get_http_client()
                resp = await http.get(media_url, timeout=HTTP_TIMEOUT_UPLOAD)
                if resp.status_code == 200:
                    import io
                    from urllib.parse import urlparse, unquote
                    url_path = urlparse(media_url).path
                    filename = unquote(url_path.split("/")[-1]) if url_path else "attachment"
                    
                    content_type = resp.headers.get("content-type", "").lower()
                    ext = filename.split(".")[-1].lower() if "." in filename else ""
                    is_image = ext in ("jpg", "jpeg", "png", "gif", "webp") or content_type.startswith("image/")
                    
                    file_bytes = io.BytesIO(resp.content)
                    file_bytes.name = filename if "." in filename else "photo.jpg"
                    
                    await asyncio.wait_for(
                        client.send_file(entity, file_bytes, caption=varied_content, force_document=not is_image),
                        timeout=30
                    )
                    
                    meta = {}
                    if isinstance(entity, InputPeerUser):
                        meta["recipient_telegram_id"] = entity.user_id
                    return True, None, meta
            except Exception as media_err:
                pass  # Fall through to text-only
        
        # Text-only send
        if isinstance(entity, InputPeerUser):
            await asyncio.wait_for(
                client(SendMessageRequest(
                    peer=entity,
                    message=varied_content,
                    no_webpage=False,
                    random_id=random.randint(0, 2**63 - 1)
                )),
                timeout=10
            )
        else:
            await asyncio.wait_for(client.send_message(entity, varied_content), timeout=10)
        
        meta = {}
        if isinstance(entity, InputPeerUser):
            meta["recipient_telegram_id"] = entity.user_id
        return True, None, meta
        
    except FloodWaitError as e:
        return False, f"FloodWait:{e.seconds}s", {"is_rate_limit": True, "skip_account": True}
    except PeerFloodError as e:
        return False, f"PeerFlood: {str(e)}", {"is_rate_limit": True, "skip_account": True}
    except UserPrivacyRestrictedError:
        return False, "Privacy restricted", {"retry_with_different_api": True}
    except UserBlockedError:
        return False, "User blocked", None
    except ChatWriteForbiddenError:
        return False, "Cannot write", None
    except Exception as e:
        return False, str(e)[:150], None


async def process_campaign_task(task: dict):
    """Process a campaign send task."""
    account = task.get("account", {})
    account_id = account.get("id")
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    
    if not account_id or account_id not in active_clients:
        # Try to connect on-demand
        client, error = await connect_single_account(account)
        if not client:
            await report_result("send", {
                "message_id": msg.get("id"),
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "success": False,
                "error": error or "Not connected",
                "account_id": account_id,
                "api_credential_id": account.get("api_credential_id")
            })
            return
    else:
        client = active_clients[account_id]
    
    phone = account.get("phone_number", "????")[-4:]
    
    success, error, meta = await send_message(
        client, recipient, msg.get("content", ""), msg.get("media_url"), recipient_name, account_id
    )
    
    result = {
        "message_id": msg.get("id"),
        "campaign_recipient_id": msg.get("campaign_recipient_id"),
        "success": success,
        "error": error,
        "account_id": account_id,
        "api_credential_id": account.get("api_credential_id"),
        "content": msg.get("content"),
        "recipient_phone": recipient,
        "recipient_name": recipient_name,
        "campaign_id": task.get("campaign_id"),
        "campaign_seat_id": task.get("campaign_seat_id"),
        "campaign_name": task.get("campaign_name")
    }
    
    if meta:
        result.update(meta)
    
    if success:
        print(f"  ✓ [{phone}] → {recipient}")
    else:
        print(f"  ✗ [{phone}] → {recipient}: {error}")
    
    await report_result("send", result)


async def process_livechat_task(task: dict):
    """Process a livechat reply task."""
    account = task.get("account", {})
    account_id = account.get("id")
    msg = task.get("message", {})
    recipient = task.get("recipient")
    
    client = active_clients.get(account_id)
    if not client:
        await report_result("send", {
            "message_id": msg.get("id"),
            "success": False,
            "error": "Not connected",
            "account_id": account_id
        })
        return
    
    phone = account.get("phone_number", "????")[-4:]
    print(f"  [REPLY] [{phone}] → {recipient}...")
    
    success, error, meta = await send_message(
        client, recipient, msg.get("content", ""), msg.get("media_url"), None, account_id
    )
    
    await report_result("send", {
        "message_id": msg.get("id"),
        "success": success,
        "error": error,
        "account_id": account_id,
        "api_credential_id": account.get("api_credential_id")
    })


async def process_warmup_task(task: dict):
    """Process a warmup task."""
    task_type = task.get("task_type") or task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    account_id = account.get("id")
    
    client = active_clients.get(account_id)
    if not client:
        # Try to connect
        client, error = await connect_single_account(account)
        if not client:
            await report_result("warmup", {"task_id": task_id, "success": False, "error": error})
            return
    
    phone = account.get("phone_number", "????")[-4:]
    
    try:
        if task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            message = task_data.get("message", "Hey! 👋")
            print(f"  [WARMUP] [{phone}] Sending message...")
            
            success, error, _ = await send_message(
                client, recipient_phone, message, None, task_data.get("first_name"), account_id
            )
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": task.get("pair_id"),
                "account_id": account_id,
                "success": success,
                "error": error
            })
            
        elif task_type == "warmup_join_channel":
            channel = task_data.get("channel_username") or random.choice(WARMUP_CHANNELS)
            print(f"  [WARMUP] [{phone}] Joining {channel}...")
            try:
                entity = await asyncio.wait_for(client.get_input_entity(channel), timeout=10)
                await asyncio.wait_for(client(JoinChannelRequest(entity)), timeout=10)
                await report_result("warmup", {"task_id": task_id, "success": True, "account_id": account_id})
            except UserAlreadyParticipantError:
                await report_result("warmup", {"task_id": task_id, "success": True, "account_id": account_id})
            except Exception as e:
                await report_result("warmup", {"task_id": task_id, "success": False, "error": str(e), "account_id": account_id})
                
        elif task_type == "warmup_send_reaction":
            channel = task_data.get("channel_username") or random.choice(WARMUP_CHANNELS)
            print(f"  [WARMUP] [{phone}] Sending reaction to {channel}...")
            try:
                entity = await asyncio.wait_for(client.get_input_entity(channel), timeout=10)
                messages = await asyncio.wait_for(client.get_messages(entity, limit=5), timeout=10)
                if messages:
                    msg = random.choice(messages)
                    reaction = random.choice(REACTIONS)
                    await asyncio.wait_for(
                        client(SendReactionRequest(peer=entity, msg_id=msg.id, reaction=[ReactionEmoji(emoticon=reaction)])),
                        timeout=10
                    )
                    await report_result("warmup", {"task_id": task_id, "success": True, "account_id": account_id})
                else:
                    await report_result("warmup", {"task_id": task_id, "success": False, "error": "No messages", "account_id": account_id})
            except Exception as e:
                await report_result("warmup", {"task_id": task_id, "success": False, "error": str(e), "account_id": account_id})
        
        else:
            print(f"  [WARMUP] [{phone}] Unknown: {task_type}")
            await report_result("warmup", {"task_id": task_id, "success": False, "error": f"Unknown: {task_type}"})
            
    except Exception as e:
        await report_result("warmup", {"task_id": task_id, "success": False, "error": str(e), "account_id": account_id})


async def process_account_task(task: dict):
    """Process an account management task."""
    task_type = task.get("task_type") or task.get("task", "unknown")
    task_id = task.get("task_id") or task.get("id")
    account = task.get("account", {})
    account_id = account.get("id")
    
    client = active_clients.get(account_id)
    if not client:
        client, error = await connect_single_account(account)
        if not client:
            await report_result(task_type, {"task_id": task_id, "success": False, "error": error, "account_id": account_id})
            return
    
    phone = account.get("phone_number", "????")[-4:]
    
    try:
        if task_type == "spambot_check":
            print(f"  [SPAMBOT] [{phone}] Checking...")
            try:
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
                
            except Exception as e:
                await report_result("spambot_check", {
                    "task_id": task_id,
                    "account_id": account_id,
                    "success": False,
                    "error": str(e)
                })
        
        elif task_type == "change_name":
            first_name = task.get("first_name", "")
            last_name = task.get("last_name", "")
            print(f"  [NAME] [{phone}] Changing to {first_name} {last_name}...")
            try:
                await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
                await report_result("change_name", {"task_id": task_id, "account_id": account_id, "success": True})
            except Exception as e:
                await report_result("change_name", {"task_id": task_id, "account_id": account_id, "success": False, "error": str(e)})
        
        else:
            print(f"  [ACCOUNT] [{phone}] Unknown: {task_type}")
            await report_result(task_type, {"task_id": task_id, "success": False, "error": f"Unknown: {task_type}"})
            
    except Exception as e:
        await report_result(task_type, {"task_id": task_id, "success": False, "error": str(e), "account_id": account_id})


# ==============================================================================
# SECTION 5: MAIN LOOP
# ==============================================================================

async def process_task(task: dict):
    """Route a task to the appropriate handler."""
    task_type = task.get("task_type") or task.get("type") or "unknown"
    
    if task_type in ("send", "campaign_send"):
        await process_campaign_task(task)
    elif task_type == "livechat_reply":
        await process_livechat_task(task)
    elif task_type.startswith("warmup"):
        await process_warmup_task(task)
    elif task_type in ("spambot_check", "change_name", "change_photo", "session_check"):
        await process_account_task(task)
    else:
        print(f"  [?] Unknown task type: {task_type}")


async def main_loop():
    """Main runner loop - connects all, then processes tasks."""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - UNIFIED RUNNER")
    print(f"  BUILD: {BUILD_VERSION}")
    print("=" * 60)
    print("  ARCHITECTURE:")
    print("    Phase 1: Connect ALL accounts in parallel")
    print("    Phase 2: Process ALL task types continuously")
    print("    • Campaigns, LiveChat, Warmup, Account tasks")
    print("    • Incoming messages via event handlers")
    print("=" * 60)
    print("  Press Ctrl+C to stop")
    print("=" * 60 + "\\n")
    
    # ========== PHASE 1: CONNECT ALL ACCOUNTS ==========
    connected_count = await connect_all_accounts()
    
    if connected_count == 0:
        print("\\n  ⚠ No accounts connected! Check:")
        print("    - Accounts have session_data")
        print("    - Accounts have assigned proxies")
        print("    - Accounts have fingerprints (device_model, system_version)")
        print("    - Accounts have API credentials (api_id, api_hash)")
        print("\\n  Waiting for accounts to be configured...\\n")
    
    # Set up message handlers on connected clients
    await setup_message_handlers()
    
    # ========== PHASE 2: PROCESS TASKS ==========
    print("\\n" + "=" * 60)
    print("  PHASE 2: PROCESSING TASKS")
    print("=" * 60)
    print(f"  Polling every {POLL_INTERVAL_TASKS}s for new tasks...")
    print(f"  Reconnect check every {RECONNECT_CHECK_INTERVAL}s\\n")
    
    last_account_refresh = time.time()
    last_reconnect_check = time.time()
    consecutive_empty = 0
    
    while RUNNING:
        try:
            now = time.time()
            
            # Periodic account refresh (every 60s)
            if now - last_account_refresh > POLL_INTERVAL_ACCOUNTS:
                print("  [REFRESH] Checking for new accounts...")
                old_count = len(active_clients)
                await connect_all_accounts()
                new_count = len(active_clients)
                if new_count > old_count:
                    await setup_message_handlers()
                last_account_refresh = now
            
            # Periodic reconnect check (every 30s)
            if now - last_reconnect_check > RECONNECT_CHECK_INTERVAL:
                await reconnect_disconnected_clients()
                last_reconnect_check = now
            
            # Fetch tasks (all types)
            batch = await get_batch_tasks(runner="unified", batch_size=50)
            tasks = batch.get("tasks", [])
            delay_after = batch.get("delay_after", POLL_INTERVAL_TASKS)
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    reason = batch.get("reason", "No pending tasks")
                    print(f"  [WAIT] {reason}")
                elif consecutive_empty % 12 == 0:  # Every ~60s at 5s interval
                    print(f"  [WAIT] Still waiting... ({len(active_clients)} clients connected)")
                await asyncio.sleep(delay_after if delay_after > 0 else POLL_INTERVAL_TASKS)
                continue
            
            consecutive_empty = 0
            
            # Group tasks by type for logging
            by_type = defaultdict(int)
            for t in tasks:
                tt = t.get("task_type") or t.get("type") or "unknown"
                by_type[tt] += 1
            type_str = ", ".join(f"{k}:{v}" for k, v in by_type.items())
            print(f"\\n  [BATCH] Processing {len(tasks)} tasks ({type_str})...")
            
            # Process all tasks in parallel
            await asyncio.gather(*[process_task(t) for t in tasks], return_exceptions=True)
            
            print(f"  [DONE] Batch complete")
            
            if delay_after > 0:
                await asyncio.sleep(delay_after)
                
        except Exception as e:
            if is_network_error(str(e)):
                print(f"  [NETWORK] {str(e)[:50]} - waiting 10s...")
                await asyncio.sleep(10)
            else:
                print(f"  [ERROR] {str(e)[:50]}")
                await asyncio.sleep(5)
    
    # Shutdown
    print("\\n  [SHUTDOWN] Saving sessions and disconnecting...")
    for account_id, client in list(active_clients.items()):
        try:
            account = account_data.get(account_id, {})
            phone = account.get("phone_number", account_id)
            await save_session_to_db(account_id, phone)
            if client.is_connected():
                await asyncio.wait_for(client.disconnect(), timeout=5)
        except:
            pass
    active_clients.clear()
    print("  [SHUTDOWN] Complete")


if __name__ == "__main__":
    print("\\n" + "=" * 60)
    print("  TelegramCRM - UNIFIED RUNNER")
    print("  Install: pip install telethon httpx pysocks")
    print("=" * 60 + "\\n")
    
    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Keyboard interrupt - stopping...")
            break
        except Exception as e:
            print(f"\\n⚠ Runner crashed: {e}")
            print("  Restarting in 5 seconds...")
            time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== RUN.BAT ==========
  const runBat = `@echo off
title TelegramCRM - Unified Runner
color 0A

echo.
echo  ================================================
echo       TelegramCRM - UNIFIED RUNNER
echo  ================================================
echo.
echo  This single runner handles:
echo    - Campaign sending
echo    - LiveChat (incoming messages)
echo    - Warmup tasks
echo    - Account management
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx pysocks --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting unified runner...
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
    
    // Single unified runner
    folder?.file("unified_runner.py", unifiedRunnerPy);
    folder?.file("requirements.txt", requirementsTxt);
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm_unified.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("Unified runner downloaded! 3 files included.");
  };


  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python runner to run on your PC"
          icon={BookOpen}
        />

        <Card>
          <CardContent className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Download Unified Runner</h2>
              <p className="text-muted-foreground text-sm">
                Single Python file that handles everything
              </p>
            </div>
            
            <div className="bg-muted/50 rounded-lg p-4 text-left text-sm space-y-2">
              <p className="font-semibold">UNIFIED ARCHITECTURE:</p>
              <p className="text-muted-foreground">
                <span className="text-primary">Phase 1:</span> Connects ALL active accounts in parallel
              </p>
              <p className="text-muted-foreground">
                <span className="text-primary">Phase 2:</span> Processes ALL task types continuously
              </p>
              <ul className="text-muted-foreground ml-4 list-disc">
                <li>Campaign sending</li>
                <li>LiveChat (incoming messages)</li>
                <li>Warmup tasks</li>
                <li>Account management</li>
              </ul>
            </div>

            <Button onClick={downloadZip} size="lg" className="gap-2">
              <Download className="w-5 h-5" />
              Download unified_runner.py
            </Button>
            
            <div className="text-xs text-muted-foreground space-y-1">
              <p><strong>Requirements:</strong> Python 3.8+ with telethon, httpx, pysocks</p>
              <p><strong>Usage:</strong> Double-click RUN.bat or run: python unified_runner.py</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">How It Works</h3>
            
            <div className="space-y-3 text-sm">
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">1</div>
                <div>
                  <p className="font-medium">Connect All Accounts</p>
                  <p className="text-muted-foreground">On startup, connects ALL active accounts with sessions, proxies, and fingerprints in parallel.</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">2</div>
                <div>
                  <p className="font-medium">Set Up Message Handlers</p>
                  <p className="text-muted-foreground">Installs event handlers on all connected clients to receive incoming messages in real-time.</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">3</div>
                <div>
                  <p className="font-medium">Process Tasks Continuously</p>
                  <p className="text-muted-foreground">Polls server every 5 seconds for ALL task types (campaigns, warmup, account management) and processes them using pre-connected clients.</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">4</div>
                <div>
                  <p className="font-medium">Auto-Reconnect</p>
                  <p className="text-muted-foreground">Checks for disconnected clients every 30 seconds and reconnects them. Refreshes account list every 60 seconds to pick up new accounts.</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">Account Requirements</h3>
            
            <div className="text-sm text-muted-foreground space-y-2">
              <p>Each account MUST have (from JSON metadata during upload):</p>
              <ul className="list-disc ml-6 space-y-1">
                <li><strong>Session data</strong> - The .session file</li>
                <li><strong>Proxy</strong> - Assigned in admin dashboard</li>
                <li><strong>Fingerprint</strong> - device_model, system_version from JSON</li>
                <li><strong>API credentials</strong> - api_id, api_hash from JSON</li>
              </ul>
              <p className="mt-3 text-primary">Accounts missing any of these will be skipped!</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">JSON Metadata Format</h3>
            
            <pre className="bg-muted p-4 rounded-lg text-xs overflow-x-auto">
{`{
  "app_id": "12345678",
  "app_hash": "abc123...",
  "device": "Samsung Galaxy S21",
  "sdk": "Android 12",
  "app_version": "10.14.2",
  "lang_pack": "en",
  "system_lang_pack": "en-US",
  "twoFA": "optional_password"
}`}
            </pre>
            
            <p className="text-xs text-muted-foreground">
              Upload ZIP files containing session files (.session) paired with JSON metadata files (.json) with matching names.
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
