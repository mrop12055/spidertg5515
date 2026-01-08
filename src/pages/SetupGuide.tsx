import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, Loader2, Server, Monitor, Upload, CheckCircle2, RefreshCw, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { supabase } from '@/integrations/supabase/client';
import { VPSControlPanel } from '@/components/setup/VPSControlPanel';

const SetupGuide: React.FC = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [lastSyncTime, setLastSyncTime] = React.useState<Date | null>(null);

  // ========== 1. CONFIG.PY ==========
  const configPy = `"""
TelegramCRM - Shared Configuration
===================================
All shared settings for Python runners
"""

# Backend Configuration
BACKEND_URL = "${supabaseUrl}/functions/v1"
# Base project URL (used for REST + Storage endpoints)
SUPABASE_URL = BACKEND_URL.split("/functions/v1")[0]

# API key used by runners for backend + storage calls
SUPABASE_KEY = "${supabaseKey}"

# Telegram API credentials
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"
`;

  // ========== 2. CLIENT_MANAGER.PY (Synced from /python) ==========
  const clientManagerPy = `"""
TelegramCRM - Client Manager (Server-Controlled)
==================================================
Shared Telegram client logic for all runners.
All settings (batch sizes, delays, limits) controlled by server.
"""

import os
import base64
import tempfile
import asyncio
import httpx
import socks
from typing import Dict, Optional

from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError
from telethon.network.connection import ConnectionTcpFull

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

# Temp folder for session files
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")

# Active clients cache
active_clients: Dict[str, TelegramClient] = {}

# Phone lookup cache: phone -> telegram_id (speeds up repeated lookups)
_phone_cache: Dict[str, int] = {}

# Connection settings
CONNECTION_TIMEOUT = 30
CONNECTION_RETRIES = 3
RETRY_DELAY = 2

# Shared HTTP clients
# - Prevents socket exhaustion from creating a new client for every request
# - Also surfaces real connection/SSL errors instead of silently "waiting"
_BACKEND_HTTP: Optional[httpx.AsyncClient] = None
_BACKEND_HTTP_LOOP = None

_MEDIA_HTTP: Optional[httpx.AsyncClient] = None
_MEDIA_HTTP_LOOP = None


def _http_limits() -> httpx.Limits:
    return httpx.Limits(max_connections=40, max_keepalive_connections=20, keepalive_expiry=30.0)


async def _get_backend_http() -> httpx.AsyncClient:
    global _BACKEND_HTTP, _BACKEND_HTTP_LOOP
    loop = asyncio.get_running_loop()
    if (
        _BACKEND_HTTP is None
        or getattr(_BACKEND_HTTP, "is_closed", False)
        or _BACKEND_HTTP_LOOP is not loop
    ):
        if _BACKEND_HTTP is not None and not getattr(_BACKEND_HTTP, "is_closed", False):
            try:
                await _BACKEND_HTTP.aclose()
            except Exception:
                pass
        _BACKEND_HTTP = httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, connect=15.0),
            limits=_http_limits(),
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
        )
        _BACKEND_HTTP_LOOP = loop
    return _BACKEND_HTTP


async def _get_media_http() -> httpx.AsyncClient:
    global _MEDIA_HTTP, _MEDIA_HTTP_LOOP
    loop = asyncio.get_running_loop()
    if _MEDIA_HTTP is None or getattr(_MEDIA_HTTP, "is_closed", False) or _MEDIA_HTTP_LOOP is not loop:
        if _MEDIA_HTTP is not None and not getattr(_MEDIA_HTTP, "is_closed", False):
            try:
                await _MEDIA_HTTP.aclose()
            except Exception:
                pass
        _MEDIA_HTTP = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=20.0), limits=_http_limits())
        _MEDIA_HTTP_LOOP = loop
    return _MEDIA_HTTP


async def _close_http_clients():
    global _BACKEND_HTTP, _BACKEND_HTTP_LOOP, _MEDIA_HTTP, _MEDIA_HTTP_LOOP
    if _BACKEND_HTTP is not None and not getattr(_BACKEND_HTTP, "is_closed", False):
        try:
            await _BACKEND_HTTP.aclose()
        except Exception:
            pass
    if _MEDIA_HTTP is not None and not getattr(_MEDIA_HTTP, "is_closed", False):
        try:
            await _MEDIA_HTTP.aclose()
        except Exception:
            pass
    _BACKEND_HTTP = None
    _BACKEND_HTTP_LOOP = None
    _MEDIA_HTTP = None
    _MEDIA_HTTP_LOOP = None

def decode_session_file(phone_number: str, base64_data: str) -> Optional[str]:
    """Decode base64 session data and save to temp file"""
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    try:
        session_bytes = base64.b64decode(base64_data)
        with open(session_path + ".session", "wb") as f:
            f.write(session_bytes)
        return session_path
    except Exception as e:
        print(f"  [ERROR] Session decode failed: {e}")
        return None


def get_proxy_settings(account: dict, task_proxy: dict = None) -> Optional[tuple]:
    """Extract proxy settings from account data or task-level proxy."""
    proxy = task_proxy or account.get("proxy")
    if not proxy:
        return None
    
    proxy_type = proxy.get("proxy_type", "socks5").lower()
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
    elif proxy_type in ("http", "https"):
        ptype = socks.HTTP
    else:
        ptype = socks.SOCKS5
    
    if username and password:
        return (ptype, host, int(port), True, username, password)
    else:
        return (ptype, host, int(port))


async def connect_with_retry(client: TelegramClient, account_id: str = None) -> tuple[bool, str, bool]:
    """Connect with NO RETRY on proxy errors.
    
    Returns: (success, error_message, is_proxy_error)
    
    On proxy error: immediately returns failure so proxy can be changed.
    Does NOT retry - just reports and moves on.
    """
    try:
        await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
        return (True, "", False)
    except asyncio.TimeoutError:
        return (False, "Connection timeout - proxy may be slow or unresponsive", True)
    except ConnectionRefusedError:
        return (False, "Proxy connection refused", True)
    except OSError as e:
        error_str = str(e).lower()
        is_proxy = any(x in error_str for x in ["proxy", "socks", "connect", "network", "unreachable"])
        return (False, f"Connection error: {e}", is_proxy)
    except Exception as e:
        error_str = str(e).lower()
        is_proxy = any(x in error_str for x in ["proxy", "socks", "connection refused", "connect error", "unreachable", "timeout"])
        return (False, f"Connection failed: {e}", is_proxy)


async def get_or_create_client(account: dict, setup_handler=None, skip_avatar: bool = True, force_profile_sync: bool = False, task_proxy: dict = None) -> Optional[TelegramClient]:
    """Get existing client or create new one with unique device fingerprint.
    
    Uses existing fingerprint if available, generates new one only if missing.
    On proxy error: reports and changes proxy, returns None immediately (no retry).
    """
    account_id = account["id"]
    
    # Return cached client if connected
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                if setup_handler and not getattr(client, "_handler_installed", False):
                    await setup_handler(client, account_id)
                    setattr(client, "_handler_installed", True)
                if force_profile_sync:
                    await _sync_profile(client, account_id, skip_avatar=False)
                return client
        except:
            del active_clients[account_id]
    
    session_data = account.get("session_data")
    if not session_data:
        print(f"  [SKIP] No session: {account.get('phone_number', 'unknown')}")
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    # Use existing fingerprint if available, generate only if missing
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version")
    lang_code = account.get("lang_code") or "en"
    system_lang_code = account.get("system_lang_code") or "en-US"
    
    if not device_model or not system_version:
        # Generate new fingerprint only if not exists
        fp = generate_fingerprint()
        device_model = fp["device_model"]
        system_version = fp["system_version"]
        app_version = fp["app_version"]
        lang_code = fp["lang_code"]
        system_lang_code = fp["system_lang_code"]
        print(f"  [FP] Generated NEW: {device_model} ({system_version})")
        
        # Report fingerprint to server to save it
        await report_result("fingerprint_generated", {
            "account_id": account_id,
            "device_model": device_model,
            "system_version": system_version,
            "app_version": app_version,
            "lang_code": lang_code,
            "system_lang_code": system_lang_code
        })
    else:
        print(f"  [FP] Using existing: {device_model} ({system_version})")
    
    proxy = get_proxy_settings(account, task_proxy)
    if proxy:
        print(f"  [PROXY] Using: {proxy[1]}:{proxy[2]}")
    else:
        print(f"  [WARN] No proxy configured for {account.get('phone_number', 'unknown')}")
    
    try:
        api_creds = account.get("telegram_api_credentials")
        if api_creds and api_creds.get("api_id") and api_creds.get("api_hash"):
            api_id = api_creds["api_id"]
            api_hash = api_creds["api_hash"]
            print(f"  [API] Using credential: {api_creds.get('client_type', 'unknown')} ({api_id})")
        else:
            api_id = account.get("api_id") or TELEGRAM_API_ID
            api_hash = account.get("api_hash") or TELEGRAM_API_HASH
            print(f"  [API] Using account/default API: {api_id}")
        
        client = TelegramClient(
            session_path, 
            int(api_id), 
            api_hash,
            device_model=device_model,
            system_version=system_version,
            app_version=app_version,
            lang_code=lang_code,
            system_lang_code=system_lang_code,
            proxy=proxy,
            timeout=CONNECTION_TIMEOUT,
            connection_retries=CONNECTION_RETRIES,
            retry_delay=RETRY_DELAY,
            auto_reconnect=True,
            request_retries=3
        )
        
        print(f"  [CONNECT] {account['phone_number']}...")
        connected, connect_error, is_proxy_error = await connect_with_retry(client, account_id)
        if not connected:
            print(f"  [FAIL] Could not connect: {account['phone_number']} - {connect_error}")
            
            if is_proxy_error:
                # Proxy error - report and request proxy change (NO RETRY)
                print(f"  [PROXY] Error detected - requesting proxy change for {account['phone_number']}")
                await report_result("proxy_error", {
                    "account_id": account_id, 
                    "reason": connect_error,
                    "proxy_id": f"{proxy[1]}:{proxy[2]}" if proxy else None,
                    "change_proxy": True  # Signal to change proxy
                })
            else:
                await report_result("account_disconnected", {"account_id": account_id, "reason": connect_error})
            return None
        
        if not await client.is_user_authorized():
            print(f"  [EXPIRED] Session expired: {account['phone_number']}")
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        try:
            me = await asyncio.wait_for(client.get_me(), timeout=15)
            if not me:
                print(f"  [DELETED] Account deleted: {account['phone_number']}")
                await report_result("account_banned", {"account_id": account_id, "reason": "Account deleted or banned"})
                return None
        except Exception as me_error:
            error_str = str(me_error).lower()
            if any(x in error_str for x in ["user_deactivated", "deactivated"]):
                print(f"  [FROZEN] Account deleted by user: {account['phone_number']} - {me_error}")
                await report_result("account_frozen", {"account_id": account_id, "reason": str(me_error)})
                return None
            elif any(x in error_str for x in ["banned", "deleted"]):
                print(f"  [BANNED] Account banned by Telegram: {account['phone_number']} - {me_error}")
                await report_result("account_banned", {"account_id": account_id, "reason": str(me_error)})
                return None
            elif any(x in error_str for x in ["session", "revoked", "auth", "auth_key"]):
                print(f"  [EXPIRED] Session revoked: {account['phone_number']} - {me_error}")
                await report_result("account_disconnected", {"account_id": account_id, "reason": str(me_error)})
                return None
            else:
                print(f"  [WARN] get_me error: {me_error}")
        
        if setup_handler:
            await setup_handler(client, account_id)
            setattr(client, "_handler_installed", True)
        
        active_clients[account_id] = client
        
        # Only sync profile once per client (skip if already synced)
        if not getattr(client, "_profile_synced", False):
            await _sync_profile(client, account_id, skip_avatar=skip_avatar)
            setattr(client, "_profile_synced", True)
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["user_deactivated", "deactivated"]):
            print(f"  [FROZEN] {account['phone_number']}: {e}")
            await report_result("account_frozen", {"account_id": account_id, "reason": str(e)})
        elif any(x in error_str for x in ["deleted", "banned"]):
            print(f"  [BANNED] {account['phone_number']}: {e}")
            await report_result("account_banned", {"account_id": account_id, "reason": str(e)})
        else:
            print(f"  [FAIL] {account['phone_number']}: {e}")
        return None


async def _sync_profile(client: TelegramClient, account_id: str, skip_avatar: bool = True):
    """Fetch and report account profile data."""
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if me:
            avatar_base64 = None
            if not skip_avatar:
                try:
                    photos = await asyncio.wait_for(client.get_profile_photos(me, limit=1), timeout=10)
                    if photos:
                        photo_bytes = await asyncio.wait_for(client.download_media(photos[0], file=bytes), timeout=15)
                        if photo_bytes:
                            avatar_base64 = base64.b64encode(photo_bytes).decode('utf-8')
                except:
                    pass
            
            has_profile = bool(me.first_name or me.last_name or me.username)
            
            if not has_profile:
                print(f"  [FROZEN] Account has no profile info (possibly deleted by user)")
                await report_result("account_frozen", {
                    "account_id": account_id,
                    "reason": "No profile info - account may be deleted by user",
                    "telegram_id": me.id
                })
            else:
                await report_result("account_connected", {
                    "account_id": account_id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username,
                    "telegram_id": me.id,
                    "phone": me.phone,
                    "avatar_base64": avatar_base64
                })
        else:
            print(f"  [FROZEN] get_me() returned None - account may be deleted")
            await report_result("account_frozen", {
                "account_id": account_id,
                "reason": "get_me() returned None - account deleted by user"
            })
    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["user_deactivated", "deactivated"]):
            print(f"  [FROZEN] Account deactivated by user: {e}")
            await report_result("account_frozen", {
                "account_id": account_id,
                "reason": f"User deactivated: {e}"
            })
        else:
            print(f"  [WARN] Profile sync error: {e}")


async def get_next_task(runner: str = None) -> dict:
    """Ask backend for next task."""
    try:
        body = {"runner": runner} if runner else {}
        http = await _get_backend_http()
        resp = await http.post(f"{BACKEND_URL}/get-next-task", json=body)
        return resp.json()
    except Exception as e:
        # IMPORTANT: Surface errors (SSL/time/firewall) instead of silently returning "wait"
        print(f"  [BACKEND ERROR] get-next-task: {type(e).__name__}: {e}")
        return {"task": "wait", "seconds": 3, "reason": f"backend_error:{type(e).__name__}"}


async def get_batch_tasks(runner: str = None) -> dict:
    """Ask backend for batch of tasks - server controls batch size."""
    try:
        body = {"runner": runner} if runner else {}
        http = await _get_backend_http()
        resp = await http.post(f"{BACKEND_URL}/get-batch-tasks", json=body)
        return resp.json()
    except Exception as e:
        print(f"  [BACKEND ERROR] get-batch-tasks: {type(e).__name__}: {e}")
        return {
            "tasks": [],
            "delay_after": 7,
            "reason": f"Backend unreachable ({type(e).__name__})",
        }


async def report_result(task_type: str, result: dict):
    """Report task result to backend."""
    try:
        http = await _get_backend_http()
        await http.post(
            f"{BACKEND_URL}/report-task-result",
            json={"task_type": task_type, "result": result},
        )
    except Exception as e:
        print(f"  [WARN] Failed to report result: {type(e).__name__}: {e}")


async def report_batch_results(results: list) -> bool:
    """Report multiple campaign results in a single request.
    
    Much faster than individual reports - reduces HTTP overhead significantly.
    Returns True if batch was accepted, False if should fall back to individual.
    """
    if not results:
        return True
    
    try:
        http = await _get_backend_http()
        resp = await http.post(
            f"{BACKEND_URL}/report-batch-results",
            json={"results": results},
            timeout=30.0  # Allow more time for batch processing
        )
        if resp.status_code == 200:
            return True
        elif resp.status_code == 404:
            # Endpoint doesn't exist yet, fall back to individual
            return False
        else:
            print(f"  [WARN] Batch report returned {resp.status_code}")
            return False
    except Exception as e:
        print(f"  [WARN] Batch report failed: {type(e).__name__}: {e}")
        return False


async def send_message(client: TelegramClient, recipient, content: str, media_url: str = None):
    """Send a message and return (success, error, meta)."""
    global _phone_cache
    meta = None
    original_recipient = recipient
    try:
        entity = None

        # Fast path: telegram user id
        if isinstance(recipient, int):
            entity = await asyncio.wait_for(client.get_entity(recipient), timeout=10)
        else:
            recipient_str = str(recipient or "").strip()

            if recipient_str.isdigit():
                entity = await asyncio.wait_for(client.get_entity(int(recipient_str)), timeout=10)
            elif recipient_str.startswith("@"): 
                entity = await asyncio.wait_for(client.get_entity(recipient_str), timeout=15)
            else:
                from telethon.tl.functions.contacts import ImportContactsRequest
                from telethon.tl.types import InputPhoneContact
                import random

                phone = recipient_str
                if not phone.startswith("+"):
                    phone = "+" + phone

                # Check phone cache first for faster lookup
                if phone in _phone_cache:
                    try:
                        entity = await asyncio.wait_for(client.get_entity(_phone_cache[phone]), timeout=10)
                        if entity:
                            print(f"  [CACHE] Using cached telegram_id for {phone}")
                    except Exception:
                        # Cache entry invalid, remove it
                        del _phone_cache[phone]
                        entity = None

                if not entity:
                    try:
                        entity = await asyncio.wait_for(client.get_entity(phone), timeout=10)
                    except Exception:
                        pass

                if not entity:
                    max_retries = 2
                    for attempt in range(max_retries + 1):
                        contact = InputPhoneContact(
                            client_id=random.randint(0, 2**62),
                            phone=phone,
                            first_name="TG",
                            last_name=str(random.randint(1000, 9999))
                        )
                        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)

                        if result.users:
                            entity = result.users[0]
                            # Cache the phone -> telegram_id mapping
                            if hasattr(entity, 'id'):
                                _phone_cache[phone] = entity.id
                                print(f"  [CACHE] Cached telegram_id {entity.id} for {phone}")
                            break
                        elif result.retry_contacts:
                            if attempt < max_retries:
                                print(f"  [RATE] Contact lookup rate limited, retrying in 3s (attempt {attempt + 1}/{max_retries})")
                                await asyncio.sleep(3)
                            else:
                                try:
                                    from telethon.tl.functions.contacts import ResolvePhoneRequest
                                    resolve_result = await asyncio.wait_for(client(ResolvePhoneRequest(phone=phone)), timeout=10)
                                    if resolve_result.users:
                                        entity = resolve_result.users[0]
                                        if hasattr(entity, 'id'):
                                            _phone_cache[phone] = entity.id
                                        break
                                except Exception as resolve_err:
                                    print(f"  [WARN] ResolvePhoneRequest failed: {resolve_err}")
                                return False, "Contact lookup rate limited - try again later", None
                        else:
                            break

        if not entity:
            return False, "User not found on Telegram", None

        meta = {
            "recipient_telegram_id": getattr(entity, "id", None),
            "recipient_username": getattr(entity, "username", None),
        }

        # Format URLs as Markdown links
        formatted_content = content
        parse_mode = None
        try:
            import re
            url_re = re.compile(r'(https?://[^\\s<>"\\']+)')
            if content and url_re.search(content):
                parse_mode = 'md'

                def _to_md_link(m):
                    url = m.group(1)
                    return f"[{url}]({url})"

                formatted_content = url_re.sub(_to_md_link, content)
                print(f"  [LINK] Formatted with Markdown: {formatted_content[:120]}...")
        except Exception as e:
            print(f"  [LINK ERROR] {e}")
            formatted_content = content
            parse_mode = None

        # Send message
        if media_url:
            try:
                import io
                http = await _get_media_http()
                media_resp = await http.get(media_url)
                if media_resp.status_code == 200:
                    from urllib.parse import urlparse, unquote
                    url_path = urlparse(media_url).path
                    filename = unquote(url_path.split("/")[-1]) if url_path else "attachment"

                    content_type = media_resp.headers.get("content-type", "").lower()
                    ext = filename.split(".")[-1].lower() if "." in filename else ""
                    is_image = ext in ("jpg", "jpeg", "png", "gif", "webp") or content_type.startswith("image/")

                    file_bytes = io.BytesIO(media_resp.content)
                    file_bytes.name = filename if "." in filename else "photo.jpg"

                    print(f"  [MEDIA] filename={filename}, content_type={content_type}, is_image={is_image}")

                    await asyncio.wait_for(
                        client.send_file(entity, file_bytes, caption=formatted_content, force_document=not is_image, parse_mode=parse_mode),
                        timeout=30
                    )
                else:
                    await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
            except Exception as media_err:
                print(f"  [MEDIA ERROR] {media_err}")
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
        else:
            await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)

        return True, None, meta
    except asyncio.TimeoutError:
        return False, "Request timeout", meta
    except UserPrivacyRestrictedError as e:
        return False, f"UserPrivacyRestrictedError: {e}", meta
    except FloodWaitError as e:
        return False, f"FloodWaitError: {e.seconds}s wait required (caused by {e.request.__class__.__name__ if e.request else 'unknown'})", meta
    except Exception as e:
        error_str = str(e)
        error_type = type(e).__name__
        if "No user has" in error_str:
            return False, f"{error_type}: Username not found - {error_str}", meta
        if "private" in error_str.lower():
            return False, f"{error_type}: Private profile - {error_str}", meta
        return False, f"{error_type}: {error_str}", meta


async def validate_contact(client: TelegramClient, phone: str):
    """Check if phone number exists on Telegram"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        import random
        
        contact = InputPhoneContact(
            client_id=random.randint(0, 2**31 - 1),
            phone=phone,
            first_name="V",
            last_name=""
        )
        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
        
        if result.users:
            user = result.users[0]
            name = f"{user.first_name or ''} {user.last_name or ''}".strip()
            return True, name, user.id
        return False, None, None
    except asyncio.TimeoutError:
        raise Exception("Validation timeout")
    except Exception as e:
        raise e


async def disconnect_client(account_id: str):
    """Disconnect a single client after task completion."""
    if account_id in active_clients:
        try:
            await asyncio.wait_for(active_clients[account_id].disconnect(), timeout=5)
            print(f"  [DISCONNECT] {account_id[:8]}...")
        except:
            pass
        del active_clients[account_id]


async def disconnect_batch(account_ids: list):
    """Disconnect multiple clients after batch completion."""
    disconnected = 0
    for acc_id in account_ids:
        if acc_id in active_clients:
            try:
                await asyncio.wait_for(active_clients[acc_id].disconnect(), timeout=5)
            except:
                pass
            del active_clients[acc_id]
            disconnected += 1
    if disconnected > 0:
        print(f"  [CLEANUP] Disconnected {disconnected} clients after batch")


async def shutdown_all():
    """Cleanup all clients on shutdown"""
    print("\\n[SHUTDOWN] Disconnecting all clients...")
    for account_id, client in list(active_clients.items()):
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except:
            pass
    active_clients.clear()
    print("[OK] All clients disconnected.")
`;

  // ========== 3. FINGERPRINT_GENERATOR.PY ==========
  const fingerprintGeneratorPy = `"""
Device Fingerprint Generator for Telegram Accounts
Generates unique, realistic device fingerprints to avoid detection
"""

import random

# Realistic Android devices with proper models and versions
ANDROID_DEVICES = [
    {"model": "Samsung SM-G991B", "brand": "Samsung", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "Samsung SM-G998B", "brand": "Samsung", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "Samsung SM-A525F", "brand": "Samsung", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "Samsung SM-A536B", "brand": "Samsung", "versions": ["Android 12", "Android 13", "Android 14"]},
    {"model": "Samsung SM-S911B", "brand": "Samsung", "versions": ["Android 13", "Android 14"]},
    {"model": "Samsung SM-S918B", "brand": "Samsung", "versions": ["Android 13", "Android 14"]},
    {"model": "Samsung SM-A546B", "brand": "Samsung", "versions": ["Android 13", "Android 14"]},
    {"model": "Xiaomi 12", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi 12 Pro", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi 13", "brand": "Xiaomi", "versions": ["Android 13", "Android 14"]},
    {"model": "Xiaomi 13 Pro", "brand": "Xiaomi", "versions": ["Android 13", "Android 14"]},
    {"model": "Xiaomi Redmi Note 12", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi Redmi Note 12 Pro", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi POCO F5", "brand": "Xiaomi", "versions": ["Android 13", "Android 14"]},
    {"model": "OnePlus 9", "brand": "OnePlus", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "OnePlus 9 Pro", "brand": "OnePlus", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "OnePlus 10 Pro", "brand": "OnePlus", "versions": ["Android 12", "Android 13"]},
    {"model": "OnePlus 11", "brand": "OnePlus", "versions": ["Android 13", "Android 14"]},
    {"model": "OnePlus Nord 3", "brand": "OnePlus", "versions": ["Android 13", "Android 14"]},
    {"model": "Google Pixel 6", "brand": "Google", "versions": ["Android 12", "Android 13", "Android 14"]},
    {"model": "Google Pixel 6 Pro", "brand": "Google", "versions": ["Android 12", "Android 13", "Android 14"]},
    {"model": "Google Pixel 7", "brand": "Google", "versions": ["Android 13", "Android 14"]},
    {"model": "Google Pixel 7 Pro", "brand": "Google", "versions": ["Android 13", "Android 14"]},
    {"model": "Google Pixel 8", "brand": "Google", "versions": ["Android 14"]},
    {"model": "Google Pixel 8 Pro", "brand": "Google", "versions": ["Android 14"]},
    {"model": "HUAWEI P40 Pro", "brand": "Huawei", "versions": ["Android 10", "Android 11"]},
    {"model": "HUAWEI P50 Pro", "brand": "Huawei", "versions": ["Android 11", "Android 12"]},
    {"model": "HUAWEI Mate 50 Pro", "brand": "Huawei", "versions": ["Android 12", "Android 13"]},
    {"model": "OPPO Find X5 Pro", "brand": "OPPO", "versions": ["Android 12", "Android 13"]},
    {"model": "OPPO Reno 8 Pro", "brand": "OPPO", "versions": ["Android 12", "Android 13"]},
    {"model": "vivo X80 Pro", "brand": "vivo", "versions": ["Android 12", "Android 13"]},
    {"model": "vivo V27 Pro", "brand": "vivo", "versions": ["Android 13"]},
    {"model": "Realme GT 3", "brand": "Realme", "versions": ["Android 13"]},
    {"model": "Realme 11 Pro+", "brand": "Realme", "versions": ["Android 13"]},
    {"model": "Motorola Edge 40 Pro", "brand": "Motorola", "versions": ["Android 13"]},
    {"model": "Sony Xperia 1 V", "brand": "Sony", "versions": ["Android 13", "Android 14"]},
    {"model": "ASUS ROG Phone 7", "brand": "ASUS", "versions": ["Android 13"]},
    {"model": "Nothing Phone (2)", "brand": "Nothing", "versions": ["Android 13", "Android 14"]},
]

IOS_DEVICES = [
    {"model": "iPhone 11", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"]},
    {"model": "iPhone 11 Pro", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"]},
    {"model": "iPhone 11 Pro Max", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"]},
    {"model": "iPhone 12", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 12 Pro", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 12 Pro Max", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 13", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 13 Pro", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 13 Pro Max", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14 Plus", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14 Pro", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14 Pro Max", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 15", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPhone 15 Plus", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPhone 15 Pro", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPhone 15 Pro Max", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPad Pro 12.9", "versions": ["iPadOS 16.0", "iPadOS 16.5", "iPadOS 17.0"]},
    {"model": "iPad Pro 11", "versions": ["iPadOS 16.0", "iPadOS 16.5", "iPadOS 17.0"]},
    {"model": "iPad Air", "versions": ["iPadOS 16.0", "iPadOS 16.5", "iPadOS 17.0"]},
]

# Telegram app versions (recent realistic versions)
TELEGRAM_VERSIONS = [
    "10.0.0", "10.0.5", "10.1.0", "10.1.1", "10.1.2", "10.1.3",
    "10.2.0", "10.2.1", "10.2.4", "10.2.6", "10.2.9",
    "10.3.0", "10.3.1", "10.3.2", "10.4.0", "10.4.1", "10.4.2",
    "10.5.0", "10.5.1", "10.6.0", "10.6.1", "10.6.2",
    "10.7.0", "10.8.0", "10.8.1", "10.9.0", "10.9.1",
    "10.10.0", "10.10.1", "10.11.0", "10.12.0", "10.12.1",
    "10.13.0", "10.14.0", "10.14.1", "10.14.2", "10.14.3",
    "11.0.0", "11.0.1", "11.1.0", "11.1.1", "11.2.0", "11.2.1",
]

# Language codes with their system variants
LANGUAGES = [
    {"code": "en", "system": ["en-US", "en-GB", "en-AU", "en-CA", "en-IN"]},
    {"code": "ar", "system": ["ar-SA", "ar-EG", "ar-AE", "ar-KW", "ar-QA"]},
    {"code": "de", "system": ["de-DE", "de-AT", "de-CH"]},
    {"code": "es", "system": ["es-ES", "es-MX", "es-AR", "es-CO"]},
    {"code": "fr", "system": ["fr-FR", "fr-CA", "fr-BE", "fr-CH"]},
    {"code": "it", "system": ["it-IT", "it-CH"]},
    {"code": "pt", "system": ["pt-BR", "pt-PT"]},
    {"code": "ru", "system": ["ru-RU"]},
    {"code": "tr", "system": ["tr-TR"]},
    {"code": "hi", "system": ["hi-IN"]},
    {"code": "id", "system": ["id-ID"]},
    {"code": "ja", "system": ["ja-JP"]},
    {"code": "ko", "system": ["ko-KR"]},
    {"code": "zh", "system": ["zh-CN", "zh-TW", "zh-HK"]},
    {"code": "nl", "system": ["nl-NL", "nl-BE"]},
    {"code": "pl", "system": ["pl-PL"]},
    {"code": "uk", "system": ["uk-UA"]},
    {"code": "fa", "system": ["fa-IR"]},
    {"code": "th", "system": ["th-TH"]},
    {"code": "vi", "system": ["vi-VN"]},
]


def generate_fingerprint(prefer_android: bool = True) -> dict:
    """
    Generate a random, realistic device fingerprint.
    
    Args:
        prefer_android: If True, 80% chance of Android device, 20% iOS
        
    Returns:
        Dictionary with device_model, system_version, app_version, lang_code, system_lang_code
    """
    # Choose platform
    use_android = random.random() < 0.8 if prefer_android else random.random() < 0.5
    
    if use_android:
        device = random.choice(ANDROID_DEVICES)
        device_model = device["model"]
        system_version = random.choice(device["versions"])
    else:
        device = random.choice(IOS_DEVICES)
        device_model = device["model"]
        system_version = random.choice(device["versions"])
    
    # Choose app version
    app_version = random.choice(TELEGRAM_VERSIONS)
    
    # Choose language
    lang = random.choice(LANGUAGES)
    lang_code = lang["code"]
    system_lang_code = random.choice(lang["system"])
    
    return {
        "device_model": device_model,
        "system_version": system_version,
        "app_version": app_version,
        "lang_code": lang_code,
        "system_lang_code": system_lang_code
    }


def generate_batch_fingerprints(count: int, unique: bool = True) -> list:
    """
    Generate multiple fingerprints at once.
    
    Args:
        count: Number of fingerprints to generate
        unique: If True, ensure all fingerprints are unique
        
    Returns:
        List of fingerprint dictionaries
    """
    fingerprints = []
    seen = set()
    
    while len(fingerprints) < count:
        fp = generate_fingerprint()
        
        if unique:
            # Create a hashable key for uniqueness check
            key = (fp["device_model"], fp["system_version"], fp["app_version"], 
                   fp["lang_code"], fp["system_lang_code"])
            if key in seen:
                continue
            seen.add(key)
        
        fingerprints.append(fp)
    
    return fingerprints


if __name__ == "__main__":
    # Test generation
    print("Sample Fingerprints:")
    print("-" * 60)
    for i in range(5):
        fp = generate_fingerprint()
        print(f"{i+1}. {fp['device_model']} | {fp['system_version']} | v{fp['app_version']} | {fp['lang_code']}-{fp['system_lang_code']}")
`;

  // ========== 4. REQUIREMENTS.TXT ==========
  const requirementsTxt = `telethon>=1.34.0
httpx>=0.27.0
pysocks>=1.7.1
aiohttp>=3.9.0`;

  // ========== 5. CAMPAIGN_RUNNER.PY ==========
  const campaignRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Server-Controlled Speed + Parallel Reporting)
=============================================================================
BUILD: 2026-01-08-batch-reporting-v2

All speed settings controlled by admin dashboard.

- Polls server for batch of tasks
- Speed settings (stagger, polling) controlled by server
- Executes ALL tasks in parallel
- Reports results in parallel (bounded concurrency)
- Uses batch reporting endpoint for speed

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

BUILD_VERSION = "2026-01-08-no-limits-v3"

import asyncio
import signal
import time

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, disconnect_batch, report_batch_results
)

# ========== GLOBAL STATE ==========
RUNNING = True
DEFAULT_POLL_INTERVAL = 3    # Default polling when tasks exist
NO_TASK_POLL_INTERVAL = 30   # Polling when no tasks available
REPORT_CONCURRENCY = 20      # Max parallel report calls


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def pre_connect_batch(tasks: list) -> int:
    """Pre-connect all accounts in parallel BEFORE processing tasks.
    
    This speeds up batch processing by connecting all clients upfront
    instead of sequentially during task processing.
    
    Returns: number of successfully pre-connected accounts
    """
    unique_accounts = {}
    for t in tasks:
        acc = t.get("account", {})
        acc_id = acc.get("id")
        if acc_id and acc_id not in unique_accounts:
            unique_accounts[acc_id] = (acc, t.get("proxy"))
    
    if not unique_accounts:
        return 0
    
    print(f"  ⚡ Pre-connecting {len(unique_accounts)} accounts in parallel...")
    
    async def connect_one(account: dict, proxy: dict) -> bool:
        try:
            client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True)
            return client is not None
        except Exception as e:
            print(f"    ⚠ Pre-connect failed for {account.get('phone_number', '???')[-4:]}: {e}")
            return False
    
    results = await asyncio.gather(
        *[connect_one(acc, px) for acc, px in unique_accounts.values()],
        return_exceptions=True
    )
    
    success_count = sum(1 for r in results if r is True)
    print(f"  ✓ Pre-connection complete: {success_count}/{len(unique_accounts)} connected")
    return success_count


async def process_single_task(task: dict) -> dict:
    """Process a single campaign send task.
    
    IMPORTANT: This function is fully isolated - any exception here
    only affects this task, never crashes the whole runner.
    
    No stagger delay - send immediately for maximum speed.
    """
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    account = task.get("account", {})
    proxy = task.get("proxy")
    content = msg.get("content", "")
    
    # Get campaign metadata from task (passed from get-batch-tasks)
    campaign_seat_id = task.get("campaign_seat_id")
    campaign_id = task.get("campaign_id")
    campaign_name = task.get("campaign_name")
    
    account_id = account.get("id")
    account_phone = account.get("phone_number", "????")[-4:]
    
    if not account_id or not recipient:
        return {
            "success": False,
            "error": "Missing account or recipient",
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "account_id": account_id,
        }
    
    try:
        # Get or create client with task-level proxy (fingerprint always fetched)
        client = await get_or_create_client(account, task_proxy=proxy)
        
        if not client:
            result = {
                "success": False,
                "error": "Could not connect client (proxy error - proxy changed)",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account_id,
            }
            print(f"    ✗ [{account_phone}] No client - proxy error")
            return result
        
        # No stagger - send immediately
        print(f"  📨 [{account_phone}] → {recipient}")
        
        send_res = await send_message(
            client, recipient, content,
            msg.get("media_url")
        )
        if isinstance(send_res, tuple) and len(send_res) == 3:
            success, error, meta = send_res
        elif isinstance(send_res, tuple) and len(send_res) == 2:
            success, error = send_res
            meta = None
        else:
            success, error, meta = False, f"Unexpected send_message return: {type(send_res)}", None
        
        # Check if this is a sender-side issue (should retry with different account)
        is_sender_error = error and any(x in error.lower() for x in [
            "privacyrestricted", "privacy restricted", "userprivacyrestricted",
            "too many requests", "sendmessagerequest"
        ])
        
        # Get API credential ID
        api_creds = account.get("telegram_api_credentials")
        api_credential_id = api_creds.get("id") if api_creds else account.get("api_credential_id")
        
        result = {
            "success": success,
            "error": error,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"),
            "account_id": account_id,
            "api_credential_id": api_credential_id,
            "content": content,
            "recipient_phone": recipient,
            "recipient_name": recipient_name,
            # Include campaign metadata for faster backend processing
            "campaign_seat_id": campaign_seat_id,
            "campaign_id": campaign_id,
            "campaign_name": campaign_name,
        }
        
        if is_sender_error:
            result["skip_account"] = True
            result["retry_with_different_account"] = True
            print(f"    ⚠ [{account_phone}] Sender error (will retry with different account)")
        elif success:
            print(f"    ✓ [{account_phone}] Sent")
        else:
            print(f"    ✗ [{account_phone}] {error}")
        
        if meta:
            result.update(meta)
        
        return result
        
    except Exception as e:
        error_str = str(e)
        print(f"    ✗ [{account_phone}] Error: {error_str[:50]}")
        return {
            "success": False,
            "error": error_str,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"),
            "account_id": account_id,
        }


async def report_results_parallel(results: list) -> tuple:
    """Report all results to server in parallel with bounded concurrency.
    
    Returns: (success_count, fail_count, report_time_seconds)
    """
    start_time = time.time()
    
    # Filter out exceptions
    valid_results = [r for r in results if not isinstance(r, Exception)]
    
    if not valid_results:
        return 0, 0, 0
    
    # Try batch reporting first (much faster if available)
    try:
        batch_success = await report_batch_results(valid_results)
        if batch_success:
            elapsed = time.time() - start_time
            success_count = sum(1 for r in valid_results if r.get("success"))
            return success_count, len(valid_results) - success_count, elapsed
    except Exception as e:
        print(f"  ⚠ Batch report failed, falling back to parallel: {e}")
    
    # Fallback: parallel individual reports with bounded concurrency
    semaphore = asyncio.Semaphore(REPORT_CONCURRENCY)
    
    async def report_one(result: dict) -> bool:
        async with semaphore:
            try:
                await report_result("send", result)
                return result.get("success", False)
            except Exception as e:
                print(f"    ⚠ Report error: {e}")
                return False
    
    # Report all in parallel (bounded by semaphore)
    report_results = await asyncio.gather(
        *[report_one(r) for r in valid_results],
        return_exceptions=True
    )
    
    elapsed = time.time() - start_time
    success_count = sum(1 for r in report_results if r is True)
    fail_count = len(valid_results) - success_count
    
    return success_count, fail_count, elapsed


async def main_loop():
    """Main campaign loop - Server-controlled speed settings
    
    Simple loop:
    1. Request tasks from server (server decides batch size + speed)
    2. Execute ALL tasks in parallel with server-controlled stagger
    3. Report ALL results in parallel (bounded concurrency)
    4. Wait delay_after seconds (server-controlled, can be 0)
    5. Repeat
    """
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Parallel Speed)")
    print(f"  BUILD: {BUILD_VERSION}")
    print("=" * 60)
    print("  🚀 Speed settings from admin dashboard")
    print("  ⚡ Parallel sending + batch reporting")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\\n✓ Starting campaign runner...\\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            batch_start = time.time()
            
            # Request batch of tasks from server
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            
            fetch_time = time.time() - batch_start
            
            # Get server-controlled settings (stagger removed - always 0)
            delay_after = batch_result.get("delay_after", DEFAULT_POLL_INTERVAL)
            more_pending = batch_result.get("more_pending", False)

            # Check for stop signal from server - wait 30 seconds before checking again
            if batch_result.get("stop_signal"):
                reason = batch_result.get("reason", "Campaign paused from dashboard")
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print(f"  ⏸️  {reason} — waiting for campaign to resume (checking every 30s)...")
                elif consecutive_empty % 10 == 0:
                    print("  ⏸️  Still waiting for campaign to resume...")
                await asyncio.sleep(NO_TASK_POLL_INTERVAL)
                continue

            # Handle no tasks - wait 30 seconds before checking again
            if not tasks:
                reason = batch_result.get("reason", "")
                consecutive_empty += 1

                if consecutive_empty == 1:
                    if reason:
                        print(f"  ⏳ {reason} — checking every 30s...")
                    else:
                        print("  ⏳ No pending campaign tasks, checking every 30s...")
                elif consecutive_empty % 10 == 0:
                    print("  ⏳ Still waiting for campaign tasks...")

                await asyncio.sleep(NO_TASK_POLL_INTERVAL)
                continue
            
            consecutive_empty = 0
            print(f"\\n  📦 Processing {len(tasks)} messages (NO STAGGER - INSTANT)...")
            print(f"     [fetch: {fetch_time:.2f}s]")
            
            # Pre-connect all accounts in parallel FIRST (major speedup)
            connect_start = time.time()
            await pre_connect_batch(tasks)
            connect_time = time.time() - connect_start
            print(f"     [connect: {connect_time:.2f}s]")
            
            # Execute ALL tasks in parallel - NO STAGGER for maximum speed
            send_start = time.time()
            results = await asyncio.gather(
                *[process_single_task(task) for task in tasks],
                return_exceptions=True
            )
            send_time = time.time() - send_start
            print(f"     [send: {send_time:.2f}s]")
            
            # Report ALL results in parallel (bounded concurrency)
            success_count, fail_count, report_time = await report_results_parallel(results)
            
            total_time = time.time() - batch_start
            msgs_per_min = (len(tasks) / total_time * 60) if total_time > 0 else 0
            
            print(f"  📊 Batch: {success_count}✓ {fail_count}✗ | {total_time:.1f}s total ({msgs_per_min:.0f}/min)")
            print(f"     [report: {report_time:.2f}s]")

            # Use server-controlled delay (can be 0 for immediate repoll if more pending)
            if RUNNING and delay_after > 0:
                print(f"  ⏳ Next batch in {delay_after}s...")
                await asyncio.sleep(delay_after)
            elif RUNNING and more_pending:
                print("  🚀 More pending, immediate repoll...")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(DEFAULT_POLL_INTERVAL)
    
    print("\\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Campaign Runner - Parallel Speed")
    print("  Speed & batch settings from admin dashboard")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print("Required: pip install telethon httpx pysocks")
    
    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Keyboard interrupt - stopping...")
            break
        except Exception as e:
            print(f"\\n⚠ Runner crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== 6. LIVE_CHAT_LISTENER.PY ==========
  const livechatRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Live Chat Listener (Server-Controlled)
======================================================
Keeps all accounts connected and listens for incoming messages.
Sends outgoing messages for active conversations.

- 1-second polling for INSTANT response (required for live chat)
- Keep-alive mechanism to prevent disconnections
- All batch sizes controlled by server

Run: python live_chat_listener.py
Stop: Ctrl+C
"""

import asyncio
import signal
import time

from telethon import events

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, active_clients, send_heartbeat
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 1  # 1-second polling for live chat (must be fast!)
KEEP_ALIVE_INTERVAL = 60  # Ping connections every 60 seconds
HEARTBEAT_INTERVAL = 30  # Send heartbeat every 30 seconds


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def ping_connected_clients():
    """Keep connections alive by checking client status"""
    disconnected = []
    for acc_id, client in list(active_clients.items()):
        try:
            if not client.is_connected():
                disconnected.append(acc_id)
            else:
                await asyncio.wait_for(client.get_me(), timeout=5)
        except Exception as e:
            print(f"  ⚠ Client {acc_id[:8]}... ping failed: {e}")
            disconnected.append(acc_id)
    
    for acc_id in disconnected:
        if acc_id in active_clients:
            try:
                await active_clients[acc_id].disconnect()
            except:
                pass
            del active_clients[acc_id]
    
    if disconnected:
        print(f"  🔄 Cleaned up {len(disconnected)} disconnected clients")


async def process_send_task(task: dict) -> dict:
    """Process a single send task for live chat"""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_tid = task.get("recipient_telegram_id")
    account = task.get("account", {})
    task_proxy = task.get("proxy")
    
    account_id = account.get("id")
    account_phone = account.get("phone_number", "????")[-4:]
    
    if not account_id or not recipient:
        return {
            "message_id": msg.get("id"),
            "success": False,
            "error": "Missing account or recipient",
            "account_id": account_id,
        }
    
    try:
        client = await get_or_create_client(
            account, 
            setup_handler=setup_message_handler,
            skip_avatar=True,
            task_proxy=task_proxy
        )
        
        if not client:
            return {
                "message_id": msg.get("id"),
                "success": False,
                "error": "Could not connect client",
                "account_id": account_id,
            }
        
        target = recipient_tid if recipient_tid else recipient
        
        print(f"  ⚡ [{account_phone}] Live reply to {recipient}...")
        
        success, error, meta = await send_message(
            client, target, msg.get("content", ""),
            msg.get("media_url")
        )
        
        result = {
            "message_id": msg.get("id"),
            "success": success,
            "error": error,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "account_id": account_id,
        }
        
        if meta:
            result.update(meta)
        
        if success:
            print(f"    ✓ Sent!")
        else:
            print(f"    ✗ Failed: {error}")
        
        return result
        
    except Exception as e:
        error_str = str(e)
        print(f"    ✗ [{account_phone}] Error: {error_str[:50]}")
        return {
            "message_id": msg.get("id"),
            "success": False,
            "error": error_str,
            "account_id": account_id,
        }


async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages - ONLY for campaign-initiated conversations"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            try:
                sender = await event.get_sender()
            except Exception as sender_error:
                error_str = str(sender_error).lower()
                if any(x in error_str for x in ["private", "banned", "channel", "permission"]):
                    return
                raise
            
            if not sender:
                return
            
            from telethon.tl.types import User
            if not isinstance(sender, User):
                return

            if getattr(sender, 'bot', False):
                return
            
            # FILTER: Only process messages from contacts
            if not getattr(sender, 'contact', False):
                return
            
            first_name = getattr(sender, 'first_name', None) or ''
            last_name = getattr(sender, 'last_name', None) or ''
            sender_name = f"{first_name} {last_name}".strip() or str(sender.id)
            sender_username = getattr(sender, 'username', None)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            
            content = event.message.text or "[Media message]"
            media_url = None
            media_type = None
            
            # Handle photos
            if event.message.photo:
                print(f"    📷 Receiving photo...")
                content = "[Photo] " + (event.message.text or "")
                media_type = "image"
                
                try:
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        import base64
                        import httpx
                        import time as time_module
                        from config import SUPABASE_URL, SUPABASE_KEY
                        
                        file_name = f"incoming_{account_id}_{int(time_module.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        
                        mime_type = "image/jpeg"
                        if hasattr(event.message, 'file') and event.message.file:
                            mime_type = getattr(event.message.file, 'mime_type', None) or "image/jpeg"
                        
                        async with httpx.AsyncClient(timeout=30.0) as http:
                            upload_response = await http.put(
                                f"{SUPABASE_URL}/storage/v1/object/message-attachments/{file_path}",
                                headers={
                                    "apikey": SUPABASE_KEY,
                                    "Authorization": f"Bearer {SUPABASE_KEY}",
                                    "Content-Type": mime_type,
                                    "x-upsert": "true"
                                },
                                content=photo_bytes
                            )
                            
                            if upload_response.status_code in (200, 201):
                                media_url = f"{SUPABASE_URL}/storage/v1/object/public/message-attachments/{file_path}"
                                print(f"    ✓ Photo uploaded: {file_name}")
                            else:
                                error_text = upload_response.text[:300] if upload_response.text else "No details"
                                print(f"    ⚠ Photo upload failed: {upload_response.status_code} - {error_text}")
                except Exception as e:
                    print(f"    ⚠ Could not download/upload photo: {e}")
            
            # Get profile photo
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    import base64
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
                    print(f"    📸 Got profile photo for {sender_name}")
            except Exception as e:
                print(f"    ⚠ Could not get profile photo: {e}")
            
            print(f"  📥 [IN] From {sender_name}: {content[:50]}...")
            
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": sender_name,
                "sender_username": getattr(sender, 'username', None),
                "sender_phone": sender_phone,
                "sender_avatar": avatar_base64,
                "content": content,
                "media_url": media_url,
                "media_type": media_type
            })
        except Exception as e:
            print(f"    ⚠ Handler error: {e}")


async def main_loop():
    """Main live chat loop - 1-second polling for instant response"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Live Chat Listener (Server-Controlled)")
    print("=" * 60)
    print("  📥 Handles: Incoming messages, Live chat replies")
    print(f"  ⚡ Polling: Every {POLL_INTERVAL} second(s) (instant response)")
    print(f"  💓 Keep-alive: Every {KEEP_ALIVE_INTERVAL} seconds")
    print("  🔧 Batch sizes controlled by server")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting live chat listener...\\n")
    
    connected_ids = set()
    last_keep_alive = time.time()
    last_heartbeat = 0
    consecutive_errors = 0
    MAX_CONSECUTIVE_ERRORS = 10
    
    while RUNNING:
        loop_start = time.time()
        
        # Send heartbeat every HEARTBEAT_INTERVAL seconds
        if loop_start - last_heartbeat >= HEARTBEAT_INTERVAL:
            await send_heartbeat("livechat")
            last_heartbeat = loop_start
        
        try:
            # Poll for send tasks - server controls batch size
            try:
                batch_result = await asyncio.wait_for(
                    get_batch_tasks(runner="livechat"),
                    timeout=5.0  # 5 second timeout for API call
                )
                consecutive_errors = 0  # Reset on success
            except asyncio.TimeoutError:
                print(f"  ⚠ API timeout, retrying...")
                consecutive_errors += 1
                await asyncio.sleep(0.5)
                continue
            except Exception as api_err:
                print(f"  ⚠ API error: {api_err}")
                consecutive_errors += 1
                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                    print(f"  ⚠ Too many errors ({consecutive_errors}), waiting 5s...")
                    await asyncio.sleep(5)
                    consecutive_errors = 0
                else:
                    await asyncio.sleep(0.5)
                continue
            
            tasks = batch_result.get("tasks", [])
            accounts = batch_result.get("accounts", [])
            
            # Connect new accounts from response (non-blocking)
            new_accounts = [acc for acc in accounts if acc.get("id") not in connected_ids]
            if new_accounts:
                print(f"  🔌 Connecting {len(new_accounts)} new accounts...")
                try:
                    results = await asyncio.wait_for(
                        asyncio.gather(
                            *[get_or_create_client(
                                acc, 
                                setup_handler=setup_message_handler, 
                                task_proxy=acc.get("proxy")
                            ) for acc in new_accounts],
                            return_exceptions=True
                        ),
                        timeout=30.0  # 30 second timeout for connections
                    )
                    for acc in new_accounts:
                        if acc.get("id"):
                            connected_ids.add(acc["id"])
                except asyncio.TimeoutError:
                    print(f"  ⚠ Client connection timeout, will retry next loop")
                except Exception as conn_err:
                    print(f"  ⚠ Client connection error: {conn_err}")
            
            # Process send tasks in parallel (with timeout)
            if tasks:
                print(f"\\n  📦 Processing {len(tasks)} send tasks...")
                try:
                    results = await asyncio.wait_for(
                        asyncio.gather(
                            *[process_send_task(task) for task in tasks],
                            return_exceptions=True
                        ),
                        timeout=30.0  # 30 second timeout for sending
                    )
                    
                    # Report results (don't let this block the loop)
                    for result in results:
                        if isinstance(result, Exception):
                            print(f"  ⚠ Task exception: {result}")
                            continue
                        if isinstance(result, dict):
                            try:
                                await asyncio.wait_for(
                                    report_result("send", result),
                                    timeout=5.0
                                )
                            except Exception as report_err:
                                print(f"  ⚠ Failed to report result: {report_err}")
                except asyncio.TimeoutError:
                    print(f"  ⚠ Send tasks timeout, continuing...")
                except Exception as send_err:
                    print(f"  ⚠ Send tasks error: {send_err}")
            
            # Keep-alive ping every 60 seconds (non-blocking)
            if time.time() - last_keep_alive > KEEP_ALIVE_INTERVAL:
                print("  💓 Keep-alive check...")
                try:
                    await asyncio.wait_for(ping_connected_clients(), timeout=30.0)
                except Exception as ping_err:
                    print(f"  ⚠ Keep-alive error: {ping_err}")
                last_keep_alive = time.time()
            
            # Calculate remaining time to maintain 1-second loop
            elapsed = time.time() - loop_start
            sleep_time = max(0.1, POLL_INTERVAL - elapsed)  # Minimum 0.1s sleep
            await asyncio.sleep(sleep_time)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            consecutive_errors += 1
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                print(f"  ⚠ Too many consecutive errors, waiting 5s...")
                await asyncio.sleep(5)
                consecutive_errors = 0
            else:
                await asyncio.sleep(0.5)
    
    print("\\n⏹ Live chat listener stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Live Chat Listener... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx python-socks")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  // ========== 7. ACCOUNT_MANAGER.PY ==========
  const accountRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Account Manager (Server-Controlled)
===================================================
Handles account management tasks:
- SpamBot check
- Change name
- Change photo
- Privacy settings
- Change password
- Logout other sessions
- Sync profile
- Verify session

Polls server for tasks - all scheduling controlled by admin.

Run: python account_manager.py
Stop: Ctrl+C
"""

import asyncio
import signal
import os
import base64

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    shutdown_all, SESSION_FOLDER
)

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_spambot(client):
    """Check SpamBot for account status - detects banned, restricted"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        
        response_lower = response.lower()
        
        if "banned" in response_lower or "deleted" in response_lower or "заблокирован" in response_lower:
            return "banned", response[:200], response
        
        if "limited" in response_lower or "restricted" in response_lower or "ограничен" in response_lower or "frozen" in response_lower or "заморожен" in response_lower:
            return "restricted", "Limited by Telegram", response
            
        if "no limits" in response_lower or "good news" in response_lower or "нет ограничений" in response_lower:
            return "active", None, response
            
        return "active", None, response
    except Exception as e:
        error_str = str(e).lower()
        if "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), f"Connection error: {e}"
        if "auth" in error_str or "session" in error_str or "revoked" in error_str:
            return "disconnected", str(e), f"Session error: {e}"
        return "active", None, f"SpamBot error: {e}"


async def change_name(client, first_name: str, last_name: str = ""):
    """Change account name on Telegram"""
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_source: str):
    """Change profile photo on Telegram - accepts base64 or URL"""
    try:
        from telethon.tl.functions.photos import UploadProfilePhotoRequest
        import aiohttp
        
        temp_path = os.path.join(SESSION_FOLDER, "temp_photo.jpg")
        
        if photo_source.startswith("http://") or photo_source.startswith("https://"):
            async with aiohttp.ClientSession() as session:
                async with session.get(photo_source) as resp:
                    if resp.status == 200:
                        photo_bytes = await resp.read()
                        with open(temp_path, "wb") as f:
                            f.write(photo_bytes)
                    else:
                        return False, f"Failed to download image: HTTP {resp.status}"
        else:
            photo_bytes = base64.b64decode(photo_source)
            with open(temp_path, "wb") as f:
                f.write(photo_bytes)
        
        file = await client.upload_file(temp_path)
        await client(UploadProfilePhotoRequest(file=file))
        
        os.remove(temp_path)
        return True, None
    except Exception as e:
        return False, str(e)


async def update_privacy(client, hide_phone: bool, hide_last_seen: bool, disable_calls: bool):
    """Update privacy settings"""
    try:
        from telethon.tl.functions.account import SetPrivacyRequest
        from telethon.tl.types import InputPrivacyKeyPhoneNumber, InputPrivacyKeyStatusTimestamp, InputPrivacyKeyPhoneCall
        from telethon.tl.types import InputPrivacyValueDisallowAll
        
        if hide_phone:
            await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneNumber(), rules=[InputPrivacyValueDisallowAll()]))
        
        if hide_last_seen:
            await client(SetPrivacyRequest(key=InputPrivacyKeyStatusTimestamp(), rules=[InputPrivacyValueDisallowAll()]))
        
        if disable_calls:
            await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneCall(), rules=[InputPrivacyValueDisallowAll()]))
        
        return True, None
    except Exception as e:
        return False, str(e)


async def change_password(client, existing_pwd: str, new_pwd: str):
    """Change 2FA cloud password"""
    try:
        from telethon.tl.functions.account import UpdatePasswordSettingsRequest, GetPasswordRequest
        from telethon.password import compute_check
        
        pwd = await client(GetPasswordRequest())
        
        if pwd.has_password and existing_pwd:
            check = compute_check(pwd, existing_pwd)
        else:
            check = None
        
        from telethon.tl.types.account import PasswordInputSettings
        new_settings = PasswordInputSettings(new_algo=pwd.new_algo, new_password_hash=new_pwd.encode())
        await client(UpdatePasswordSettingsRequest(password=check, new_settings=new_settings))
        return True, None
    except Exception as e:
        return False, str(e)


async def logout_other_sessions(client):
    """Logout all other sessions EXCEPT the current one"""
    try:
        from telethon.tl.functions.account import GetAuthorizationsRequest, ResetAuthorizationRequest
        
        result = await client(GetAuthorizationsRequest())
        
        terminated_count = 0
        for auth in result.authorizations:
            if auth.current:
                continue
            
            try:
                await client(ResetAuthorizationRequest(hash=auth.hash))
                terminated_count += 1
            except Exception as e:
                print(f"    Could not terminate session {auth.hash}: {e}")
        
        return True, f"Terminated {terminated_count} other session(s)"
    except Exception as e:
        return False, str(e)


async def verify_session(client, account_id: str):
    """Verify if session is active using SAFE methods only"""
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if not me:
            return "disconnected", "Could not get user info", None
        
        try:
            dialogs = await asyncio.wait_for(client.get_dialogs(limit=1), timeout=10)
        except Exception as dialog_err:
            error_str = str(dialog_err).lower()
            if any(x in error_str for x in ["deleted", "deactivated", "banned", "user_deactivated", "auth_key"]):
                return "banned", f"Account deleted: {dialog_err}", None
            if "frozen" in error_str:
                return "restricted", f"Account restricted: {dialog_err}", None
        
        try:
            from telethon.tl.functions.contacts import GetContactsRequest
            await asyncio.wait_for(client(GetContactsRequest(hash=0)), timeout=10)
        except Exception as contacts_err:
            error_str = str(contacts_err).lower()
            if "frozen" in error_str:
                return "restricted", f"Account restricted: {contacts_err}", None
            if any(x in error_str for x in ["deleted", "deactivated", "banned"]):
                return "banned", f"Account banned: {contacts_err}", None
        
        return "active", None, {
            "telegram_id": me.id,
            "username": me.username,
            "first_name": me.first_name,
            "last_name": me.last_name
        }
    except asyncio.TimeoutError:
        return "disconnected", "Connection timeout", None
    except Exception as e:
        error_str = str(e).lower()
        if "auth" in error_str or "session" in error_str or "revoked" in error_str:
            return "disconnected", str(e), None
        elif "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), None
        elif "frozen" in error_str:
            return "restricted", str(e), None
        return "disconnected", str(e), None


async def main_loop():
    """Main account management loop - polls server for tasks"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Account Manager (Server-Controlled)")
    print("=" * 60)
    print("  🔧 Handles: SpamBot check, Name change, Photo, Privacy")
    print("  📡 Polls server for tasks")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting account manager...\\n")
    
    while RUNNING:
        try:
            # Get next task from server
            task = await get_next_task(runner="account")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 5)
                await asyncio.sleep(seconds)
            
            elif task_type == "spambot_check":
                task_id = task.get("task_id")
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    print(f"  🤖 SpamBot check for {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "status": status,
                        "ban_reason": ban_reason,
                        "response": response
                    })
                    print(f"    Result: {status}")
            
            elif task_type == "change_name":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    print(f"  ✏️ Changing name for {account.get('phone_number')}...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "first_name": task_data.get("first_name"),
                        "last_name": task_data.get("last_name")
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_photo":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    print(f"  📷 Changing photo for {account.get('phone_number')}...")
                    photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
                    success, error = await change_profile_photo(client, photo_source)
                    await report_result("change_photo", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "privacy_settings":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    print(f"  🔒 Updating privacy for {account.get('phone_number')}...")
                    success, error = await update_privacy(
                        client,
                        task_data.get("hidePhone", False),
                        task_data.get("hideLastSeen", False),
                        task_data.get("disableCalls", False)
                    )
                    await report_result("privacy_settings", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_password":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    print(f"  🔐 Changing password for {account.get('phone_number')}...")
                    success, error = await change_password(
                        client,
                        task_data.get("existing_password", ""),
                        task_data.get("new_password", "")
                    )
                    await report_result("change_password", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "logout_sessions":
                task_id = task.get("task_id")
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    print(f"  🚪 Logging out other sessions for {account.get('phone_number')}...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "sync_profile":
                task_id = task.get("task_id")
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                print(f"  🔄 Syncing profile for {account.get('phone_number')}...")
                client = await get_or_create_client(account, skip_avatar=False, force_profile_sync=True, task_proxy=task_proxy)
                if client:
                    await report_result("sync_profile", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": True
                    })
                    print(f"    ✓ Profile synced")
                else:
                    await report_result("sync_profile", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": False,
                        "error": "Could not connect"
                    })
                    print(f"    ✗ Failed to connect")
            
            elif task_type == "verify_session":
                task_id = task.get("task_id")
                account = task.get("account", {})
                task_proxy = task.get("proxy")
                
                print(f"  🔍 Verifying session for {account.get('phone_number')}...")
                try:
                    client = await get_or_create_client(account, task_proxy=task_proxy)
                    if client:
                        status, error, user_data = await verify_session(client, account.get("id"))
                        await report_result("verify_session", {
                            "task_id": task_id,
                            "account_id": account.get("id"),
                            "status": status,
                            "error": error,
                            "user_data": user_data
                        })
                        print(f"    Result: {status}")
                    else:
                        await report_result("verify_session", {
                            "task_id": task_id,
                            "account_id": account.get("id"),
                            "status": "disconnected",
                            "error": "Could not connect"
                        })
                        print(f"    ✗ Could not connect")
                except Exception as e:
                    await report_result("verify_session", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "status": "disconnected",
                        "error": str(e)
                    })
                    print(f"    ✗ Error: {e}")
            
            else:
                if task_type != "wait":
                    print(f"  ❓ Unknown task type: {task_type}")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(5)
    
    print("\\n⏹ Account manager stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Account Manager... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx python-socks aiohttp")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  // ========== 8. WARMUP_RUNNER.PY ==========
  const warmupRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner (Server-Controlled)
=================================================
Simple task executor - all settings controlled by admin side.

- Polls server every 10 seconds for batch of tasks
- Executes ALL tasks in parallel
- Reports results back to server
- Server controls: batch size, delays, pair scheduling

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_next_task, get_batch_tasks, report_result,
    shutdown_all, disconnect_batch
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 7  # Poll server every 7 seconds

# Warmup channels (safe public channels for building history)
WARMUP_CHANNELS = [
    "telegram",
    "durov", 
    "TelegramTips",
    "android",
    "ios",
]

# Reaction emojis
REACTIONS = ["👍", "❤️", "🔥", "👏", "😊", "🎉", "💯", "⭐"]


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def join_channel(client, channel_username: str = None):
    """Join a public channel to build history"""
    try:
        from telethon.tl.functions.channels import JoinChannelRequest
        
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        await client(JoinChannelRequest(entity))
        
        await asyncio.sleep(random.uniform(1, 3))
        
        return True, channel, None
    except Exception as e:
        error_msg = str(e).lower()
        if "already" in error_msg or "participant" in error_msg:
            return True, channel_username, "Already joined"
        return False, channel_username, str(e)


async def view_channel_messages(client, channel_username: str = None):
    """View messages in a channel (marks as read)"""
    try:
        from telethon.tl.functions.messages import GetHistoryRequest, ReadHistoryRequest
        
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        
        history = await client(GetHistoryRequest(
            peer=entity,
            limit=20,
            offset_date=None,
            offset_id=0,
            max_id=0,
            min_id=0,
            add_offset=0,
            hash=0
        ))
        
        if history.messages:
            try:
                await client(ReadHistoryRequest(peer=entity, max_id=history.messages[0].id))
            except:
                pass
        
        await asyncio.sleep(random.uniform(2, 5))
        
        return True, channel, len(history.messages) if history.messages else 0
    except Exception as e:
        return False, channel_username, str(e)


async def send_reaction(client, channel_username: str = None):
    """Send a reaction to a message in a channel"""
    try:
        from telethon.tl.functions.messages import SendReactionRequest
        from telethon.tl.types import ReactionEmoji
        
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        
        messages = await client.get_messages(entity, limit=10)
        
        if messages:
            msg = random.choice(messages)
            reaction = random.choice(REACTIONS)
            
            try:
                await client(SendReactionRequest(
                    peer=entity,
                    msg_id=msg.id,
                    reaction=[ReactionEmoji(emoticon=reaction)]
                ))
                await asyncio.sleep(random.uniform(1, 2))
                return True, channel, reaction
            except Exception as e:
                return True, channel, f"Viewed (reactions disabled: {str(e)[:50]})"
        
        return True, channel, "No messages to react to"
    except Exception as e:
        return False, channel_username, str(e)


async def update_profile_bio(client, bio: str = None):
    """Update profile bio"""
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        
        bios = ["✨", "🌟", "Life is good", "Happy days", "Living my best life", ""]
        
        new_bio = bio or random.choice(bios)
        await client(UpdateProfileRequest(about=new_bio))
        
        return True, new_bio, None
    except Exception as e:
        return False, None, str(e)


async def add_contact(client, phone: str, first_name: str, last_name: str = ""):
    """Add a contact (for interaction between accounts)"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        
        contact = InputPhoneContact(
            client_id=0,
            phone=phone,
            first_name=first_name,
            last_name=last_name
        )
        
        result = await client(ImportContactsRequest([contact]))
        
        if result.imported:
            return True, phone, None
        else:
            return True, phone, "Contact exists or invalid"
    except Exception as e:
        return False, phone, str(e)


async def send_warmup_chat(client, recipient_phone: str, message: str, recipient_telegram_id: int = None, recipient_username: str = None, recipient_first_name: str = None):
    """Send warmup chat message with human-like typing simulation"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        
        user = None
        
        # Try to get user by telegram_id first (fastest)
        if recipient_telegram_id:
            try:
                user = await client.get_entity(recipient_telegram_id)
            except:
                pass
        
        # Try username next
        if not user and recipient_username:
            try:
                user = await client.get_entity(recipient_username)
            except:
                pass
        
        # Fallback to phone number
        if not user:
            contact = InputPhoneContact(
                client_id=random.randint(0, 999999),
                phone=recipient_phone,
                first_name=recipient_first_name or "Friend",
                last_name=""
            )
            result = await client(ImportContactsRequest([contact]))
            if result.users:
                user = result.users[0]
        
        if not user:
            return False, "Could not find user"
        
        # Human-like typing simulation
        base_delay = random.uniform(2, 4)
        typing_delay = len(message) * random.uniform(0.08, 0.15)
        thinking_pause = random.uniform(0, 2)
        total_typing_time = min(base_delay + typing_delay + thinking_pause, 15)
        
        async with client.action(user, 'typing'):
            await asyncio.sleep(total_typing_time)
        
        await client.send_message(user, message)
        await asyncio.sleep(random.uniform(0.5, 2))
        
        return True, None
    except Exception as e:
        return False, str(e)


async def process_single_task(task: dict) -> dict:
    """Process a single warmup task with full human-like timing.
    
    IMPORTANT: This function is fully isolated - any exception here
    only affects this task, never crashes the whole runner.
    """
    task_type = task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    is_cycle_last = task.get("is_cycle_last", False)
    
    phone = account.get("phone_number", "Unknown")
    
    try:
        # Get or create client
        task_proxy = account.get("proxy")
        client = await get_or_create_client(account, task_proxy=task_proxy)
        
        if not client:
            error_msg = "Could not connect client - proxy may be down or expired"
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": False,
                "error": error_msg,
                "error_type": "proxy_error",
                "is_cycle_last": is_cycle_last,
            })
            return {"task_id": task_id, "success": False, "error": error_msg}
        
        if task_type == "warmup_add_contact":
            target_phone = task_data.get("phone") or task_data.get("recipient_phone")
            first_name = task_data.get("first_name", "Friend")
            
            display_phone = target_phone[:8] + "..." if target_phone and len(target_phone) > 8 else target_phone
            print(f"  👤 [{phone}] Saving contact: {display_phone} ({first_name})...")
            
            success, added_phone, error = await add_contact(client, target_phone, first_name)
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": success,
                "error": error,
                "message_type": "add_contact",
                "is_cycle_last": is_cycle_last,
            })
            print(f"    {'✓' if success else '✗'} Contact saved")
            return {"task_id": task_id, "success": success, "error": error}
        
        elif task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            recipient_telegram_id = task_data.get("recipient_telegram_id")
            recipient_username = task_data.get("recipient_username")
            recipient_first_name = task_data.get("first_name")
            message = task_data.get("message", "Hey! 👋")
            
            display_phone = recipient_phone[:8] + "..." if recipient_phone and len(recipient_phone) > 8 else recipient_phone
            cycle_indicator = " [LAST]" if is_cycle_last else ""
            print(f"  🔥 [{phone}] Warmup chat to {display_phone}{cycle_indicator}...")
            
            success, error = await send_warmup_chat(
                client, 
                recipient_phone, 
                message, 
                recipient_telegram_id, 
                recipient_username,
                recipient_first_name
            )
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": success,
                "error": error,
                "message_type": "text",
                "is_cycle_last": is_cycle_last,
            })
            
            msg_preview = message[:30] + "..." if len(message) > 30 else message
            print(f"    {'✓' if success else '✗'} {msg_preview}")
            return {"task_id": task_id, "success": success, "error": error}
        
        else:
            print(f"  ❓ Unknown task type: {task_type}")
            return {"task_id": task_id, "success": False, "error": f"Unknown task type: {task_type}"}
    
    except Exception as e:
        error_str = str(e)
        error_type = "unknown"
        
        error_lower = error_str.lower()
        if any(x in error_lower for x in ["proxy", "socks", "connection refused", "unreachable"]):
            error_type = "proxy_error"
        elif any(x in error_lower for x in ["timeout", "timed out"]):
            error_type = "connection_error"
        
        print(f"  ⚠ Task error [{phone}]: {e}")
        
        try:
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": False,
                "error": error_str,
                "error_type": error_type,
                "is_cycle_last": is_cycle_last,
            })
        except Exception as report_error:
            print(f"  ⚠ Failed to report error: {report_error}")
        
        return {"task_id": task_id, "success": False, "error": error_str}


async def process_regular_warmup_task(task: dict):
    """Process regular warmup tasks (channel joins, reactions, etc.)"""
    task_type = task.get("task", "wait")
    
    if task_type == "wait":
        return
    
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    task_proxy = task.get("proxy")
    
    client = await get_or_create_client(account, task_proxy=task_proxy)
    if not client:
        await report_result("warmup", {
            "task_id": task_id,
            "success": False,
            "error": "Could not connect client"
        })
        return
    
    phone = account.get("phone_number", "Unknown")
    
    try:
        if task_type == "join_channel":
            channel = task_data.get("channel") or random.choice(WARMUP_CHANNELS)
            print(f"  📢 [{phone}] Joining channel: {channel}")
            success, channel_name, error = await join_channel(client, channel)
            await report_result("warmup", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "channel": channel_name,
                "error": error
            })
        
        elif task_type == "view_messages":
            channel = task_data.get("channel")
            print(f"  👀 [{phone}] Viewing messages in channel...")
            success, channel_name, count = await view_channel_messages(client, channel)
            await report_result("warmup", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "channel": channel_name,
                "messages_viewed": count if success else None,
                "error": count if not success else None
            })
        
        elif task_type == "send_reaction":
            channel = task_data.get("channel")
            print(f"  ❤️ [{phone}] Sending reaction...")
            success, channel_name, reaction = await send_reaction(client, channel)
            await report_result("warmup", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "channel": channel_name,
                "reaction": reaction if success else None,
                "error": reaction if not success else None
            })
        
        elif task_type == "update_bio":
            bio = task_data.get("bio")
            print(f"  ✏️ [{phone}] Updating bio...")
            success, new_bio, error = await update_profile_bio(client, bio)
            await report_result("warmup", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "bio": new_bio,
                "error": error
            })
        
        else:
            print(f"  ❓ Unknown regular warmup task: {task_type}")
    
    except Exception as e:
        print(f"  ⚠ Task error [{phone}]: {e}")
        await report_result("warmup", {
            "task_id": task_id,
            "account_id": account.get("id"),
            "success": False,
            "error": str(e)
        })


async def main_loop():
    """Main warmup loop - Server-controlled batch processing
    
    Simple loop:
    1. Request tasks from server (server decides batch size)
    2. Execute ALL tasks in parallel
    3. Report ALL results
    4. Wait delay_after seconds (server-controlled)
    5. Repeat
    """
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Warmup Runner (Server-Controlled)")
    print("=" * 60)
    print(f"  🔥 Polling server every {POLL_INTERVAL} seconds")
    print("  🔧 All settings controlled by admin dashboard")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting warmup runner...\\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            # Request batch of tasks from server
            # Server controls: batch size, which tasks, timing
            batch_result = await get_batch_tasks(runner="warmup_chat")
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", POLL_INTERVAL)
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print("  ⏳ No pending warmup tasks, waiting...")
                elif consecutive_empty % 6 == 0:  # Every ~minute at 10s interval
                    print("  ⏳ Still waiting for warmup tasks...")
                
                # Also check for regular warmup tasks (channel joins, reactions, etc.)
                regular_task = await get_next_task(runner="warmup")
                if regular_task.get("task") != "wait":
                    await process_regular_warmup_task(regular_task)
                    consecutive_empty = 0
                else:
                    await asyncio.sleep(delay_after if delay_after > 0 else POLL_INTERVAL)
                continue
            
            consecutive_empty = 0
            print(f"\\n  📦 Processing batch of {len(tasks)} warmup tasks in PARALLEL...")
            
            # Execute ALL tasks in parallel
            results = await asyncio.gather(
                *[process_single_task(task) for task in tasks],
                return_exceptions=True
            )
            
            # Summary
            success_count = sum(1 for r in results if isinstance(r, dict) and r.get("success"))
            fail_count = len(results) - success_count
            print(f"  📊 Batch complete: {success_count} success, {fail_count} failed")
            
            # Disconnect clients after batch to save memory
            batch_account_ids = list(set(
                task.get("account", {}).get("id") 
                for task in tasks 
                if task.get("account", {}).get("id")
            ))
            await disconnect_batch(batch_account_ids)
            
            # Wait server-specified delay before next poll
            wait_time = delay_after if delay_after > 0 else POLL_INTERVAL
            await asyncio.sleep(wait_time)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
    
    print("\\n⏹ Warmup runner stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Warmup Runner - RUNS FOREVER")
    print("  Polls server every 7 seconds for tasks")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print("Required: pip install telethon httpx python-socks")
    
    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Keyboard interrupt - stopping...")
            break
        except Exception as e:
            print(f"\\n⚠ Runner crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== 9. RUN.BAT (for PC) ==========
  const runBat = `@echo off
echo =============================================
echo   TelegramCRM - Starting All Runners
echo =============================================
echo.

:: Start each runner in its own window
start "Campaign Runner" cmd /k "python campaign_runner.py"
start "Live Chat Listener" cmd /k "python live_chat_listener.py"
start "Account Manager" cmd /k "python account_manager.py"
start "Warmup Runner" cmd /k "python warmup_runner.py"

echo All 4 runners started!
echo Close all windows to stop.
pause
`;

  // ========== 10. VPS_AGENT.PY ==========
  const generateVpsApiKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  const vpsAgentPy = `"""
TelegramCRM VPS Agent
Manages all Python runners remotely - start/stop/restart/update
Polls Supabase for commands and reports status back
"""

import os
import sys
import asyncio
import signal
import subprocess
import zipfile
import io
import platform
from datetime import datetime
from typing import Dict, Optional

import httpx

# Configuration - will be replaced by SetupGuide download
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
VPS_API_KEY = "REPLACE_WITH_YOUR_VPS_KEY"  # Generated when VPS is registered

# Get the directory where this script lives
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Runner definitions
RUNNERS = {
    "campaign": "campaign_runner.py",
    "livechat": "live_chat_listener.py",
    "account": "account_manager.py",
    "warmup": "warmup_runner.py",
}

# Global state
RUNNING = True
processes: Dict[str, subprocess.Popen] = {}
vps_id: Optional[str] = None

POLL_INTERVAL = 5  # seconds
HEARTBEAT_INTERVAL = 10  # seconds


def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


async def register_vps(client: httpx.AsyncClient) -> Optional[str]:
    """Register this VPS and get its ID."""
    global vps_id
    
    # Check if already registered
    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers=get_headers(),
        params={"api_key": f"eq.{VPS_API_KEY}", "select": "id"}
    )
    
    if resp.status_code == 200 and resp.json():
        vps_id = resp.json()[0]["id"]
        print(f"[VPS] Found existing VPS: {vps_id[:8]}...")
        return vps_id
    
    # Register new VPS
    ip = await get_public_ip(client)
    resp = await client.post(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers={**get_headers(), "Prefer": "return=representation"},
        json={
            "name": f"VPS-{platform.node()}",
            "api_key": VPS_API_KEY,
            "ip_address": ip,
            "status": "online"
        }
    )
    
    if resp.status_code == 201:
        vps_id = resp.json()[0]["id"]
        print(f"[VPS] Registered new VPS: {vps_id[:8]}...")
        return vps_id
    
    print(f"[ERROR] Failed to register VPS: {resp.text}")
    return None


async def get_public_ip(client: httpx.AsyncClient) -> str:
    try:
        resp = await client.get("https://api.ipify.org?format=text", timeout=5)
        return resp.text.strip()
    except:
        return "unknown"


async def send_heartbeat(client: httpx.AsyncClient):
    """Update VPS status in database."""
    if not vps_id:
        return
    
    await client.patch(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers=get_headers(),
        params={"id": f"eq.{vps_id}"},
        json={
            "status": "online",
            "last_seen": datetime.utcnow().isoformat(),
        }
    )


async def send_log(client: httpx.AsyncClient, runner: str, level: str, message: str):
    """Send a log entry to the database."""
    if not vps_id:
        return
    
    await client.post(
        f"{SUPABASE_URL}/rest/v1/vps_logs",
        headers=get_headers(),
        json={
            "vps_id": vps_id,
            "runner_name": runner,
            "log_level": level,
            "message": message[:500],  # Limit message length
        }
    )


async def poll_commands(client: httpx.AsyncClient) -> list:
    """Get pending commands from database."""
    if not vps_id:
        return []
    
    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/vps_commands",
        headers=get_headers(),
        params={
            "vps_id": f"eq.{vps_id}",
            "status": "eq.pending",
            "order": "created_at.asc",
            "limit": "10"
        }
    )
    
    if resp.status_code == 200:
        return resp.json()
    return []


async def update_command(client: httpx.AsyncClient, cmd_id: str, status: str, result: str = None):
    """Update command status in database."""
    await client.patch(
        f"{SUPABASE_URL}/rest/v1/vps_commands",
        headers=get_headers(),
        params={"id": f"eq.{cmd_id}"},
        json={
            "status": status,
            "result": result,
            "processed_at": datetime.utcnow().isoformat(),
        }
    )


async def start_runner(name: str, client: httpx.AsyncClient = None, fetch_first: bool = False) -> bool:
    """Start a specific runner process."""
    # Optionally fetch latest scripts before starting
    if fetch_first and client:
        await update_scripts(client, restart_after=False)
    
    if name in processes and processes[name].poll() is None:
        print(f"[RUNNER] {name} already running")
        return False
    
    script = RUNNERS.get(name)
    if not script:
        print(f"[ERROR] Unknown runner: {name}")
        return False
    
    # Use absolute path from script directory
    script_path = os.path.join(SCRIPT_DIR, script)
    if not os.path.exists(script_path):
        print(f"[ERROR] Script not found: {script_path}")
        return False
    
    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", script_path],  # -u for unbuffered output
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=SCRIPT_DIR,
            bufsize=1,
            universal_newlines=True,
        )
        processes[name] = proc
        print(f"[RUNNER] Started {name} (PID: {proc.pid})")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to start {name}: {e}")
        return False


def stop_runner(name: str) -> bool:
    """Stop a specific runner process."""
    if name not in processes:
        return False
    
    proc = processes[name]
    if proc.poll() is not None:
        del processes[name]
        return False
    
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    
    del processes[name]
    print(f"[RUNNER] Stopped {name}")
    return True


async def start_all(client: httpx.AsyncClient = None, fetch_first: bool = True):
    """Start all runners."""
    # Fetch latest scripts before starting all
    if fetch_first and client:
        await update_scripts(client, restart_after=False)
    
    results = []
    for name in RUNNERS:
        if await start_runner(name, client, fetch_first=False):
            results.append(name)
    return results


def stop_all():
    """Stop all runners."""
    results = []
    for name in list(processes.keys()):
        if stop_runner(name):
            results.append(name)
    return results


async def restart_all(client: httpx.AsyncClient = None):
    """Restart all runners."""
    stop_all()
    return await start_all(client, fetch_first=True)


async def update_scripts(client: httpx.AsyncClient, restart_after: bool = False) -> bool:
    """Download latest scripts from Supabase storage."""
    try:
        # Download ZIP from storage
        resp = await client.get(
            f"{SUPABASE_URL}/storage/v1/object/public/python-scripts/runners.zip",
            timeout=60
        )
        
        if resp.status_code != 200:
            print(f"[UPDATE] No update package found (status: {resp.status_code})")
            return False
        
        # Stop all runners first
        stop_all()
        
        # Extract ZIP to script directory
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            for info in zf.infolist():
                if info.filename.endswith('.py') and not info.filename.startswith('__'):
                    with zf.open(info) as source:
                        # Get just the filename, extract to SCRIPT_DIR
                        filename = os.path.basename(info.filename)
                        # Don't overwrite vps_agent.py or config.py
                        if filename in ['vps_agent.py', 'config.py']:
                            continue
                        target_path = os.path.join(SCRIPT_DIR, filename)
                        with open(target_path, 'wb') as target:
                            target.write(source.read())
                        print(f"[UPDATE] Extracted: {filename}")
        
        print("[UPDATE] Scripts updated successfully")
        
        if restart_after:
            await start_all(client, fetch_first=False)
        
        return True
        
    except Exception as e:
        print(f"[ERROR] Update failed: {e}")
        return False


async def process_command(client: httpx.AsyncClient, cmd: dict):
    """Process a single command."""
    cmd_id = cmd["id"]
    command = cmd["command"]
    target = cmd.get("target_runner")
    
    print(f"[CMD] Processing: {command}" + (f" ({target})" if target else ""))
    
    await update_command(client, cmd_id, "processing")
    
    try:
        result = ""
        
        if command == "start_all":
            started = await start_all(client, fetch_first=True)
            result = f"Started: {', '.join(started) if started else 'none'}"
            
        elif command == "stop_all":
            stopped = stop_all()
            result = f"Stopped: {', '.join(stopped) if stopped else 'none'}"
            
        elif command == "restart_all":
            restarted = await restart_all(client)
            result = f"Restarted: {', '.join(restarted) if restarted else 'none'}"
            
        elif command == "start_runner" and target:
            # Fetch latest scripts before starting single runner too
            if await start_runner(target, client, fetch_first=True):
                result = f"Started {target}"
            else:
                result = f"Failed to start {target}"
                
        elif command == "stop_runner" and target:
            if stop_runner(target):
                result = f"Stopped {target}"
            else:
                result = f"{target} was not running"
                
        elif command == "update":
            if await update_scripts(client, restart_after=True):
                result = "Scripts updated and restarted"
            else:
                result = "No updates available"
        else:
            result = f"Unknown command: {command}"
        
        await update_command(client, cmd_id, "completed", result)
        await send_log(client, "agent", "info", f"Command: {command} -> {result}")
        
    except Exception as e:
        error = str(e)[:200]
        await update_command(client, cmd_id, "failed", error)
        await send_log(client, "agent", "error", f"Command failed: {command} - {error}")


async def monitor_processes(client: httpx.AsyncClient):
    """Monitor runner processes, capture output, and restart if crashed."""
    for name, proc in list(processes.items()):
        # Read available output lines (non-blocking)
        try:
            if proc.stdout:
                import select
                # Check if there's data to read (works on Unix)
                if hasattr(select, 'select'):
                    readable, _, _ = select.select([proc.stdout], [], [], 0)
                    if readable:
                        line = proc.stdout.readline()
                        if line:
                            line = line.strip()
                            # Determine log level from content
                            level = "info"
                            if "[ERROR]" in line or "error" in line.lower():
                                level = "error"
                            elif "[WARNING]" in line or "warning" in line.lower():
                                level = "warning"
                            await send_log(client, name, level, f"[PID:{proc.pid}] {line}")
                else:
                    # Windows fallback - try readline with short timeout
                    line = proc.stdout.readline()
                    if line:
                        line = line.strip()
                        level = "info"
                        if "[ERROR]" in line or "error" in line.lower():
                            level = "error"
                        elif "[WARNING]" in line or "warning" in line.lower():
                            level = "warning"
                        await send_log(client, name, level, f"[PID:{proc.pid}] {line}")
        except Exception as e:
            pass  # Ignore read errors
        
        if proc.poll() is not None:
            # Process has exited
            exit_code = proc.returncode
            await send_log(client, name, "warning", f"[PID:{proc.pid}] Process exited with code {exit_code}, restarting...")
            del processes[name]
            # Auto-restart
            await start_runner(name, client, fetch_first=False)


async def main_loop():
    """Main agent loop."""
    global RUNNING
    
    print("=" * 50)
    print("  TelegramCRM VPS Agent")
    print("=" * 50)
    
    async with httpx.AsyncClient() as client:
        # Register VPS
        if not await register_vps(client):
            print("[FATAL] Could not register VPS")
            return
        
        await send_log(client, "agent", "info", "VPS Agent started")
        
        last_heartbeat = 0
        
        while RUNNING:
            try:
                now = asyncio.get_event_loop().time()
                
                # Send heartbeat
                if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                    await send_heartbeat(client)
                    last_heartbeat = now
                
                # Poll for commands
                commands = await poll_commands(client)
                for cmd in commands:
                    await process_command(client, cmd)
                
                await monitor_processes(client)
                
                await asyncio.sleep(POLL_INTERVAL)
                
            except Exception as e:
                print(f"[ERROR] Main loop: {e}")
                await asyncio.sleep(5)
        
        print("[VPS] Shutting down...")
        stop_all()
        await send_log(client, "agent", "info", "VPS Agent stopped")


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[VPS] Received shutdown signal")
    RUNNING = False


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    asyncio.run(main_loop())
`;

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    // Core files
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("fingerprint_generator.py", fingerprintGeneratorPy);
    folder?.file("requirements.txt", requirementsTxt);
    
    // Individual runners - using correct filenames matching /python folder
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("live_chat_listener.py", livechatRunnerPy);
    folder?.file("account_manager.py", accountRunnerPy);
    folder?.file("warmup_runner.py", warmupRunnerPy);
    
    // Single BAT to run all
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("ZIP downloaded! 9 files included.");
  };

  const downloadVpsZip = async () => {
    const vpsApiKey = generateVpsApiKey();
    const vpsAgentWithKey = vpsAgentPy.replace('REPLACE_WITH_YOUR_VPS_KEY', vpsApiKey);
    
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm_vps");
    
    // Core files
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("fingerprint_generator.py", fingerprintGeneratorPy);
    folder?.file("requirements.txt", requirementsTxt);
    
    // Individual runners - using correct filenames matching /python folder
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("live_chat_listener.py", livechatRunnerPy);
    folder?.file("account_manager.py", accountRunnerPy);
    folder?.file("warmup_runner.py", warmupRunnerPy);
    
    // VPS Agent
    folder?.file("vps_agent.py", vpsAgentWithKey);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm_vps.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("VPS ZIP downloaded! Run vps_agent.py on your server.");
  };

  // Manual sync function
  const syncScriptsToStorage = async (showToast = true) => {
    setIsSyncing(true);
    try {
      const zip = new JSZip();
      zip.file("campaign_runner.py", campaignRunnerPy);
      zip.file("live_chat_listener.py", livechatRunnerPy);
      zip.file("account_manager.py", accountRunnerPy);
      zip.file("warmup_runner.py", warmupRunnerPy);
      zip.file("client_manager.py", clientManagerPy);
      zip.file("fingerprint_generator.py", fingerprintGeneratorPy);
      zip.file("config.py", configPy);
      zip.file("requirements.txt", requirementsTxt);
      zip.file("RUN.bat", runBat);

      const blob = await zip.generateAsync({ type: "blob" });
      
      const { error } = await supabase.storage
        .from('python-scripts')
        .upload('runners.zip', blob, { 
          upsert: true,
          contentType: 'application/zip'
        });
      
      if (error) throw error;
      
      setLastSyncTime(new Date());
      console.log('[Sync] Scripts synced to storage');
      if (showToast) {
        toast.success("Scripts synced to VPS storage! Click 'Update All' in VPS controls to apply.");
      }
    } catch (error) {
      console.error('[Sync] Failed to sync scripts:', error);
      if (showToast) {
        toast.error("Failed to sync scripts to storage");
      }
    } finally {
      setIsSyncing(false);
    }
  };

  // Auto-sync scripts to storage on page load
  React.useEffect(() => {
    syncScriptsToStorage(false);
  }, []);

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python files for your PC or VPS"
          icon={BookOpen}
        />

        <Tabs defaultValue="pc" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="pc" className="gap-2">
              <Monitor className="h-4 w-4" />
              Run on PC
            </TabsTrigger>
            <TabsTrigger value="vps" className="gap-2">
              <Server className="h-4 w-4" />
              Run on VPS
              <Badge variant="secondary" className="ml-1 text-xs">Remote Control</Badge>
            </TabsTrigger>
          </TabsList>

          {/* PC Mode */}
          <TabsContent value="pc">
            <Card>
              <CardContent className="p-8 text-center space-y-6">
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold">Download for PC</h2>
                  <p className="text-muted-foreground">
                    5 separate runners + 1 BAT file to run them all
                  </p>
                </div>

                <Button size="lg" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
                  <Download className="h-6 w-6" />
                  Download ZIP
                </Button>

                <div className="text-left bg-muted rounded-lg p-4 space-y-3">
                  <p className="font-medium">📁 Files included (9 total):</p>
                  <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                    <li><code className="text-green-600 dark:text-green-400">RUN.bat</code> - <strong>Double-click to START all 4 runners</strong></li>
                    <li><code className="text-blue-500">campaign_runner.py</code> - Send messages + batch reporting</li>
                    <li><code className="text-purple-500">live_chat_listener.py</code> - Incoming messages + replies</li>
                    <li><code className="text-yellow-500">account_manager.py</code> - SpamBot, name, photo, privacy</li>
                    <li><code className="text-orange-500">warmup_runner.py</code> - Warmup chat (pairs) + join/view/react/bio</li>
                    <li><code>config.py</code> - Backend settings</li>
                    <li><code>client_manager.py</code> - Shared Telegram logic + batch reporting</li>
                    <li><code>fingerprint_generator.py</code> - Device fingerprints</li>
                    <li><code>requirements.txt</code> - Dependencies</li>
                  </ul>
                </div>

                <div className="text-left bg-muted rounded-lg p-4 space-y-3">
                  <p className="font-medium">🚀 How to use:</p>
                  <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                    <li>Extract ZIP folder</li>
                    <li>Double-click <code className="bg-green-100 dark:bg-green-900 px-2 py-0.5 rounded">RUN.bat</code></li>
                    <li>4 colored windows will open (one for each runner)</li>
                    <li>To stop: Close all windows or press <kbd className="bg-background px-2 py-0.5 rounded border">Ctrl+C</kbd></li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* VPS Mode */}
          <TabsContent value="vps">
            <div className="space-y-4">
              {/* VPS Control Panel */}
              <VPSControlPanel />

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-primary" />
                    VPS Setup
                    <Badge variant="outline" className="ml-2">Recommended</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="text-sm text-muted-foreground">
                    Control your runners remotely. Start, stop, restart, view logs, and auto-update scripts - all from your browser!
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Step 1: Download */}
                    <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
                      <div className="flex items-center gap-2 font-medium">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">1</span>
                        Download VPS Package
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Includes VPS Agent for remote control + all runners
                      </p>
                      <Button onClick={downloadVpsZip} className="w-full gap-2">
                        <Download className="h-4 w-4" />
                        Download VPS ZIP
                      </Button>
                    </div>

                    {/* Step 2: Setup */}
                    <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
                      <div className="flex items-center gap-2 font-medium">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">2</span>
                        Setup on VPS
                      </div>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p><code>pip install -r requirements.txt</code></p>
                        <p><code>python vps_agent.py</code></p>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-lg border border-green-500/30 bg-green-500/5 space-y-2">
                    <div className="flex items-center gap-2 font-medium text-green-600">
                      <CheckCircle2 className="h-4 w-4" />
                      What you get with VPS mode
                    </div>
                    <ul className="text-sm text-muted-foreground space-y-1 ml-6">
                      <li>• Start/stop individual runners remotely</li>
                      <li>• View real-time logs in your browser</li>
                      <li>• Auto-restart on crash</li>
                      <li>• One-click script updates (auto-sync)</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>

              {/* Manual Sync Button */}
              <Card className="border-blue-500/30 bg-blue-500/5">
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    <Upload className="h-5 w-5 text-blue-500 mt-0.5" />
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-blue-600 dark:text-blue-400">Sync Scripts to VPS Storage</p>
                        {lastSyncTime && (
                          <span className="text-xs text-muted-foreground">
                            Last synced: {lastSyncTime.toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Upload latest crash-proof scripts to storage. Then click "Update All" in VPS controls above to apply on your VPS.
                      </p>
                      <Button 
                        onClick={() => syncScriptsToStorage(true)} 
                        disabled={isSyncing}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                      >
                        {isSyncing ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Syncing...
                          </>
                        ) : (
                          <>
                            <Upload className="h-4 w-4" />
                            Sync Scripts Now
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
