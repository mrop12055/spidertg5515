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

  // ========== 1. CONFIG.PY ==========
  const configPy = `"""
TelegramCRM - Configuration
"""

BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"
`;

  // ========== 2. CLIENT_MANAGER.PY (ULTRA-FAST + Proxy Auto-Switch) ==========
  const clientManagerPy = `"""
TelegramCRM - Client Manager (ULTRA-FAST)
Zero stagger, unlimited concurrency, split timeouts, proxy auto-switch
"""

import os
import base64
import tempfile
import asyncio
import httpx
import socks
from typing import Dict, Optional

from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError

from config import BACKEND_URL, SUPABASE_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")
active_clients: Dict[str, TelegramClient] = {}

# ========== SPLIT TIMEOUTS ==========
CONNECTION_TIMEOUT = 10      # Telegram connection timeout
CONNECTION_RETRIES = 1       # Fail fast, switch proxy immediately
RETRY_DELAY = 0              # No retry delay

# HTTP Timeouts - split by purpose
HTTP_TIMEOUT_DISPATCH = 15   # Task fetching (get-next-task, get-batch-tasks)
HTTP_TIMEOUT_REPORT = 10     # Reporting (report-task-result, report-batch-results)
HTTP_TIMEOUT_PROXY = 5       # Proxy switch calls
HTTP_TIMEOUT_DEFAULT = 10    # Other REST calls

# Backoff tracking for HTTP errors
_consecutive_http_errors = 0
MAX_HTTP_BACKOFF = 30

# Proxy error patterns - fail fast on these
PROXY_ERROR_PATTERNS = [
    "semaphore timeout", "winerror 121", "connection refused", 
    "proxy", "socks", "timed out", "timeout", "cannot connect",
    "connection reset", "connection closed", "no route"
]

# ========== SHARED HTTP CLIENT POOL ==========
_http_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    """Get shared HTTP client with connection pooling - no default timeout (set per-request)"""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT_DEFAULT,
            limits=httpx.Limits(max_connections=500, max_keepalive_connections=100)
        )
    return _http_client


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
    """Extract proxy settings.

    Priority: task_proxy (from get-next-task/get-batch-tasks) > account.proxy
    """
    proxy = task_proxy or account.get("proxy")
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
        # http / https
        ptype = socks.HTTP
    
    if username and password:
        return (ptype, host, int(port), True, username, password)
    return (ptype, host, int(port))


async def connect_with_retry(client: TelegramClient, max_retries: int = CONNECTION_RETRIES) -> bool:
    """Fast connect - fail immediately on timeout/proxy error"""
    try:
        await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
        return True
    except asyncio.TimeoutError:
        print(f"    [TIMEOUT] Connection timeout")
        return False
    except Exception as e:
        err_str = str(e).lower()
        if any(p in err_str for p in PROXY_ERROR_PATTERNS):
            print(f"    [PROXY FAIL] {e}")
            return False
        print(f"    [ERROR] {e}")
        return False


async def switch_account_proxy(account_id: str, old_proxy_id: str = None) -> dict:
    """Call edge function to switch account proxy and save to DB"""
    try:
        http = get_http_client()
        resp = await asyncio.wait_for(
            http.post(
                f"{BACKEND_URL}/switch-account-proxy",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={"account_id": account_id, "old_proxy_id": old_proxy_id},
                timeout=HTTP_TIMEOUT_PROXY
            ),
            timeout=HTTP_TIMEOUT_PROXY + 1
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("new_proxy")
        return None
    except Exception as e:
        print(f"    [PROXY SWITCH ERROR] {e}")
        return None


async def get_or_create_client(account: dict, setup_handler=None, task_proxy: dict = None,
                                auto_switch_proxy: bool = True, skip_avatar: bool = False,
                                require_proxy: bool = True) -> Optional[TelegramClient]:
    """
    Get or create a Telegram client for an account.
    
    Args:
        account: Account data with session, fingerprint, proxy info
        setup_handler: Optional handler to setup after connection
        task_proxy: Proxy from task (overrides account.proxy)
        auto_switch_proxy: If True, switch proxy on connection failure
        skip_avatar: If True, skip profile sync
        require_proxy: If True (default), skip account if no proxy assigned
    """
    account_id = account["id"]
    phone = account.get("phone_number", account_id[:8])
    
    # ========== STEP 1: CHECK EXISTING CLIENT ==========
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                # Client already connected with correct proxy/fingerprint - reuse it
                print(f"  [CACHED] Reusing existing connection for {phone}")
                if setup_handler and not getattr(client, "_handler", False):
                    await setup_handler(client, account_id)
                    setattr(client, "_handler", True)
                return client
        except:
            del active_clients[account_id]
    
    # ========== STEP 2: CHECK SESSION DATA ==========
    session_data = account.get("session_data")
    if not session_data:
        print(f"  [SKIP] {phone} - No session data")
        return None
    
    # ========== STEP 3: CHECK PROXY (CRITICAL SAFETY) ==========
    proxy = get_proxy_settings(account, task_proxy=task_proxy)
    old_proxy_id = task_proxy.get("id") if task_proxy else account.get("proxy_id")
    
    if require_proxy and not proxy:
        print(f"  [SKIP] {phone} - No proxy assigned (safety: accounts without proxy are skipped)")
        return None
    
    # ========== STEP 4: DECODE SESSION FILE ==========
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    # ========== STEP 5: USE OR GENERATE FINGERPRINT ==========
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version") or "10.14.2"
    lang_code = account.get("lang_code") or "en"
    system_lang_code = account.get("system_lang_code") or "en-US"
    
    # If fingerprint is missing, generate one and save to DB
    if not device_model or not system_version:
        fp = generate_fingerprint()
        device_model = fp["device_model"]
        system_version = fp["system_version"]
        app_version = fp["app_version"]
        lang_code = fp["lang_code"]
        system_lang_code = fp["system_lang_code"]
        print(f"  [FP] Generated new fingerprint: {device_model} ({system_version})")
        # Save fingerprint to database immediately
        asyncio.create_task(report_result("fingerprint_generated", {
            "account_id": account_id,
            "device_model": device_model,
            "system_version": system_version,
            "app_version": app_version,
            "lang_code": lang_code,
            "system_lang_code": system_lang_code
        }))
    else:
        print(f"  [FP] Using existing: {device_model} ({system_version})")
    
    if proxy:
        print(f"  [PROXY] Using: {proxy[1]}:{proxy[2]}")
    
    try:
        api_id = account.get("api_id") or TELEGRAM_API_ID
        api_hash = account.get("api_hash") or TELEGRAM_API_HASH
        
        client = TelegramClient(
            session_path, int(api_id), api_hash,
            device_model=device_model,
            system_version=system_version,
            app_version=app_version,
            lang_code=lang_code,
            system_lang_code=system_lang_code,
            proxy=proxy,
            timeout=CONNECTION_TIMEOUT,
            connection_retries=0,
            retry_delay=0,
            auto_reconnect=True,
            request_retries=1
        )
        
        print(f"  [CONNECT] {account['phone_number']}...")
        if not await connect_with_retry(client):
            # Proxy timeout - switch proxy and retry immediately
            if auto_switch_proxy:
                print(f"  [PROXY SWITCH] Trying new proxy for {account['phone_number']}...")
                new_proxy = await switch_account_proxy(account_id, old_proxy_id)
                if new_proxy:
                    print(f"  [PROXY SWITCH] Got: {new_proxy['host']}:{new_proxy['port']}")
                    account["proxy"] = new_proxy
                    return await get_or_create_client(account, setup_handler, task_proxy=new_proxy,
                                                       auto_switch_proxy=False, skip_avatar=skip_avatar, require_proxy=False)
            print(f"  [FAIL] Could not connect (proxy failed): {account['phone_number']}")
            return None
        
        if not await client.is_user_authorized():
            asyncio.create_task(report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"}))
            return None
        
        me = None
        if not skip_avatar:
            try:
                me = await asyncio.wait_for(client.get_me(), timeout=5)
                if not me:
                    print(f"  [BANNED] Account deleted: {account['phone_number']}")
                    asyncio.create_task(report_result("account_banned", {"account_id": account_id, "reason": "Account deleted"}))
                    return None
            except Exception as me_err:
                err_str = str(me_err).lower()
                if any(x in err_str for x in ["deleted", "deactivated", "banned", "user_deactivated"]):
                    print(f"  [BANNED] {account['phone_number']}: {me_err}")
                    asyncio.create_task(report_result("account_banned", {"account_id": account_id, "reason": str(me_err)}))
                    return None
                elif any(x in err_str for x in ["session", "revoked", "auth"]):
                    print(f"  [EXPIRED] {account['phone_number']}: {me_err}")
                    asyncio.create_task(report_result("account_disconnected", {"account_id": account_id, "reason": str(me_err)}))
                    return None
        
        if setup_handler:
            await setup_handler(client, account_id)
            setattr(client, "_handler", True)
        
        active_clients[account_id] = client
        asyncio.create_task(report_result("account_connected", {"account_id": account_id, "skip_profile_update": True}))
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
    except Exception as e:
        err_str = str(e).lower()
        if any(x in err_str for x in ["deleted", "deactivated", "banned"]):
            print(f"  [BANNED] {account['phone_number']}: {e}")
            asyncio.create_task(report_result("account_banned", {"account_id": account_id, "reason": str(e)}))
        else:
            print(f"  [FAIL] {account['phone_number']}: {e}")
        return None


async def get_next_task(runner: str = None) -> dict:
    """Fetch single task using shared HTTP client with proper timeout and error handling"""
    global _consecutive_http_errors
    try:
        body = {"runner": runner} if runner else {}
        http = get_http_client()
        resp = await asyncio.wait_for(
            http.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body,
                timeout=HTTP_TIMEOUT_DISPATCH
            ),
            timeout=HTTP_TIMEOUT_DISPATCH + 1
        )
        
        if resp.status_code != 200:
            print(f"  [HTTP ERROR] get_next_task: status={resp.status_code}, body={resp.text[:200]}")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
            return {"task": "wait", "seconds": backoff}
        
        try:
            data = resp.json()
            _consecutive_http_errors = 0  # Reset on success
            return data
        except Exception as json_err:
            print(f"  [HTTP ERROR] get_next_task: JSON decode failed: {json_err}, body={resp.text[:200]}")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
            return {"task": "wait", "seconds": backoff}
            
    except asyncio.TimeoutError:
        print(f"  [HTTP ERROR] get_next_task: Timeout after {HTTP_TIMEOUT_DISPATCH}s")
        _consecutive_http_errors += 1
        backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
        return {"task": "wait", "seconds": backoff}
    except Exception as e:
        print(f"  [HTTP ERROR] get_next_task: {type(e).__name__}: {repr(e)}")
        _consecutive_http_errors += 1
        backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
        return {"task": "wait", "seconds": backoff}


async def get_batch_tasks(runner: str = None, batch_size: int = 50) -> dict:
    """Fetch batch of tasks using shared HTTP client with proper timeout and error handling"""
    global _consecutive_http_errors
    try:
        body = {"runner": runner, "batch_size": batch_size}
        http = get_http_client()
        resp = await asyncio.wait_for(
            http.post(
                f"{BACKEND_URL}/get-batch-tasks",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body,
                timeout=HTTP_TIMEOUT_DISPATCH
            ),
            timeout=HTTP_TIMEOUT_DISPATCH + 1
        )
        
        if resp.status_code != 200:
            print(f"  [HTTP ERROR] get_batch_tasks: status={resp.status_code}, body={resp.text[:200]}")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
            return {"tasks": [], "delay_after": backoff}
        
        try:
            data = resp.json()
            _consecutive_http_errors = 0  # Reset on success
            return data
        except Exception as json_err:
            print(f"  [HTTP ERROR] get_batch_tasks: JSON decode failed: {json_err}, body={resp.text[:200]}")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
            return {"tasks": [], "delay_after": backoff}
            
    except asyncio.TimeoutError:
        print(f"  [HTTP ERROR] get_batch_tasks: Timeout after {HTTP_TIMEOUT_DISPATCH}s")
        _consecutive_http_errors += 1
        backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
        return {"tasks": [], "delay_after": backoff}
    except Exception as e:
        print(f"  [HTTP ERROR] get_batch_tasks: {type(e).__name__}: {repr(e)}")
        _consecutive_http_errors += 1
        backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
        return {"tasks": [], "delay_after": backoff}


async def report_result(task_type: str, result: dict):
    """Report task result (never block the runner; log failures)."""
    try:
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"task_type": task_type, "result": result},
            timeout=HTTP_TIMEOUT_REPORT,
        )
        if resp.status_code >= 300:
            print(f"  [REPORT ERROR] {task_type}: status={resp.status_code}, body={resp.text[:200]}")
    except Exception as e:
        print(f"  [REPORT EXC] {task_type}: {type(e).__name__}: {repr(e)}")


async def report_batch_results(results: list) -> bool:
    """Report many send results in one request for speed."""
    try:
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/report-batch-results",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"results": results},
            timeout=HTTP_TIMEOUT_REPORT,
        )
        if 200 <= resp.status_code < 300:
            return True
        print(f"  [BATCH REPORT] {resp.status_code}: {resp.text[:200]}")
        return False
    except Exception as e:
        print(f"  [BATCH REPORT ERROR] {type(e).__name__}: {repr(e)}")
        return False

async def send_message(client: TelegramClient, recipient: str, content: str, media_url: str = None):
    try:
        entity = None
        if recipient.startswith("@"):
            entity = await asyncio.wait_for(client.get_entity(recipient), timeout=10)  # Faster
        else:
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            
            phone = recipient if recipient.startswith("+") else "+" + recipient
            try:
                entity = await asyncio.wait_for(client.get_entity(phone), timeout=8)  # Faster
            except:
                pass
            
            if not entity:
                contact = InputPhoneContact(client_id=random.randint(0, 2**62), phone=phone, first_name="TG", last_name=str(random.randint(1000, 9999)))
                result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)  # Faster
                if result.users:
                    entity = result.users[0]
                elif result.retry_contacts:
                    return False, "Privacy restricted"
        
        if not entity:
            return False, "User not found on Telegram"
        
        # Ensure URLs are clickable: format URLs as Telegram Markdown links when detected
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

        if media_url:
            try:
                import io
                http = get_http_client()
                resp = await http.get(media_url)
                if resp.status_code == 200:
                    # Determine filename from URL to help Telethon classify the file
                    from urllib.parse import urlparse, unquote
                    url_path = urlparse(media_url).path
                    filename = unquote(url_path.split("/")[-1]) if url_path else "attachment"
                    
                    # Check if it's an image based on extension or content-type
                    content_type = resp.headers.get("content-type", "").lower()
                    ext = filename.split(".")[-1].lower() if "." in filename else ""
                    is_image = ext in ("jpg", "jpeg", "png", "gif", "webp") or content_type.startswith("image/")
                    
                    # Wrap bytes in BytesIO with a name so Telethon knows the file type
                    file_bytes = io.BytesIO(resp.content)
                    file_bytes.name = filename if "." in filename else f"photo.jpg"
                    
                    print(f"  [MEDIA] filename={filename}, content_type={content_type}, is_image={is_image}")
                    
                    # For images, use force_document=False to send as photo preview
                    await asyncio.wait_for(
                        client.send_file(entity, file_bytes, caption=formatted_content, force_document=not is_image, parse_mode=parse_mode),
                        timeout=20  # Faster media send
                    )
                else:
                    await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=10)
            except Exception as media_err:
                print(f"  [MEDIA ERROR] {media_err}")
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=10)
        else:
            await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=10)  # Faster
        
        return True, None
    except asyncio.TimeoutError:
        return False, "Request timeout"
    except UserPrivacyRestrictedError:
        return False, "Privacy restricted"
    except FloodWaitError as e:
        return False, f"Rate limited: {e.seconds}s"
    except Exception as e:
        return False, str(e)


async def validate_contact(client: TelegramClient, phone: str):
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        import random
        contact = InputPhoneContact(client_id=random.randint(0, 2**31 - 1), phone=phone, first_name="V", last_name="")
        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
        if result.users:
            user = result.users[0]
            return True, f"{user.first_name or ''} {user.last_name or ''}".strip(), user.id
        return False, None, None
    except:
        return False, None, None


async def disconnect_batch(account_ids: list):
    """Disconnect multiple clients after batch completion to free memory."""
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


async def cleanup_stale_clients():
    """Remove disconnected Telegram clients from active_clients - call periodically"""
    stale = []
    for acc_id, client in list(active_clients.items()):
        try:
            if not client.is_connected():
                stale.append(acc_id)
        except:
            stale.append(acc_id)
    
    for acc_id in stale:
        try:
            await asyncio.wait_for(active_clients[acc_id].disconnect(), timeout=5)
        except:
            pass
        del active_clients[acc_id]
    
    if stale:
        print(f"  [CLEANUP] Removed {len(stale)} stale Telegram clients")
    
    return len(stale)


async def disconnect_client(account_id: str, phone: str = None):
    """Disconnect and remove client from cache to free session file for other runners."""
    if account_id in active_clients:
        try:
            client = active_clients[account_id]
            await client.disconnect()
            del active_clients[account_id]
            if phone:
                print(f"  [DISCONNECT] Released {phone}")
        except Exception as e:
            # Still remove from cache even if disconnect fails
            active_clients.pop(account_id, None)


async def shutdown_all():
    print("\\n[SHUTDOWN] Disconnecting...")
    for account_id, client in list(active_clients.items()):
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except:
            pass
    active_clients.clear()
    
    # Close HTTP client
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None
    
    print("[OK] Done.")
`;

  // ========== 3. FINGERPRINT_GENERATOR.PY ==========
  const fingerprintGeneratorPy = `"""Device Fingerprint Generator"""
import random

ANDROID_DEVICES = [
    {"model": "Samsung SM-G991B", "versions": ["Android 12", "Android 13"]},
    {"model": "Samsung SM-A525F", "versions": ["Android 11", "Android 12"]},
    {"model": "Xiaomi 12", "versions": ["Android 12", "Android 13"]},
    {"model": "OnePlus 9 Pro", "versions": ["Android 11", "Android 12"]},
    {"model": "Google Pixel 7", "versions": ["Android 13", "Android 14"]},
    {"model": "HUAWEI Mate 50 Pro", "versions": ["Android 12", "Android 13"]},
]
IOS_DEVICES = [
    {"model": "iPhone 13 Pro", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0"]},
    {"model": "iPhone 14", "versions": ["iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 15 Pro", "versions": ["iOS 17.0", "iOS 17.2"]},
]
VERSIONS = ["10.3.2", "10.4.0", "10.6.0", "10.9.0", "10.14.2", "11.0.0", "11.2.0"]
LANGUAGES = [
    {"code": "en", "systems": ["en-US", "en-GB"]},
    {"code": "ar", "systems": ["ar-SA", "ar-AE"]},
    {"code": "de", "systems": ["de-DE"]},
    {"code": "es", "systems": ["es-ES", "es-MX"]},
]

def generate_fingerprint():
    use_android = random.random() < 0.8
    device = random.choice(ANDROID_DEVICES if use_android else IOS_DEVICES)
    lang = random.choice(LANGUAGES)
    return {
        "device_model": device["model"],
        "system_version": random.choice(device["versions"]),
        "app_version": random.choice(VERSIONS),
        "lang_code": lang["code"],
        "system_lang_code": random.choice(lang["systems"])
    }
`;

  // ========== 4. CAMPAIGN_RUNNER.PY ==========
  const campaignRunnerPy = String.raw`#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Admin-Controlled Speed)
=======================================================
BUILD: 2026-01-09-admin-speed

SPEED CONTROL via Admin Dashboard:
- staggerMin/staggerMax: delay between messages (0 = instant ultra-fast)
- batchSize: messages per batch (0 = unlimited)
- pollingInterval: wait between batches
- Proxy auto-switch on timeout

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

BUILD_VERSION = "2026-01-09-admin-speed"

import asyncio
import signal
import time
import random

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, disconnect_batch, report_batch_results
)

# ========== GLOBAL STATE ==========
RUNNING = True
DEFAULT_POLL_INTERVAL = 5  # Fallback if server doesn't specify
REPORT_CONCURRENCY = None  # Unlimited parallel reports


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
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


async def process_single_task(task: dict, stagger_min: float, stagger_max: float) -> dict:
    """Process a single campaign send task with admin-controlled stagger.

    stagger_min/stagger_max = 0: Ultra-fast mode (no delay)
    stagger_min/stagger_max > 0: Controlled speed from admin dashboard

    IMPORTANT: This function is fully isolated - any exception here
    only affects this task, never crashes the whole runner.
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
        # Get or create client with task-level proxy (auto-switch enabled)
        client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True)

        if not client:
            result = {
                "success": False,
                "error": "Could not connect client",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account_id,
            }
            print(f"    ✗ [{account_phone}] No client")
            return result

        # ADMIN-CONTROLLED STAGGER: if stagger_max > 0, add delay
        if stagger_max > 0:
            stagger_delay = random.uniform(stagger_min, stagger_max)
            if stagger_delay > 0:
                await asyncio.sleep(stagger_delay)

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
    """Report all results - UNLIMITED concurrency, 1s timeout."""
    start_time = time.time()
    valid_results = [r for r in results if not isinstance(r, Exception)]

    if not valid_results:
        return 0, 0, 0

    # Try batch reporting first (1s timeout)
    try:
        batch_success = await asyncio.wait_for(report_batch_results(valid_results), timeout=1.0)
        if batch_success:
            elapsed = time.time() - start_time
            success_count = sum(1 for r in valid_results if r.get("success"))
            return success_count, len(valid_results) - success_count, elapsed
    except asyncio.TimeoutError:
        print(f"  ⚠ Batch report timeout (1s)")
    except Exception as e:
        print(f"  ⚠ Batch report failed: {e}")

    # Fallback: UNLIMITED parallel reports with 1s timeout each
    async def report_one(result: dict) -> bool:
        try:
            await asyncio.wait_for(report_result("send", result), timeout=1.0)
            return result.get("success", False)
        except asyncio.TimeoutError:
            return False
        except:
            return False

    report_results = await asyncio.gather(
        *[report_one(r) for r in valid_results],
        return_exceptions=True
    )

    elapsed = time.time() - start_time
    success_count = sum(1 for r in report_results if r is True)
    return success_count, len(valid_results) - success_count, elapsed


async def main_loop():
    """Main campaign loop - Admin-controlled speed via dashboard settings"""
    global RUNNING

    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Admin-Controlled Speed)")
    print(f"  BUILD: {BUILD_VERSION}")
    print("=" * 60)
    print("  📊 Speed controlled via Admin Dashboard:")
    print("     - staggerMin/staggerMax = 0 → Ultra-fast (instant)")
    print("     - staggerMin/staggerMax > 0 → Controlled delay")
    print("     - batchSize = 0 → Unlimited batch size")
    print("  🔄 Proxy auto-switch on timeout")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("=" * 60)
    print("\n✓ Starting campaign runner...\n")

    consecutive_empty = 0

    while RUNNING:
        try:
            batch_start = time.time()
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            fetch_time = time.time() - batch_start

            # Get speed settings from server (admin dashboard controls these)
            delay_after = batch_result.get("delay_after", DEFAULT_POLL_INTERVAL)
            stagger_min = batch_result.get("stagger_min", 0)
            stagger_max = batch_result.get("stagger_max", 0)
            more_pending = batch_result.get("more_pending", False)

            if batch_result.get("stop_signal"):
                reason = batch_result.get("reason", "Campaign paused")
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print(f"  ⏸️  {reason} — waiting...")
                elif consecutive_empty % 20 == 0:
                    print("  ⏸️  Still waiting...")
                await asyncio.sleep(delay_after if delay_after > 0 else DEFAULT_POLL_INTERVAL)
                continue

            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print(f"  ⏳ {batch_result.get('reason', 'No tasks')}")
                elif consecutive_empty % 10 == 0:
                    print("  ⏳ Still waiting...")
                await asyncio.sleep(delay_after if delay_after > 0 else DEFAULT_POLL_INTERVAL)
                continue

            consecutive_empty = 0
            
            # Show current speed mode
            if stagger_max == 0:
                speed_mode = "ULTRA-FAST (zero stagger)"
            else:
                speed_mode = f"stagger {stagger_min:.1f}-{stagger_max:.1f}s"
            
            print(f"\n  📦 Processing {len(tasks)} messages [{speed_mode}]...")
            print(f"     [fetch: {fetch_time:.2f}s]")

            connect_start = time.time()
            await pre_connect_batch(tasks)
            connect_time = time.time() - connect_start
            print(f"     [connect: {connect_time:.2f}s]")

            # Execute ALL tasks in parallel with admin-controlled stagger
            send_start = time.time()
            results = await asyncio.gather(
                *[process_single_task(task, stagger_min, stagger_max) for task in tasks],
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

    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Campaign Runner - Admin-Controlled Speed")
    print("  Speed & batch settings from admin dashboard")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print("Required: pip install telethon httpx pysocks")

    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\n⏹ Keyboard interrupt - stopping...")
            break
        except Exception as e:
            print(f"\n⚠ Runner crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)

    print("Goodbye!")
`;

  // ========== 5. LIVECHAT_RUNNER.PY ==========
  const livechatRunnerPy = `#!/usr/bin/env python3
"""
LiveChat Runner - Handles incoming messages and live chat replies
RUNS FOREVER with crash recovery, memory cleanup, and heartbeat logging

BUILD: 2026-01-09-optimized-filtering

Features:
- EARLY FILTERING: Only processes messages from known campaign recipients
- Uses fingerprint from DB if exists, generates new if not
- On proxy failure, switches to a different random proxy (no retry same proxy)
- Detects network/wifi disconnect and skips account updates
"""
import asyncio
import signal
import base64
import time
import gc
import random

import httpx
from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client
)
from fingerprint_generator import generate_fingerprint
from config import SUPABASE_URL, SUPABASE_KEY
from urllib.parse import urlparse

# Ensure we always get the *origin* (e.g. https://xxxx.supabase.co)
_u = urlparse(SUPABASE_URL)
SUPABASE_URL_BASE = f"{_u.scheme}://{_u.netloc}" if _u.scheme and _u.netloc else SUPABASE_URL.rstrip("/")

RUNNING = True
CLEANUP_INTERVAL = 180  # 3 minutes - faster cleanup
HEARTBEAT_INTERVAL = 30  # 30 seconds - more frequent status
CONNECT_TIMEOUT_SECONDS = 25  # Faster parallel connect timeout
RECIPIENT_REFRESH_INTERVAL = 60  # Refresh known recipients every 60 seconds

# ========== EARLY FILTERING: Contacts only ==========
# Only process messages from users who are in the account's contact list
# This is simple and efficient - no server-side lookups needed

# Network error detection - these indicate LOCAL network issues, not account problems
NETWORK_ERROR_PATTERNS = [
    "temporary failure in name resolution",
    "network is unreachable", 
    "no route to host",
    "connection refused",
    "connection reset by peer",
    "name or service not known",
    "could not connect",
    "timed out",
    "timeout",
    "cannot connect",
    "connection timed out",
    "connecterror",
    "network error",
    "socket error",
    "dns lookup failed",
    "errno 11001",  # Windows DNS error
    "errno 110",    # Connection timed out
    "errno 111",    # Connection refused
    "errno 113",    # No route to host
    "oserror",
    "gaierror",
]


def is_network_error(error_str: str) -> bool:
    """Check if error is a LOCAL network/wifi issue (not account problem)"""
    if not error_str:
        return False
    error_lower = error_str.lower()
    return any(p in error_lower for p in NETWORK_ERROR_PATTERNS)


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def fetch_random_proxy(exclude_proxy_id: str = None):
    """Fetch a random active proxy from database, excluding the failed one"""
    try:
        http = get_http_client()
        response = await http.get(
            f"{SUPABASE_URL_BASE}/rest/v1/proxies",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            params={
                "status": "eq.active",
                "select": "id,host,port,username,password,proxy_type"
            }
        )
        if response.status_code == 200:
            proxies = response.json()
            if exclude_proxy_id:
                proxies = [p for p in proxies if p.get("id") != exclude_proxy_id]
            if proxies:
                return random.choice(proxies)
        return None
    except Exception as e:
        print(f"  [WARN] Could not fetch proxy: {e}")
        return None


async def switch_account_proxy_via_edge(account_id: str, old_proxy_id: str = None):
    """Switch account's proxy using edge function for consistent DB updates.
    
    This ensures both telegram_accounts.proxy_id AND proxies.assigned_account_id are updated.
    Returns new proxy dict or None.
    """
    try:
        http = get_http_client()
        response = await http.post(
            f"{SUPABASE_URL_BASE}/functions/v1/switch-account-proxy",
            headers={
                "apikey": SUPABASE_KEY, 
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json"
            },
            json={"account_id": account_id, "old_proxy_id": old_proxy_id},
            timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            if data.get("success"):
                return data.get("new_proxy")
        return None
    except Exception as e:
        print(f"  [WARN] Could not switch proxy: {e}")
        return None


async def fetch_random_proxy_excluding(excluded_proxy_ids: list = None):
    """Fetch a random active proxy, excluding multiple failed ones"""
    try:
        http = get_http_client()
        response = await http.get(
            f"{SUPABASE_URL_BASE}/rest/v1/proxies",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            params={
                "status": "eq.active",
                "select": "id,host,port,username,password,proxy_type"
            }
        )
        if response.status_code == 200:
            proxies = response.json()
            if excluded_proxy_ids:
                proxies = [p for p in proxies if p.get("id") not in excluded_proxy_ids]
            if proxies:
                return random.choice(proxies)
        return None
    except Exception as e:
        print(f"  [WARN] Could not fetch proxy: {e}")
        return None


async def connect_account_with_fingerprint(account: dict, setup_handler=None) -> tuple:
    """
    Connect account with smart fingerprint and proxy handling.
    
    1. Check if account has fingerprint in DB, use it
    2. If no fingerprint, generate new and save to DB
    3. If proxy fails, IMMEDIATELY try 2 different random proxies (NO cooldown)
    4. Detect network errors and skip account status updates
    5. NEVER mark account as disconnected due to proxy issues
    
    Returns: (client, error_str or None)
    """
    account_id = account.get("id")
    phone = account.get("phone_number", "???")[-4:]
    
    # Check fingerprint from database
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version")
    lang_code = account.get("lang_code")
    system_lang_code = account.get("system_lang_code")
    
    fingerprint_exists = bool(device_model and system_version)
    
    # If no fingerprint in DB, generate new one
    if not fingerprint_exists:
        print(f"  [{phone}] No fingerprint in DB, generating new...")
        fp = generate_fingerprint()
        account["device_model"] = fp["device_model"]
        account["system_version"] = fp["system_version"]
        account["app_version"] = fp["app_version"]
        account["lang_code"] = fp["lang_code"]
        account["system_lang_code"] = fp["system_lang_code"]
        
        # Save fingerprint to database
        await report_result("fingerprint_generated", {
            "account_id": account_id,
            "device_model": fp["device_model"],
            "system_version": fp["system_version"],
            "app_version": fp["app_version"],
            "lang_code": fp["lang_code"],
            "system_lang_code": fp["system_lang_code"]
        })
        print(f"  [{phone}] Saved fingerprint: {fp['device_model']} ({fp['system_version']})")
    else:
        print(f"  [{phone}] Using DB fingerprint: {device_model} ({system_version})")
    
    # Get current proxy
    proxy = account.get("proxy")
    current_proxy_id = proxy.get("id") if proxy else None
    excluded_proxies = []
    
    # Try up to 3 times: current proxy + 2 different random proxies
    MAX_PROXY_ATTEMPTS = 3
    
    for attempt in range(MAX_PROXY_ATTEMPTS):
        try:
            client = await get_or_create_client(account, setup_handler=setup_handler, task_proxy=account.get("proxy"))
            if client:
                return client, None
        except Exception as e:
            error_str = str(e)
            
            # Check if this is a LOCAL network error (wifi disconnect)
            if is_network_error(error_str):
                print(f"  [{phone}] NETWORK ERROR (wifi/internet issue): {error_str[:50]}")
                return None, f"NETWORK_ERROR:{error_str}"
        
        # Connection failed - try different proxy if we have more attempts
        if attempt < MAX_PROXY_ATTEMPTS - 1:
            current_proxy_id = account.get("proxy", {}).get("id") if account.get("proxy") else None
            if current_proxy_id:
                excluded_proxies.append(current_proxy_id)
            
            print(f"  [{phone}] Proxy failed, trying different proxy (attempt {attempt + 2}/{MAX_PROXY_ATTEMPTS})...")
            
            # Use edge function for consistent proxy switching (updates both tables)
            new_proxy = await switch_account_proxy_via_edge(account_id, current_proxy_id)
            
            if new_proxy:
                account["proxy"] = new_proxy
                if new_proxy.get("id"):
                    excluded_proxies.append(new_proxy.get("id"))
                print(f"  [{phone}] Switched to: {new_proxy['host']}:{new_proxy['port']}")
            else:
                print(f"  [{phone}] No more proxies available to try")
                break
    
    # All attempts failed - but DON'T mark account as disconnected
    return None, "All proxies failed"


async def check_conversation_exists(account_id: str, sender_id: int, sender_username: str = None, sender_phone: str = None) -> bool:
    """Multi-strategy matching: telegram_id -> username -> phone"""
    import re
    try:
        http = get_http_client()
        
        # Strategy 1: Match by telegram_id
        response = await http.get(
            f"{SUPABASE_URL_BASE}/rest/v1/conversations",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            params={
                "account_id": f"eq.{account_id}",
                "recipient_telegram_id": f"eq.{sender_id}",
                "first_message_sent": "eq.true",
                "select": "id"
            }
        )
        if response.status_code == 200 and response.json():
            return True
        
        # Strategy 2: Match by username
        if sender_username:
            username_clean = sender_username.lstrip("@").lower()
            for variant in [f"@{username_clean}", username_clean]:
                response = await http.get(
                    f"{SUPABASE_URL_BASE}/rest/v1/conversations",
                    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
                    params={
                        "account_id": f"eq.{account_id}",
                        "recipient_username": f"ilike.{variant}",
                        "first_message_sent": "eq.true",
                        "select": "id"
                    }
                )
                if response.status_code == 200 and response.json():
                    return True
        
        # Strategy 3: Match by phone
        if sender_phone:
            digits = re.sub(r'\\D', '', sender_phone)
            for pv in [f"+{digits}", digits, sender_phone]:
                response = await http.get(
                    f"{SUPABASE_URL_BASE}/rest/v1/conversations",
                    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
                    params={
                        "account_id": f"eq.{account_id}",
                        "recipient_phone": f"eq.{pv}",
                        "first_message_sent": "eq.true",
                        "select": "id"
                    }
                )
                if response.status_code == 200 and response.json():
                    return True
        
        return False
    except Exception as e:
        # Check if this is a network error
        if is_network_error(str(e)):
            print(f"    [WARN] Network error checking conversation (wifi issue?)")
            return False
        print(f"    [WARN] Check conversation error: {e}")
        return False


async def setup_message_handler(client, account_id: str):
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if not sender:
                return
            
            from telethon.tl.types import User
            if not isinstance(sender, User):
                return
            if getattr(sender, 'bot', False):
                return
            
            # Get sender info for matching
            sender_username = getattr(sender, 'username', None)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
            
            # ========== EARLY FILTER: Contacts only ==========
            # Only accept messages from users in account's contact list
            is_contact = getattr(sender, 'contact', False)
            if not is_contact:
                return
            
            content = event.message.text or "[Media]"
            media_url = None
            media_type = None
            
            if event.message.photo:
                print(f"    [PHOTO] Receiving...")
                content = "[Photo] " + (event.message.text or "")
                media_type = "image"
                try:
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        
                        mime_type = "image/jpeg"
                        if hasattr(event.message, 'file') and event.message.file:
                            mime_type = getattr(event.message.file, 'mime_type', None) or "image/jpeg"
                        
                        http = get_http_client()
                        upload_response = await http.put(
                            f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{file_path}",
                            headers={
                                "apikey": SUPABASE_KEY,
                                "Authorization": f"Bearer {SUPABASE_KEY}",
                                "Content-Type": mime_type,
                                "x-upsert": "true"
                            },
                            content=photo_bytes
                        )
                        if upload_response.status_code in (200, 201):
                            media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{file_path}"
                            print(f"    [OK] Photo uploaded: {file_name}")
                        else:
                            error_text = upload_response.text[:300] if upload_response.text else "No details"
                            print(f"    [WARN] Photo upload failed: {upload_response.status_code} - {error_text}")
                except Exception as e:
                    if not is_network_error(str(e)):
                        print(f"    [WARN] Could not upload photo: {e}")
            
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
            except:
                pass
            
            print(f"  [IN] From {sender_name}: {content[:40]}...")
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": sender_name,
                "sender_username": sender_username,
                "sender_phone": sender_phone,
                "sender_avatar": avatar_base64,
                "content": content,
                "media_url": media_url,
                "media_type": media_type
            })
        except Exception as e:
            if not is_network_error(str(e)):
                print(f"  [WARN] Handler error: {e}")


async def keep_clients_alive():
    """Background task that keeps all clients receiving updates - ULTRA FAST"""
    while RUNNING:
        # Ultra-fast loop for instant message reception
        await asyncio.sleep(0.02)  # 50 checks per second
        # Process updates for all connected clients
        for acc_id, client in list(active_clients.items()):
            try:
                if client.is_connected():
                    # This processes pending updates without blocking
                    await client.catch_up()
            except Exception:
                pass


async def main_loop():
    print("=" * 50)
    print("  LiveChat Runner (ULTRA FAST)")
    print("  BUILD: 2026-01-08-v3-optimized")
    print("  [Incoming + Replies]")
    print("  ⚡ Optimized for speed - no delays")
    print("  🔄 Instant proxy switch on failure")
    print("  📨 50 update checks per second")
    print("=" * 50)
    
    connected_ids = set()  # Track connected accounts to avoid redundant work
    failed_proxy_accounts = {}  # Track accounts that failed due to proxy {account_id: retry_time}
    last_cleanup = time.time()
    last_heartbeat = time.time()
    iteration_count = 0
    
    # Start background task to keep clients catching updates
    asyncio.create_task(keep_clients_alive())
    
    while RUNNING:
        try:
            iteration_count += 1
            
            # Heartbeat logging
            if time.time() - last_heartbeat > HEARTBEAT_INTERVAL:
                print(f"  [HEARTBEAT] Iteration {iteration_count}, Connected: {len(connected_ids)}, Active: {len(active_clients)}")
                last_heartbeat = time.time()
            
            # Periodic cleanup - sync connected_ids with actual clients
            if time.time() - last_cleanup > CLEANUP_INTERVAL:
                # Remove stale IDs from connected_ids
                stale_ids = [acc_id for acc_id in connected_ids if acc_id not in active_clients]
                for acc_id in stale_ids:
                    connected_ids.discard(acc_id)
                
                if stale_ids:
                    print(f"  [CLEANUP] Removed {len(stale_ids)} stale IDs from connected_ids")
                
                # Allow failed proxy accounts to retry after 5 minutes
                now = time.time()
                expired_failures = [acc_id for acc_id, retry_time in failed_proxy_accounts.items() if now > retry_time]
                for acc_id in expired_failures:
                    del failed_proxy_accounts[acc_id]
                    connected_ids.discard(acc_id)  # Allow re-connection attempt
                
                if expired_failures:
                    print(f"  [CLEANUP] Allowing {len(expired_failures)} proxy-failed accounts to retry")
                
                # Clean up disconnected clients
                await cleanup_stale_clients()
                gc.collect()
                last_cleanup = time.time()
            
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                # Only connect NEW accounts (skip already connected and recently failed)
                new_accounts = [
                    acc for acc in accounts 
                    if acc.get("id") not in connected_ids 
                    and acc.get("id") not in failed_proxy_accounts
                ]
                
                if new_accounts:
                    print(f"  [CONNECT] Connecting {len(new_accounts)} accounts in PARALLEL...")
                    
                    async def connect_one(acc):
                        acc_id = acc.get("id")
                        if not acc_id:
                            return None, None, "No ID"
                        try:
                            client, error = await asyncio.wait_for(
                                connect_account_with_fingerprint(acc, setup_handler=setup_message_handler),
                                timeout=CONNECT_TIMEOUT_SECONDS
                            )
                            return acc_id, client, error
                        except asyncio.TimeoutError:
                            return acc_id, None, "TIMEOUT"
                        except Exception as e:
                            return acc_id, None, f"ERROR:{e}"
                    
                    results = await asyncio.gather(
                        *[connect_one(acc) for acc in new_accounts],
                        return_exceptions=True
                    )
                    
                    # Process results
                    success_count = 0
                    timeout_count = 0
                    error_count = 0
                    for result in results:
                        if isinstance(result, Exception):
                            error_count += 1
                            continue
                        acc_id, client, error = result
                        if not acc_id:
                            continue
                        if client:
                            connected_ids.add(acc_id)
                            success_count += 1
                        elif error:
                            if error.startswith("NETWORK_ERROR:"):
                                pass  # Will retry next iteration
                            elif error == "TIMEOUT" or error == "All proxies failed":
                                timeout_count += 1
                                # NO cooldown - will retry next iteration with different proxy
                            else:
                                error_count += 1
                                # NO cooldown - keep trying
                    
                    print(f"  [CONNECTED] {success_count}/{len(new_accounts)} accounts (timeouts={timeout_count}, errors={error_count})")

                # Get delay from server response (usually 0 for fast polling)
                wait_seconds = task.get("seconds", 0.5)
                if wait_seconds > 0:
                    # Use small sleeps to allow update processing
                    for _ in range(int(wait_seconds * 10)):
                        if not RUNNING:
                            break
                        await asyncio.sleep(0.1)
                else:
                    # Even with 0 delay, yield briefly for updates
                    await asyncio.sleep(0.05)
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                
                client, error = await connect_account_with_fingerprint(account, setup_handler=setup_message_handler)
                
                if client and recipient:
                    print(f"  [REPLY] To {recipient}...")
                    success, send_error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    
                    # Only report if not a network error
                    if not is_network_error(str(send_error)):
                        await report_result("send", {
                            "message_id": msg.get("id"),
                            "success": success,
                            "error": send_error,
                            "account_id": account.get("id")
                        })
                    else:
                        print(f"  [SKIP REPORT] Network error, not updating status")
                elif error and not error.startswith("NETWORK_ERROR:"):
                    # Only report failure if not a network error
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": False,
                        "error": error,
                        "account_id": account.get("id")
                    })
        
        except Exception as e:
            # Check if this is a network error
            if is_network_error(str(e)):
                print(f"  [NETWORK] Wifi/internet issue: {str(e)[:50]}")
                await asyncio.sleep(5)  # Wait longer for network recovery
            else:
                print(f"  [ERROR] {e}")
                await asyncio.sleep(0.5)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    
    while True:  # FOREVER LOOP WITH CRASH RECOVERY
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Stopping...")
            break
        except Exception as e:
            # Check if network error
            if is_network_error(str(e)):
                print(f"\\n📶 Network error (wifi issue?): {e}")
                print("  Waiting 10 seconds for network recovery...")
                time.sleep(10)
            else:
                print(f"\\n⚠ LiveChat crashed: {e}")
                print("  Restarting in 5 seconds...")
                time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== 6. ACCOUNT_RUNNER.PY ==========
  const accountRunnerPy = `#!/usr/bin/env python3
"""
Account Runner - Handles SpamBot, name, photo, privacy, password, contact import
"""
import asyncio
import signal
import os
import base64
import httpx

from client_manager import (
    get_or_create_client, report_result, shutdown_all, disconnect_client,
    validate_contact, SESSION_FOLDER, SUPABASE_KEY, BACKEND_URL, active_clients
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_spambot(client):
    """Check SpamBot - detects banned, restricted"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        response_lower = response.lower()
        
        # BANNED state  
        if "banned" in response_lower or "deleted" in response_lower or "заблокирован" in response_lower:
            return "banned", response[:200], response
        # LIMITED state (including frozen)
        if "limited" in response_lower or "restricted" in response_lower or "ограничен" in response_lower or "frozen" in response_lower or "заморожен" in response_lower:
            return "restricted", "Limited", response
        # CLEAN state
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
        return "active", None, response
    except Exception as e:
        error_str = str(e).lower()
        if "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), f"Error: {e}"
        if "auth" in error_str or "session" in error_str:
            return "disconnected", str(e), f"Error: {e}"
        return "active", None, f"Error: {e}"


async def change_name(client, first_name: str, last_name: str = ""):
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_source: str):
    """Change profile photo - accepts base64 or URL"""
    try:
        from telethon.tl.functions.photos import UploadProfilePhotoRequest
        import aiohttp
        
        temp_path = os.path.join(SESSION_FOLDER, "temp_photo.jpg")
        
        # Check if it's a URL or base64
        if photo_source.startswith("http://") or photo_source.startswith("https://"):
            # Download from URL
            async with aiohttp.ClientSession() as session:
                async with session.get(photo_source) as resp:
                    if resp.status == 200:
                        photo_bytes = await resp.read()
                        with open(temp_path, "wb") as f:
                            f.write(photo_bytes)
                    else:
                        return False, f"Failed to download image: HTTP {resp.status}"
        else:
            # Assume base64
            photo_bytes = base64.b64decode(photo_source)
            with open(temp_path, "wb") as f:
                f.write(photo_bytes)
        
        file = await client.upload_file(temp_path)
        await client(UploadProfilePhotoRequest(file=file))
        os.remove(temp_path)
        return True, None
    except Exception as e:
        return False, str(e)


async def update_privacy(client, hide_phone, hide_last_seen, disable_calls):
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


async def change_password(client, existing_pwd, new_pwd):
    try:
        from telethon.tl.functions.account import UpdatePasswordSettingsRequest, GetPasswordRequest
        from telethon.password import compute_check
        pwd = await client(GetPasswordRequest())
        check = compute_check(pwd, existing_pwd) if pwd.has_password and existing_pwd else None
        from telethon.tl.types.account import PasswordInputSettings
        new_settings = PasswordInputSettings(new_algo=pwd.new_algo, new_password_hash=new_pwd.encode())
        await client(UpdatePasswordSettingsRequest(password=check, new_settings=new_settings))
        return True, None
    except Exception as e:
        return False, str(e)


async def logout_other_sessions(client):
    try:
        from telethon.tl.functions.auth import ResetAuthorizationsRequest
        await client(ResetAuthorizationsRequest())
        return True, None
    except Exception as e:
        return False, str(e)


async def verify_session(client, account_id):
    """Verify if session is active by checking get_me()"""
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if me:
            return "active", None, {
                "telegram_id": me.id,
                "username": me.username,
                "first_name": me.first_name,
                "last_name": me.last_name
            }
        return "disconnected", "Could not get user info", None
    except asyncio.TimeoutError:
        return "disconnected", "Connection timeout", None
    except Exception as e:
        error_str = str(e).lower()
        if "auth" in error_str or "session" in error_str or "revoked" in error_str:
            return "disconnected", str(e), None
        elif "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), None
        return "disconnected", str(e), None


async def process_single_task(task):
    """Process a single account task - runs in parallel with others.
    IMPORTANT: Disconnects client after each task to free session file for LiveChat runner.
    """
    task_type = task.get("task")
    account = task.get("account", {})
    task_id = task.get("task_id")
    task_data = task.get("task_data", {})
    task_proxy = task.get("proxy")  # Get proxy from task (sent by get-batch-tasks)
    account_id = account.get("id")
    phone = account.get("phone_number", "")
    
    try:
        if task_type == "spambot_check":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [SPAM] Checking {phone}...")
                status, ban_reason, response = await check_spambot(client)
                await report_result("spambot_check", {"task_id": task_id, "account_id": account_id, "status": status, "ban_reason": ban_reason, "response": response})
                print(f"    Result: {status}")
        
        elif task_type == "change_name":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [NAME] Changing for {phone}...")
                success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                await report_result("change_name", {"task_id": task_id, "account_id": account_id, "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
        
        elif task_type == "change_photo":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [PHOTO] Changing for {phone}...")
                photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
                success, error = await change_profile_photo(client, photo_source)
                await report_result("change_photo", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "privacy_settings":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [PRIVACY] Updating for {phone}...")
                success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                await report_result("privacy_settings", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "change_password":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [PASS] Changing for {phone}...")
                success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                await report_result("change_password", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "logout_sessions":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [LOGOUT] Logging out other sessions for {phone}...")
                success, error = await logout_other_sessions(client)
                await report_result("logout_sessions", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "verify_session":
            print(f"  [VERIFY] Checking {phone}...")
            try:
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    status, error, user_data = await verify_session(client, account_id)
                    await report_result("verify_session", {"task_id": task_id, "account_id": account_id, "status": status, "error": error, "user_data": user_data})
                    print(f"    Status: {status}" + (f" ({error})" if error else ""))
                else:
                    await report_result("verify_session", {"task_id": task_id, "account_id": account_id, "status": "disconnected", "error": "Could not connect"})
            except Exception as e:
                await report_result("verify_session", {"task_id": task_id, "account_id": account_id, "status": "disconnected", "error": str(e)})
        
        elif task_type == "sync_profile":
            print(f"  [SYNC] Syncing profile for {phone}...")
            try:
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    me = await client.get_me()
                    if me:
                        avatar_url = None
                        try:
                            photos = await client.get_profile_photos("me", limit=1)
                            if photos:
                                photo_bytes = await client.download_media(photos[0], bytes)
                                if photo_bytes:
                                    avatar_url = f"data:image/jpeg;base64,{base64.b64encode(photo_bytes).decode()}"
                        except:
                            pass
                        
                        await report_result("sync_profile", {
                            "task_id": task_id,
                            "account_id": account_id,
                            "success": True,
                            "first_name": me.first_name,
                            "last_name": me.last_name or "",
                            "username": me.username,
                            "telegram_id": me.id,
                            "avatar_url": avatar_url
                        })
                        print(f"    Synced: {me.first_name} {me.last_name or ''}")
                    else:
                        await report_result("sync_profile", {"task_id": task_id, "account_id": account_id, "success": False, "error": "Could not get user info"})
                else:
                    await report_result("sync_profile", {"task_id": task_id, "account_id": account_id, "success": False, "error": "Could not connect"})
            except Exception as e:
                await report_result("sync_profile", {"task_id": task_id, "account_id": account_id, "success": False, "error": str(e)})
                print(f"    Error: {e}")
    
    except Exception as e:
        # CRITICAL: Report failure to backend so task doesn't stay stuck in "in_progress"
        print(f"  [ERROR] Task {task_type} failed: {e}")
        await report_task_failure(task_type, task_id, account_id, str(e))
    
    finally:
        # ALWAYS disconnect after task to free session file for LiveChat runner
        if account_id:
            await disconnect_client(account_id, phone)


TASK_TIMEOUT_SECONDS = 120


async def report_task_failure(task_type: str, task_id: str, account_id: str, error_message: str):
    """Report a failure in a shape that the backend understands for each task type."""
    try:
        if task_type == "spambot_check":
            await report_result("spambot_check", {
                "task_id": task_id,
                "account_id": account_id,
                "status": "disconnected",
                "ban_reason": error_message,
                "response": f"Error: {error_message}",
            })
        elif task_type == "verify_session":
            await report_result("verify_session", {
                "task_id": task_id,
                "account_id": account_id,
                "status": "disconnected",
                "error": error_message,
                "user_data": None,
            })
        else:
            await report_result(task_type, {
                "task_id": task_id,
                "account_id": account_id,
                "success": False,
                "error": error_message,
            })
    except Exception as e:
        print(f"  [ERROR] Failed to report task failure: {type(e).__name__}: {repr(e)}")


async def run_task_with_timeout(task: dict):
    """Prevent one hanging Telegram call from stopping polling forever."""
    task_type = task.get("task")
    task_id = task.get("task_id")
    account = task.get("account", {})
    account_id = account.get("id")
    phone = account.get("phone_number")

    try:
        await asyncio.wait_for(process_single_task(task), timeout=TASK_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        msg = f"Timeout after {TASK_TIMEOUT_SECONDS}s"
        print(f"  [TIMEOUT] {task_type} for {phone}: {msg}")
        await report_task_failure(task_type, task_id, account_id, msg)
    except Exception as e:
        # process_single_task already reports most errors; this is a safety net.
        await report_task_failure(task_type, task_id, account_id, str(e))


_http_client = None

async def get_http_client():
    """Reuse a single HTTP client to avoid socket/resource leaks on some systems."""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=120.0)
    return _http_client


async def get_batch_tasks(runner="account", batch_size=20):
    """Get a batch of tasks for parallel processing"""
    try:
        client = await get_http_client()
        resp = await client.post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"runner": runner, "batch_size": batch_size},
            timeout=120.0,
        )

        if resp.status_code != 200:
            print(f"[HTTP ERROR] get_batch_tasks: status={resp.status_code} body={resp.text[:200]}")
            return {"tasks": [], "delay_after": 5}

        return resp.json()
    except Exception as e:
        print(f"[HTTP ERROR] get_batch_tasks: {type(e).__name__}: {repr(e)}")
        return {"tasks": [], "delay_after": 5}


async def send_heartbeat():
    """Send heartbeat to register this runner.
    Note: get-batch-tasks already records a heartbeat, so this is a backup 
    for when we're idle. Use a longer timeout to reduce noise.
    """
    try:
        client = await get_http_client()
        await client.post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"runner": "account", "batch_size": 0},  # batch_size=0 = heartbeat only
            timeout=15.0,
        )
    except Exception:
        pass  # Heartbeat failure is not critical - suppress to reduce log noise


async def main_loop():
    print("=" * 50)
    print("  Account Runner (PARALLEL MODE)")
    print("  [SpamBot, Name, Photo, Privacy, Sync Profile]")
    print("  Polling every 15 seconds for new tasks...")
    print("=" * 50)
    
    last_heartbeat = 0
    poll_count = 0
    
    while RUNNING:
        try:
            poll_count += 1
            
            # Send heartbeat every 10 seconds
            now = asyncio.get_event_loop().time()
            if now - last_heartbeat > 10:
                asyncio.create_task(send_heartbeat())
                last_heartbeat = now
            
            # Get batch of tasks from edge function
            print(f"\\n[POLL #{poll_count}] Checking for account tasks...")
            batch = await get_batch_tasks(runner="account", batch_size=20)
            tasks = batch.get("tasks", [])
            delay_after = batch.get("delay_after", 15)  # Default 15s for account runner
            reason = batch.get("reason", "")
            
            if tasks:
                print(f"[BATCH] Found {len(tasks)} tasks! Processing in parallel...")
                
                # Process all tasks in parallel (with timeout safety)
                await asyncio.gather(*[run_task_with_timeout(task) for task in tasks], return_exceptions=True)
                
                print(f"[DONE] Completed {len(tasks)} tasks")
                # Quick re-poll to check for more tasks
                await asyncio.sleep(1)
            else:
                # No tasks - wait and poll again
                print(f"[WAIT] No tasks found. Waiting {delay_after} seconds..." + (f" ({reason})" if reason else ""))
                await asyncio.sleep(delay_after)
        
        except Exception as e:
            print(f"[ERROR] {e}")
            await asyncio.sleep(5)
    
    # Close shared HTTP client (prevents hangs after many polls on some systems)
    global _http_client
    try:
        if _http_client is not None:
            await _http_client.aclose()
            _http_client = None
    except:
        pass

    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx aiohttp\\n")
    
    while True:  # FOREVER LOOP WITH CRASH RECOVERY
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Stopping...")
            break
        except Exception as e:
            print(f"\\n⚠ Account Manager crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== 7. WARMUP_RUNNER.PY (BATCH MODE) ==========
  const warmupRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner (PARALLEL BATCH MODE)
===================================================
Handles warmup tasks with PARALLEL execution.
Polls server every 7 seconds. RUNS FOREVER with auto-restart.

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result, shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 7  # Poll server every 7 seconds
WARMUP_CHANNELS = ["telegram", "durov", "tginfo", "techcrunch"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😂", "🎉", "💯", "⭐"]


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def add_contact(client, phone, first_name, last_name=""):
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        contact = InputPhoneContact(client_id=0, phone=phone, first_name=first_name, last_name=last_name)
        result = await client(ImportContactsRequest([contact]))
        if result.imported:
            return True, phone, None
        return True, phone, "Contact exists or invalid"
    except Exception as e:
        return False, phone, str(e)


async def send_warmup_chat(client, recipient_phone, message, recipient_telegram_id=None, recipient_username=None, recipient_first_name=None):
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        
        user = None
        if recipient_telegram_id:
            try:
                user = await client.get_entity(recipient_telegram_id)
            except:
                pass
        if not user and recipient_username:
            try:
                user = await client.get_entity(recipient_username)
            except:
                pass
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
        total_typing_time = min(base_delay + typing_delay, 15)
        
        async with client.action(user, 'typing'):
            await asyncio.sleep(total_typing_time)
        
        await client.send_message(user, message)
        await asyncio.sleep(random.uniform(0.5, 2))
        
        return True, None
    except Exception as e:
        return False, str(e)


async def join_channel(client, channel_username=None):
    try:
        from telethon.tl.functions.channels import JoinChannelRequest
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel_username)
        await client(JoinChannelRequest(entity))
        return True, channel_username, None
    except Exception as e:
        return False, channel_username, str(e)


async def view_channel_messages(client, channel_username=None):
    try:
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel_username)
        messages = await client.get_messages(entity, limit=10)
        if messages:
            await client.send_read_acknowledge(entity, messages[-1])
        return True, len(messages), None
    except Exception as e:
        return False, 0, str(e)


async def send_reaction(client, channel_username=None):
    try:
        from telethon.tl.functions.messages import SendReactionRequest
        from telethon.tl.types import ReactionEmoji
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel_username)
        messages = await client.get_messages(entity, limit=5)
        if messages:
            msg = random.choice(messages)
            reaction = random.choice(REACTIONS)
            await client(SendReactionRequest(peer=entity, msg_id=msg.id, reaction=[ReactionEmoji(emoticon=reaction)]))
            return True, reaction, None
    except Exception as e:
        return False, None, str(e)
    return False, None, "No messages"


async def update_profile_bio(client, bio=None):
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        if not bio:
            bios = ["🚀", "✨", "💫", "🌟", "⚡", "🔥", "💪", "🎯"]
            bio = random.choice(bios)
        await client(UpdateProfileRequest(about=bio))
        return True, None
    except Exception as e:
        return False, str(e)


async def process_single_warmup_task(task: dict) -> dict:
    """Process a single warmup task - fully isolated"""
    task_type = task.get("task_type") or task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    proxy = task.get("proxy")
    
    account_id = account.get("id")
    phone = account.get("phone_number", "????")[-4:]
    
    if not account_id:
        return {"success": False, "error": "No account", "task_id": task_id}
    
    try:
        client = await get_or_create_client(account, task_proxy=proxy)
        if not client:
            return {
                "success": False, "error": "Could not connect client",
                "task_id": task_id, "account_id": account_id, "pair_id": pair_id
            }
        
        await asyncio.sleep(random.uniform(0.5, 2))
        
        if task_type == "warmup_add_contact":
            target_phone = task_data.get("phone") or task_data.get("recipient_phone")
            first_name = task_data.get("first_name", "Friend")
            print(f"  [CONTACT] [{phone}] Adding contact...")
            success, added_phone, error = await add_contact(client, target_phone, first_name)
            return {"task_id": task_id, "pair_id": pair_id, "account_id": account_id, "success": success, "error": error, "task_subtype": "add_contact"}
        
        elif task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            recipient_telegram_id = task_data.get("recipient_telegram_id")
            recipient_username = task_data.get("recipient_username")
            recipient_first_name = task_data.get("first_name")
            message = task_data.get("message", "Hey! 👋")
            print(f"  [CHAT] [{phone}] Sending warmup message...")
            success, error = await send_warmup_chat(client, recipient_phone, message, recipient_telegram_id, recipient_username, recipient_first_name)
            return {"task_id": task_id, "pair_id": pair_id, "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_join_channel":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [JOIN] [{phone}] Joining channel...")
            success, channel_name, error = await join_channel(client, channel)
            return {"task_id": task_id, "task_type": "join_channel", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_view_content":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [VIEW] [{phone}] Viewing content...")
            success, count, error = await view_channel_messages(client, channel)
            return {"task_id": task_id, "task_type": "view_content", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_send_reaction":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [REACT] [{phone}] Sending reaction...")
            success, reaction, error = await send_reaction(client, channel)
            return {"task_id": task_id, "task_type": "send_reaction", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_profile_update":
            bio = task_data.get("bio")
            print(f"  [BIO] [{phone}] Updating bio...")
            success, error = await update_profile_bio(client, bio)
            return {"task_id": task_id, "task_type": "profile_update", "account_id": account_id, "success": success, "error": error}
        
        else:
            print(f"  [?] [{phone}] Unknown task type: {task_type}")
            return {"success": False, "error": f"Unknown task type: {task_type}", "task_id": task_id}
    
    except Exception as e:
        print(f"  [ERROR] [{phone}] {str(e)[:50]}")
        return {"success": False, "error": str(e), "task_id": task_id, "account_id": account_id, "pair_id": pair_id}


async def main_loop():
    """Main warmup loop - RUNS FOREVER with 7s polling"""
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
            batch_result = await get_batch_tasks(runner="warmup_chat", batch_size=50)
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", POLL_INTERVAL)
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    reason = batch_result.get("reason", "")
                    print(f"  [WAIT] {reason or 'No pending warmup tasks, waiting...'}")
                elif consecutive_empty % 8 == 0:  # Every ~56 seconds at 7s interval
                    print("  [WAIT] Still waiting for warmup tasks...")
                await asyncio.sleep(delay_after if delay_after > 0 else POLL_INTERVAL)
                continue
            
            consecutive_empty = 0
            print(f"\\n  [BATCH] Processing {len(tasks)} warmup tasks in PARALLEL...")
            
            results = await asyncio.gather(
                *[process_single_warmup_task(task) for task in tasks],
                return_exceptions=True
            )
            
            success_count = 0
            for result in results:
                if isinstance(result, Exception):
                    print(f"  ⚠ Task exception: {result}")
                    continue
                if result.get("success"):
                    success_count += 1
                if result.get("task_subtype") == "add_contact" or result.get("pair_id"):
                    await report_result("warmup_chat", result)
                else:
                    await report_result("warmup", result)
            
            fail_count = len(results) - success_count
            print(f"  [RESULT] Batch complete: {success_count} success, {fail_count} failed")
            
            if RUNNING and delay_after > 0:
                print(f"  [WAIT] Waiting {delay_after}s before next batch...")
                await asyncio.sleep(delay_after)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
    
    print("\\n[STOP] Warmup loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Warmup Runner - RUNS FOREVER")
    print("  Polls server every 7 seconds for tasks")
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

  // ========== 8. BLOCK_RUNNER.PY ==========
  const blockRunnerPy = `#!/usr/bin/env python3
"""
Block Runner - Handles blocking and unblocking contacts
"""
import asyncio
import signal

from telethon.tl.functions.contacts import BlockRequest, UnblockRequest

from client_manager import (
    get_or_create_client, get_next_task, report_result, shutdown_all
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def block_contact(client, target, action="block"):
    try:
        target_id = target.get("telegram_id") or target.get("username") or target.get("phone")
        if not target_id:
            return False, "No target identifier"
        entity = await client.get_entity(target_id)
        if action == "block":
            await client(BlockRequest(id=entity))
        else:
            await client(UnblockRequest(id=entity))
        return True, None
    except Exception as e:
        return False, str(e)


async def main_loop():
    print("=" * 50)
    print("  Block Runner")
    print("  [Block/Unblock Contacts]")
    print("=" * 50)
    
    while RUNNING:
        try:
            task = await get_next_task(runner="block")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 2))
            
            elif task_type == "block_contact":
                account = task.get("account", {})
                target = task.get("target", {})
                action = task.get("action", "block")
                client = await get_or_create_client(account)
                if client:
                    print(f"  [{action.upper()}] Processing...")
                    success, error = await block_contact(client, target, action)
                    await report_result("block_contact", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": action
                    })
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
        
        except Exception as e:
            print(f"  [ERROR] {e}")
            await asyncio.sleep(1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\nStopped.")
`;

  // ========== RUN.BAT (Single file to run ALL runners) ==========
  const runBat = `@echo off
title TelegramCRM - All Runners
color 0A

echo.
echo  ================================================
echo       TelegramCRM - Starting All Runners
echo  ================================================
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx pysocks aiohttp --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks aiohttp --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting 4 runners in parallel...
echo.

:: Start each runner in a new window
start "Campaign Runner" cmd /k "title Campaign Runner && color 0B && py campaign_runner.py"
timeout /t 1 /nobreak >nul

start "LiveChat Listener" cmd /k "title LiveChat Listener && color 0D && py live_chat_listener.py"
timeout /t 1 /nobreak >nul

start "Account Manager" cmd /k "title Account Manager && color 0E && py account_manager.py"
timeout /t 1 /nobreak >nul

start "Warmup Runner" cmd /k "title Warmup Runner && color 0A && py warmup_runner.py"

echo.
echo  ================================================
echo     All 4 runners started!
echo  ================================================
echo.
echo     Blue   = Campaign Runner
echo     Purple = LiveChat Listener  
echo     Yellow = Account Manager
echo     Green  = Warmup Runner
echo.
echo     To STOP: Close all windows or press Ctrl+C
echo  ================================================
echo.
pause
`;

  // ========== REQUIREMENTS.TXT ==========
  const requirementsTxt = `telethon>=1.34.0
httpx>=0.27.0
pysocks>=1.7.1
aiohttp>=3.9.0
`;

  // ========== UNIFIED RUNNER - SINGLE FILE ==========
  const unifiedConfigPy = `"""
TelegramCRM Unified Runner - Configuration
"""

BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
`;

  const unifiedFingerprintPy = `"""
TelegramCRM Unified Runner - Fingerprint Generator
"""
import random

ANDROID_MODELS = [
    ("Samsung SM-G998B", "11"),
    ("Samsung SM-S908B", "12"),
    ("Samsung SM-S918B", "13"),
    ("Samsung SM-A536B", "12"),
    ("Xiaomi 2201116SG", "12"),
    ("Xiaomi 2203121C", "12"),
    ("OnePlus LE2121", "11"),
    ("OnePlus CPH2423", "13"),
    ("Google Pixel 6", "12"),
    ("Google Pixel 7 Pro", "13"),
    ("HUAWEI VOG-L29", "10"),
    ("Sony XQ-AT51", "11"),
]

def generate_fingerprint() -> dict:
    model, version = random.choice(ANDROID_MODELS)
    return {
        "device_model": model,
        "system_version": f"SDK {version}",
        "app_version": f"10.{random.randint(10, 14)}.{random.randint(0, 5)}",
        "lang_code": "en",
        "system_lang_code": "en-US"
    }
`;

  const unifiedDbUtilsPy = `"""
TelegramCRM Unified Runner - Database Utilities
Handles proxy and fingerprint fetch/save operations
"""
import httpx
from config import SUPABASE_URL, SUPABASE_KEY

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json"
}

async def fetch_available_proxy(account_id: str) -> dict | None:
    """Fetch an active, unassigned proxy from database"""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # First try to get account's assigned proxy
            resp = await client.get(
                f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{account_id}&select=proxy_id,proxies(*)",
                headers=HEADERS
            )
            if resp.status_code == 200:
                data = resp.json()
                if data and data[0].get("proxies"):
                    proxy = data[0]["proxies"]
                    if proxy.get("status") == "active":
                        return proxy
            
            # Find an unassigned active proxy
            resp = await client.get(
                f"{SUPABASE_URL}/rest/v1/proxies?status=eq.active&assigned_account_id=is.null&limit=1",
                headers=HEADERS
            )
            if resp.status_code == 200:
                data = resp.json()
                if data:
                    return data[0]
            return None
    except Exception as e:
        print(f"  [DB ERROR] fetch_available_proxy: {e}")
        return None


async def fetch_all_proxies() -> list[dict]:
    """Fetch all active proxies from database"""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{SUPABASE_URL}/rest/v1/proxies?status=eq.active&select=*",
                headers=HEADERS
            )
            if resp.status_code == 200:
                return resp.json()
            return []
    except Exception as e:
        print(f"  [DB ERROR] fetch_all_proxies: {e}")
        return []


async def save_proxy_assignment(account_id: str, proxy_id: str):
    """Update account's proxy_id in telegram_accounts table"""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Update account with new proxy
            await client.patch(
                f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{account_id}",
                headers=HEADERS,
                json={"proxy_id": proxy_id}
            )
            # Mark proxy as assigned
            await client.patch(
                f"{SUPABASE_URL}/rest/v1/proxies?id=eq.{proxy_id}",
                headers=HEADERS,
                json={"assigned_account_id": account_id}
            )
    except Exception as e:
        print(f"  [DB ERROR] save_proxy_assignment: {e}")


async def switch_to_new_proxy(account_id: str, old_proxy_id: str | None) -> dict | None:
    """
    Switch account to a different proxy when current one fails.
    1. Mark old proxy as having an error
    2. Find a new active proxy
    3. Assign new proxy to account
    """
    try:
        http = get_http_client()
        
        # Mark old proxy as error if provided
        if old_proxy_id:
            await http.patch(
                f"{SUPABASE_URL}/rest/v1/proxies?id=eq.{old_proxy_id}",
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": "application/json"
                },
                json={"status": "error", "assigned_account_id": None}
            )
            print(f"  [PROXY] Marked {old_proxy_id[:8]}... as error")
        
        # Find a new active proxy (prefer unassigned)
        resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/proxies",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json"
            },
            params={
                "status": "eq.active",
                "assigned_account_id": "is.null",
                "limit": "1"
            }
        )
        
        if resp.status_code != 200:
            return None
        
        proxies = resp.json()
        if not proxies:
            # No unassigned proxies, try any active proxy
            resp = await http.get(
                f"{SUPABASE_URL}/rest/v1/proxies",
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}",
                    "Content-Type": "application/json"
                },
                params={
                    "status": "eq.active",
                    "id": f"neq.{old_proxy_id}" if old_proxy_id else None,
                    "limit": "1"
                }
            )
            if resp.status_code == 200:
                proxies = resp.json()
        
        if not proxies:
            return None
        
        new_proxy = proxies[0]
        
        # Assign new proxy to account
        await save_proxy_assignment(account_id, new_proxy["id"])
        
        return new_proxy
        
    except Exception as e:
        print(f"  [DB ERROR] switch_to_new_proxy: {e}")
        return None

async def fetch_account_fingerprint(account_id: str) -> dict | None:
    """Fetch device_model, system_version, app_version from account"""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{account_id}&select=device_model,system_version,app_version,lang_code,system_lang_code",
                headers=HEADERS
            )
            if resp.status_code == 200:
                data = resp.json()
                if data and data[0].get("device_model"):
                    return data[0]
            return None
    except Exception as e:
        print(f"  [DB ERROR] fetch_account_fingerprint: {e}")
        return None


async def save_fingerprint_to_db(account_id: str, fingerprint: dict):
    """Save fingerprint to telegram_accounts table"""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(
                f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{account_id}",
                headers=HEADERS,
                json={
                    "device_model": fingerprint["device_model"],
                    "system_version": fingerprint["system_version"],
                    "app_version": fingerprint["app_version"],
                    "lang_code": fingerprint.get("lang_code", "en"),
                    "system_lang_code": fingerprint.get("system_lang_code", "en-US")
                }
            )
    except Exception as e:
        print(f"  [DB ERROR] save_fingerprint_to_db: {e}")


async def update_account_status(account_id: str, status: str, reason: str = None):
    """Update account status in database"""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            payload = {"status": status}
            if reason:
                payload["ban_reason"] = reason
            await client.patch(
                f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{account_id}",
                headers=HEADERS,
                json=payload
            )
    except Exception as e:
        print(f"  [DB ERROR] update_account_status: {e}")
`;

  const unifiedTelegramUtilsPy = `"""
TelegramCRM Unified Runner - Telegram Utilities
Helper functions for Telegram operations
"""
import base64
import asyncio
from telethon.tl.functions.account import (
    GetAuthorizationsRequest, ResetAuthorizationRequest,
    UpdateProfileRequest, UpdateUsernameRequest
)
from telethon.tl.functions.photos import UploadProfilePhotoRequest, DeletePhotosRequest
from telethon.tl.functions.users import GetFullUserRequest
from telethon.tl.functions.contacts import GetContactsRequest


async def verify_session(client) -> tuple[str, str | None]:
    """
    Check if session is valid/expired:
    - Returns: ("active", None) if valid
    - Returns: ("disconnected", "Session expired") if expired
    - Returns: ("banned", "Account deleted") if banned
    """
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if not me:
            return "banned", "Account deleted"
        return "active", None
    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["auth", "session", "revoked"]):
            return "disconnected", "Session expired"
        elif any(x in error_str for x in ["banned", "deleted", "deactivated"]):
            return "banned", str(e)
        return "disconnected", str(e)


async def logout_other_sessions(client) -> tuple[bool, str | None]:
    """Logout all other sessions, keep only current one"""
    try:
        result = await client(GetAuthorizationsRequest())
        count = 0
        for auth in result.authorizations:
            if not auth.current:
                try:
                    await client(ResetAuthorizationRequest(hash=auth.hash))
                    count += 1
                except:
                    pass
        return True, f"Logged out {count} other sessions"
    except Exception as e:
        return False, str(e)


async def sync_profile_data(client, account_id: str) -> dict:
    """Sync profile data from Telegram"""
    try:
        me = await client.get_me()
        
        # Get profile photo
        avatar_url = None
        photos = await client.get_profile_photos("me", limit=1)
        if photos:
            photo_bytes = await client.download_media(photos[0], bytes)
            avatar_url = f"data:image/jpeg;base64,{base64.b64encode(photo_bytes).decode()}"
        
        return {
            "success": True,
            "first_name": me.first_name,
            "last_name": me.last_name or "",
            "username": me.username,
            "telegram_id": me.id,
            "avatar_url": avatar_url
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def change_profile_photo(client, photo_url: str) -> tuple[bool, str | None]:
    """Change profile photo from URL"""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=30) as http:
            resp = await http.get(photo_url)
            if resp.status_code != 200:
                return False, f"Failed to download photo: {resp.status_code}"
            photo_bytes = resp.content
        
        # Delete old photos first
        photos = await client.get_profile_photos("me")
        if photos:
            await client(DeletePhotosRequest(id=[p for p in photos]))
        
        # Upload new photo
        file = await client.upload_file(photo_bytes, file_name="profile.jpg")
        await client(UploadProfilePhotoRequest(file=file))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_name(client, first_name: str, last_name: str = "") -> tuple[bool, str | None]:
    """Change profile first and last name"""
    try:
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def get_contacts_list(client) -> set:
    """Get all contacts from account"""
    try:
        result = await client(GetContactsRequest(hash=0))
        contacts = set()
        for user in result.users:
            contacts.add(user.id)
        return contacts
    except Exception as e:
        print(f"  [ERROR] get_contacts_list: {e}")
        return set()
`;

  const unifiedRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Unified Single Runner
All-in-one: Campaign | LiveChat | Account Management | Session Verification

CRITICAL SAFETY:
- Never runs session without proxy
- Never runs session without fingerprint
- Generates and saves fingerprint if missing
- Fetches proxy from database if not assigned
"""

import os
import sys
import base64
import asyncio
import signal
import tempfile
from datetime import datetime
from typing import Dict, Optional, Set

import httpx
import socks
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError
from telethon.tl.types import InputPeerUser

from config import BACKEND_URL, SUPABASE_URL, SUPABASE_KEY
from fingerprint_generator import generate_fingerprint
from db_utils import (
    fetch_available_proxy, save_proxy_assignment,
    fetch_account_fingerprint, save_fingerprint_to_db,
    update_account_status
)
from telegram_utils import (
    verify_session, logout_other_sessions, sync_profile_data,
    change_profile_photo, change_name, get_contacts_list
)

# ========== CONFIGURATION ==========
SESSION_FOLDER = tempfile.mkdtemp(prefix="unified_sessions_")
RUNNING = True

# Batch limits
PHOTO_CHANGE_BATCH_LIMIT = 10
NAME_CHANGE_BATCH_LIMIT = 100

# Timeouts
CONNECTION_TIMEOUT = 15
HTTP_TIMEOUT = 15

# Active clients and contacts cache
active_clients: Dict[str, TelegramClient] = {}
contacts_cache: Dict[str, Set[int]] = {}  # account_id -> set of contact telegram_ids

# HTTP client
_http_client: Optional[httpx.AsyncClient] = None

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Content-Type": "application/json"
}

# ========== SIGNAL HANDLERS ==========
def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down gracefully...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== HTTP CLIENT ==========
def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20)
        )
    return _http_client


# ========== SESSION UTILITIES ==========
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


def get_proxy_settings(proxy: dict) -> Optional[tuple]:
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


# ========== CRITICAL: PREPARE ACCOUNT (PROXY + FINGERPRINT + SESSION) ==========
async def prepare_account(account: dict) -> tuple[dict | None, str | None]:
    """
    CRITICAL SAFETY: Never run session without ALL THREE:
    1. Session data (session file)
    2. Proxy (auto-assign if missing)
    3. Fingerprint (auto-generate if missing)
    
    Steps:
    1. Check session_data exists → SKIP if missing
    2. Check/assign proxy from DB if missing
    3. Check/generate fingerprint if missing
    4. Save new assignments to DB
    """
    account_id = account.get("id")
    phone = account.get("phone_number", "???")[-4:]
    
    # ========== STEP 0: CHECK SESSION DATA FIRST ==========
    session_data = account.get("session_data")
    if not session_data:
        return None, f"[{phone}] SKIPPED - No session data"
    
    # ========== STEP 1: CHECK/ASSIGN PROXY ==========
    proxy = account.get("proxy")
    if not proxy or not proxy.get("host"):
        print(f"  [{phone}] No proxy assigned, fetching from database...")
        proxy = await fetch_available_proxy(account_id)
        if not proxy:
            return None, f"[{phone}] SKIPPED - No proxy available in database"
        account["proxy"] = proxy
        # Save proxy assignment to database
        await save_proxy_assignment(account_id, proxy["id"])
        print(f"  [{phone}] Assigned proxy: {proxy['host']}:{proxy['port']}")
    
    # ========== STEP 2: CHECK/GENERATE FINGERPRINT ==========
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    
    if not device_model or not system_version:
        print(f"  [{phone}] No fingerprint, generating new one...")
        fp = generate_fingerprint()
        account.update(fp)
        # Save fingerprint to database
        await save_fingerprint_to_db(account_id, fp)
        print(f"  [{phone}] Generated fingerprint: {fp['device_model']}")
    
    return account, None


# ========== GET OR CREATE CLIENT ==========
async def get_or_create_client(account: dict, setup_handler=None) -> Optional[TelegramClient]:
    """
    Get or create a Telegram client.
    CRITICAL: Only creates client if ALL THREE exist:
    1. Session data (session file)
    2. Proxy (connection security)
    3. Fingerprint (device identity)
    """
    account_id = account.get("id")
    phone = account.get("phone_number", account_id[:8])
    
    # ========== STEP 1: PREPARE ACCOUNT (SESSION + PROXY + FINGERPRINT) ==========
    # This validates ALL requirements before proceeding
    account, error = await prepare_account(account)
    if error:
        print(f"  {error}")
        return None
    
    # ========== STEP 2: CHECK EXISTING CLIENT ==========
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                return client
        except:
            pass
        del active_clients[account_id]
    
    # Session data is already validated in prepare_account, get it
    session_data = account.get("session_data")
    
    # ========== STEP 4: GET PROXY SETTINGS ==========
    proxy = get_proxy_settings(account.get("proxy"))
    if not proxy:
        print(f"  [SKIP] {phone} - Invalid proxy configuration")
        return None
    
    print(f"  [PROXY] {phone} using {proxy[1]}:{proxy[2]}")
    
    # ========== STEP 5: DECODE SESSION ==========
    session_path = decode_session_file(phone, session_data)
    if not session_path:
        return None
    
    # ========== STEP 6: CREATE CLIENT WITH FINGERPRINT ==========
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version", "10.14.2")
    lang_code = account.get("lang_code", "en")
    system_lang_code = account.get("system_lang_code", "en-US")
    
    print(f"  [FP] {phone} device: {device_model}")
    
    try:
        # Use account's API credentials or default
        api_id = account.get("api_id") or "31812270"
        api_hash = account.get("api_hash") or "4cce3baadfdb22bd5930f9d8f5063f98"
        
        client = TelegramClient(
            session_path, int(api_id), api_hash,
            device_model=device_model,
            system_version=system_version,
            app_version=app_version,
            lang_code=lang_code,
            system_lang_code=system_lang_code,
            proxy=proxy,
            timeout=CONNECTION_TIMEOUT,
            connection_retries=2,
            retry_delay=1,
            auto_reconnect=True
        )
        
        print(f"  [CONNECT] {phone}...")
        await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
        
        if not await client.is_user_authorized():
            print(f"  [EXPIRED] {phone} - Session expired")
            await update_account_status(account_id, "disconnected", "Session expired")
            return None
        
        # Verify session
        status, error = await verify_session(client)
        if status != "active":
            print(f"  [{status.upper()}] {phone}: {error}")
            await update_account_status(account_id, status, error)
            return None
        
        if setup_handler:
            await setup_handler(client, account_id)
        
        active_clients[account_id] = client
        print(f"  [OK] Connected: {phone}")
        return client
        
    except asyncio.TimeoutError:
        print(f"  [TIMEOUT] {phone} - Proxy not working, trying to switch...")
        # Try to get a different proxy
        new_proxy = await switch_to_new_proxy(account_id, account.get("proxy", {}).get("id"))
        if new_proxy:
            print(f"  [SWITCH] {phone} - Trying new proxy: {new_proxy['host']}:{new_proxy['port']}")
            account["proxy"] = new_proxy
            # Retry connection with new proxy (one retry only)
            try:
                proxy = get_proxy_settings(new_proxy)
                client = TelegramClient(
                    session_path, int(account.get("api_id") or "31812270"), 
                    account.get("api_hash") or "4cce3baadfdb22bd5930f9d8f5063f98",
                    device_model=account.get("device_model"),
                    system_version=account.get("system_version"),
                    app_version=account.get("app_version", "10.14.2"),
                    lang_code=account.get("lang_code", "en"),
                    system_lang_code=account.get("system_lang_code", "en-US"),
                    proxy=proxy,
                    timeout=CONNECTION_TIMEOUT,
                    connection_retries=1,
                    auto_reconnect=True
                )
                await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
                if await client.is_user_authorized():
                    if setup_handler:
                        await setup_handler(client, account_id)
                    active_clients[account_id] = client
                    print(f"  [OK] Connected with new proxy: {phone}")
                    return client
            except Exception as retry_err:
                print(f"  [FAIL] {phone} - New proxy also failed: {retry_err}")
        else:
            print(f"  [FAIL] {phone} - No alternative proxy available")
        return None
    except Exception as e:
        err_str = str(e).lower()
        if any(x in err_str for x in ["deleted", "deactivated", "banned"]):
            print(f"  [BANNED] {phone}: {e}")
            await update_account_status(account_id, "banned", str(e))
        elif "proxy" in err_str or "connection" in err_str or "timeout" in err_str:
            print(f"  [PROXY ERROR] {phone}: {e} - Trying to switch proxy...")
            new_proxy = await switch_to_new_proxy(account_id, account.get("proxy", {}).get("id"))
            if new_proxy:
                print(f"  [INFO] {phone} - New proxy assigned: {new_proxy['host']}:{new_proxy['port']}")
                print(f"  [INFO] Will use new proxy on next connection attempt")
        else:
            print(f"  [FAIL] {phone}: {e}")
        return None


# ========== FETCH ALL ACTIVE ACCOUNTS WITH EVERYTHING ==========
async def fetch_all_accounts_ready() -> list:
    """
    Fetch ALL accounts and prepare them for connection:
    - Have session_data
    - Auto-assign proxy if missing
    - Auto-generate fingerprint if missing
    - Save new assignments to database
    """
    try:
        http = get_http_client()
        
        print("  [STEP 1] Fetching all active accounts with sessions...")
        
        # Fetch ALL active accounts with sessions
        resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/telegram_accounts",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json"
            },
            params={
                "select": "id,phone_number,session_data,device_model,system_version,app_version,lang_code,system_lang_code,api_id,api_hash,proxy_id",
                "status": "eq.active",
                "session_data": "not.is.null"
            }
        )
        
        if resp.status_code != 200:
            print(f"  [ERROR] Fetch accounts: HTTP {resp.status_code}")
            return []
        
        accounts = resp.json()
        print(f"  [STEP 1] Found {len(accounts)} active accounts with sessions")
        
        if not accounts:
            return []
        
        # ========== STEP 2: FETCH ALL ACTIVE PROXIES ==========
        print("  [STEP 2] Fetching all active proxies...")
        
        proxy_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/proxies",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json"
            },
            params={
                "select": "id,host,port,username,password,proxy_type,status,assigned_account_id",
                "status": "eq.active"
            }
        )
        
        all_proxies = proxy_resp.json() if proxy_resp.status_code == 200 else []
        print(f"  [STEP 2] Found {len(all_proxies)} active proxies")
        
        # Build proxy maps
        proxies_by_id = {p["id"]: p for p in all_proxies}
        unassigned_proxies = [p for p in all_proxies if not p.get("assigned_account_id")]
        
        # ========== STEP 3: ASSIGN PROXIES & GENERATE FINGERPRINTS ==========
        print("  [STEP 3] Preparing accounts (assign proxy + generate fingerprint if needed)...")
        
        ready_accounts = []
        skipped_no_proxy = 0
        fingerprints_generated = 0
        proxies_assigned = 0
        
        unassigned_idx = 0
        
        # Batch updates for DB
        proxy_updates = []
        fingerprint_updates = []
        
        for account in accounts:
            account_id = account["id"]
            phone = account.get("phone_number", "???")[-4:]
            
            # Check/assign proxy
            proxy = None
            if account.get("proxy_id") and account["proxy_id"] in proxies_by_id:
                proxy = proxies_by_id[account["proxy_id"]]
            elif unassigned_idx < len(unassigned_proxies):
                # Assign an unassigned proxy
                proxy = unassigned_proxies[unassigned_idx]
                unassigned_idx += 1
                proxies_assigned += 1
                # Queue for batch update
                proxy_updates.append({
                    "account_id": account_id,
                    "proxy_id": proxy["id"]
                })
            
            if not proxy or not proxy.get("host"):
                skipped_no_proxy += 1
                continue
            
            account["proxy"] = proxy
            
            # Check/generate fingerprint
            if not account.get("device_model") or not account.get("system_version"):
                fp = generate_fingerprint()
                account.update(fp)
                fingerprints_generated += 1
                # Queue for batch update
                fingerprint_updates.append({
                    "account_id": account_id,
                    "fingerprint": fp
                })
            
            ready_accounts.append(account)
        
        print(f"  [STEP 3] Ready: {len(ready_accounts)} | No proxy: {skipped_no_proxy}")
        print(f"  [STEP 3] Proxies assigned: {proxies_assigned} | Fingerprints generated: {fingerprints_generated}")
        
        # ========== STEP 4: SAVE NEW ASSIGNMENTS TO DATABASE ==========
        if proxy_updates or fingerprint_updates:
            print(f"  [STEP 4] Saving {len(proxy_updates)} proxy + {len(fingerprint_updates)} fingerprint updates...")
            
            # Save proxy assignments
            for update in proxy_updates:
                await save_proxy_assignment(update["account_id"], update["proxy_id"])
            
            # Save fingerprints
            for update in fingerprint_updates:
                await save_fingerprint_to_db(update["account_id"], update["fingerprint"])
            
            print("  [STEP 4] Saved all updates to database")
        
        return ready_accounts
        
    except Exception as e:
        print(f"  [ERROR] fetch_all_accounts_ready: {e}")
        return []


# ========== INSTANT CONNECT (WITH AUTO PROXY SWITCH ON FAILURE) ==========
async def instant_connect(account: dict, retry_with_new_proxy: bool = True) -> bool:
    """
    Connect account - on connection failure, switch to new proxy and save to DB.
    """
    account_id = account.get("id")
    phone = account.get("phone_number", "???")[-4:]
    
    try:
        # Check if already connected
        if account_id in active_clients:
            client = active_clients[account_id]
            if client.is_connected():
                return True
            del active_clients[account_id]
        
        # Get proxy settings
        proxy = get_proxy_settings(account.get("proxy"))
        if not proxy:
            print(f"  [{phone}] No valid proxy")
            return False
        
        # Decode session
        session_path = decode_session_file(phone, account.get("session_data"))
        if not session_path:
            return False
        
        # Create client with fingerprint
        api_id = account.get("api_id") or "31812270"
        api_hash = account.get("api_hash") or "4cce3baadfdb22bd5930f9d8f5063f98"
        
        client = TelegramClient(
            session_path, int(api_id), api_hash,
            device_model=account.get("device_model"),
            system_version=account.get("system_version"),
            app_version=account.get("app_version", "10.14.2"),
            lang_code=account.get("lang_code", "en"),
            system_lang_code=account.get("system_lang_code", "en-US"),
            proxy=proxy,
            timeout=CONNECTION_TIMEOUT,
            connection_retries=1,
            auto_reconnect=True
        )
        
        # Connect
        await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
        
        if not await client.is_user_authorized():
            await update_account_status(account_id, "disconnected", "Session expired")
            return False
        
        # Setup livechat handler
        await setup_livechat_handler(client, account_id)
        
        active_clients[account_id] = client
        return True
        
    except (asyncio.TimeoutError, Exception) as e:
        err_str = str(e).lower()
        is_proxy_error = any(x in err_str for x in ["timeout", "proxy", "connection", "semaphore", "refused", "reset"])
        
        # If proxy error and retry allowed, switch proxy and retry
        if retry_with_new_proxy and is_proxy_error:
            print(f"  [{phone}] Proxy failed, switching to new proxy...")
            old_proxy_id = account.get("proxy", {}).get("id")
            
            # Get new proxy and save to database
            new_proxy = await switch_to_new_proxy(account_id, old_proxy_id)
            
            if new_proxy:
                print(f"  [{phone}] New proxy assigned: {new_proxy['host']}:{new_proxy['port']}")
                account["proxy"] = new_proxy
                # Retry with new proxy (no more retries after this)
                return await instant_connect(account, retry_with_new_proxy=False)
            else:
                print(f"  [{phone}] No alternative proxy available")
        
        return False


# ========== STARTUP: CONNECT ALL ACCOUNTS INSTANTLY ==========
async def connect_all_accounts_for_livechat():
    """
    INSTANT startup - fetch everything first, then connect ALL at once.
    No DB calls during connection phase.
    """
    print()
    print("=" * 60)
    print("  PHASE 1: INSTANT Startup (All Accounts At Once)")
    print("=" * 60)
    print()
    
    # Step 1-3: Fetch ALL data and prepare accounts
    accounts = await fetch_all_accounts_ready()
    
    if not accounts:
        print("  [WARN] No ready accounts to connect")
        return 0
    
    # Step 4: Connect ALL accounts simultaneously (no DB calls)
    print()
    print(f"  [STEP 4] Connecting {len(accounts)} accounts INSTANTLY...")
    
    start_time = asyncio.get_event_loop().time()
    
    # Run ALL connections at once
    tasks = [instant_connect(account) for account in accounts]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    elapsed = asyncio.get_event_loop().time() - start_time
    
    # Count results
    connected = sum(1 for r in results if r is True)
    failed = len(accounts) - connected
    
    print()
    print("=" * 60)
    print(f"  LIVECHAT READY: {connected} connected | {failed} failed")
    print(f"  TIME: {elapsed:.1f} seconds for {len(accounts)} accounts")
    print("=" * 60)
    print()
    
    return connected


# ========== API FUNCTIONS ==========
async def send_heartbeat():
    """Send heartbeat to backend to show runner is online"""
    try:
        http = get_http_client()
        await http.post(
            f"{SUPABASE_URL}/rest/v1/runner_heartbeats",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates"
            },
            json={
                "runner_name": "unified",
                "last_seen": datetime.now().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
                "status": "online"
            }
        )
    except Exception as e:
        print(f"  [HEARTBEAT ERROR] {e}")


async def get_batch_tasks(runner: str = "unified", batch_size: int = 50) -> dict:
    """Fetch batch of tasks from backend"""
    try:
        # Send heartbeat with each batch request
        asyncio.create_task(send_heartbeat())
        
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers=HEADERS,
            json={"runner": runner, "batch_size": batch_size}
        )
        if resp.status_code == 200:
            return resp.json()
        print(f"  [HTTP ERROR] get_batch_tasks: {resp.status_code}")
        return {"tasks": [], "delay_after": 5}
    except Exception as e:
        print(f"  [HTTP ERROR] get_batch_tasks: {e}")
        return {"tasks": [], "delay_after": 5}


async def report_result(task_type: str, result: dict):
    """Report task result to backend - never crash on errors"""
    try:
        http = get_http_client()
        await http.post(
            f"{BACKEND_URL}/report-task-result",
            headers=HEADERS,
            json={"task_type": task_type, "result": result}
        )
    except Exception as e:
        print(f"  [REPORT ERROR] {task_type}: {e}")


async def report_batch_results(results: list):
    """Report batch results to backend"""
    if not results:
        return
    try:
        http = get_http_client()
        await http.post(
            f"{BACKEND_URL}/report-batch-results",
            headers=HEADERS,
            json={"results": results}
        )
    except Exception as e:
        print(f"  [REPORT ERROR] batch: {e}")


# ========== CAMPAIGN HANDLER (NO STAGGER, NO DELAY) ==========
async def handle_campaign_send(task: dict, account: dict):
    """
    Send campaign message - NO stagger, NO delay
    Server controls batch size, runner processes immediately
    """
    client = await get_or_create_client(account)
    campaign_recipient_id = task.get("campaign_recipient_id")
    
    if not client:
        return {
            "success": False, 
            "error": "Failed to connect", 
            "campaign_recipient_id": campaign_recipient_id,
            "account_id": account.get("id")
        }
    
    recipient_phone = task.get("recipient_phone")
    message = task.get("message", "")
    
    try:
        # Get entity
        entity = None
        if task.get("recipient_telegram_id"):
            try:
                entity = await client.get_entity(task["recipient_telegram_id"])
            except:
                pass
        
        if not entity and recipient_phone:
            try:
                entity = await client.get_entity(recipient_phone)
            except:
                pass
        
        if not entity:
            return {
                "success": False, 
                "error": "User not found", 
                "campaign_recipient_id": campaign_recipient_id,
                "account_id": account.get("id")
            }
        
        # Send message immediately (no delay!)
        await client.send_message(entity, message)
        
        return {
            "success": True,
            "campaign_recipient_id": campaign_recipient_id,
            "campaign_id": task.get("campaign_id"),
            "campaign_seat_id": task.get("campaign_seat_id"),
            "campaign_name": task.get("campaign_name"),
            "account_id": account.get("id"),
            "recipient_phone": recipient_phone,
            "recipient_name": task.get("recipient_name"),
            "content": message
        }
        
    except FloodWaitError as e:
        return {
            "success": False, 
            "error": f"FloodWait {e.seconds}s", 
            "campaign_recipient_id": campaign_recipient_id,
            "account_id": account.get("id"),
            "retry_with_different_account": True
        }
    except UserPrivacyRestrictedError:
        return {
            "success": False, 
            "error": "Privacy restricted", 
            "campaign_recipient_id": campaign_recipient_id,
            "account_id": account.get("id")
        }
    except Exception as e:
        return {
            "success": False, 
            "error": str(e), 
            "campaign_recipient_id": campaign_recipient_id,
            "account_id": account.get("id")
        }


async def process_campaign_batch(tasks: list):
    """Process campaign tasks in parallel - NO stagger, NO delay, UNLIMITED batches"""
    if not tasks:
        return
    
    print(f"  [CAMPAIGN] Processing {len(tasks)} messages (no delay)...")
    
    # Process all in parallel
    results = await asyncio.gather(*[
        handle_campaign_send(task, task.get("account", {}))
        for task in tasks
    ], return_exceptions=True)
    
    # Convert exceptions to results
    final_results = []
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            final_results.append({
                "success": False,
                "error": str(r),
                "campaign_recipient_id": tasks[i].get("campaign_recipient_id"),
                "account_id": tasks[i].get("account", {}).get("id")
            })
        elif r:
            final_results.append(r)
    
    # Report all results at once
    await report_batch_results(final_results)
    
    success = sum(1 for r in final_results if r.get("success"))
    print(f"  [CAMPAIGN] Done: {success}/{len(final_results)} successful")


# ========== LIVECHAT HANDLER (CONTACTS ONLY + PICTURES) ==========
async def setup_livechat_handler(client, account_id: str):
    """Setup incoming message handler - CONTACTS ONLY"""
    
    # Cache contacts for this account
    contacts = await get_contacts_list(client)
    contacts_cache[account_id] = contacts
    print(f"  [LIVECHAT] Loaded {len(contacts)} contacts for filtering")
    
    @client.on(events.NewMessage(incoming=True))
    async def incoming_handler(event):
        try:
            sender = await event.get_sender()
            sender_id = sender.id if sender else None
            
            # FILTER: Only accept messages from contacts
            if sender_id not in contacts_cache.get(account_id, set()):
                return  # Ignore non-contacts
            
            content = event.message.text or ""
            media_url = None
            media_type = None
            
            # Handle incoming photos
            if event.message.photo:
                photo_bytes = await client.download_media(event.message.photo, bytes)
                media_url = f"data:image/jpeg;base64,{base64.b64encode(photo_bytes).decode()}"
                media_type = "photo"
                if not content:
                    content = "[Photo]"
            
            # Handle incoming files/documents
            elif event.message.document:
                media_type = "document"
                content = content or "[Document]"
            
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_telegram_id": sender_id,
                "sender_username": getattr(sender, "username", None),
                "sender_name": getattr(sender, "first_name", "") + " " + (getattr(sender, "last_name", "") or ""),
                "content": content,
                "media_url": media_url,
                "media_type": media_type,
                "telegram_message_id": event.message.id
            })
            
        except Exception as e:
            print(f"  [LIVECHAT ERROR] {e}")
    
    print(f"  [LIVECHAT] Handler setup for account {account_id[:8]}")


async def handle_livechat_send(task: dict, account: dict):
    """Send live chat message with optional picture"""
    client = await get_or_create_client(account, setup_handler=setup_livechat_handler)
    if not client:
        return {"success": False, "error": "Failed to connect"}
    
    message_id = task.get("message_id")
    conversation_id = task.get("conversation_id")
    content = task.get("content", "")
    media_url = task.get("media_url")
    recipient_telegram_id = task.get("recipient_telegram_id")
    recipient_phone = task.get("recipient_phone")
    
    try:
        # Get entity
        entity = None
        if recipient_telegram_id:
            try:
                entity = await client.get_entity(recipient_telegram_id)
            except:
                pass
        
        if not entity and recipient_phone:
            try:
                entity = await client.get_entity(recipient_phone)
            except:
                pass
        
        if not entity:
            return {"success": False, "error": "User not found", "message_id": message_id}
        
        # Send with optional media
        if media_url:
            # Download and send as photo
            async with httpx.AsyncClient(timeout=30) as http:
                resp = await http.get(media_url)
                if resp.status_code == 200:
                    photo_bytes = resp.content
                    result = await client.send_file(entity, photo_bytes, caption=content)
                else:
                    result = await client.send_message(entity, content)
        else:
            result = await client.send_message(entity, content)
        
        await report_result("message_sent", {
            "message_id": message_id,
            "conversation_id": conversation_id,
            "account_id": account.get("id"),
            "telegram_message_id": result.id,
            "success": True
        })
        
        return {"success": True, "message_id": message_id}
        
    except Exception as e:
        await report_result("message_failed", {
            "message_id": message_id,
            "error": str(e)
        })
        return {"success": False, "error": str(e), "message_id": message_id}


# ========== ACCOUNT MANAGEMENT (BATCH LIMITS) ==========
async def process_photo_changes(tasks: list):
    """Process max 10 profile photo changes per batch"""
    batch = tasks[:PHOTO_CHANGE_BATCH_LIMIT]
    print(f"  [PHOTO] Processing {len(batch)} photo changes (limit: {PHOTO_CHANGE_BATCH_LIMIT})...")
    
    for task in batch:
        account = task.get("account", {})
        photo_url = task.get("photo_url")
        task_id = task.get("task_id")
        
        client = await get_or_create_client(account)
        if not client:
            await report_result("photo_change", {"task_id": task_id, "success": False, "error": "Failed to connect"})
            continue
        
        success, error = await change_profile_photo(client, photo_url)
        await report_result("photo_change", {
            "task_id": task_id,
            "account_id": account.get("id"),
            "success": success,
            "error": error
        })
        print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")


async def process_name_changes(tasks: list):
    """Process max 100 name changes per batch"""
    batch = tasks[:NAME_CHANGE_BATCH_LIMIT]
    print(f"  [NAME] Processing {len(batch)} name changes (limit: {NAME_CHANGE_BATCH_LIMIT})...")
    
    for task in batch:
        account = task.get("account", {})
        first_name = task.get("first_name", "User")
        last_name = task.get("last_name", "")
        task_id = task.get("task_id")
        
        client = await get_or_create_client(account)
        if not client:
            await report_result("name_change", {"task_id": task_id, "success": False, "error": "Failed to connect"})
            continue
        
        success, error = await change_name(client, first_name, last_name)
        await report_result("name_change", {
            "task_id": task_id,
            "account_id": account.get("id"),
            "success": success,
            "error": error
        })
        print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")


async def handle_sync_profile(task: dict, account: dict):
    """Sync profile data from Telegram to database"""
    task_id = task.get("task_id")
    
    client = await get_or_create_client(account)
    if not client:
        await report_result("sync_profile", {"task_id": task_id, "success": False, "error": "Failed to connect"})
        return
    
    result = await sync_profile_data(client, account.get("id"))
    result["task_id"] = task_id
    result["account_id"] = account.get("id")
    await report_result("sync_profile", result)
    print(f"    {'[OK] Profile synced' if result.get('success') else '[FAIL] ' + str(result.get('error'))}")


async def handle_logout_sessions(task: dict, account: dict):
    """Logout all other sessions"""
    task_id = task.get("task_id")
    
    client = await get_or_create_client(account)
    if not client:
        await report_result("logout_sessions", {"task_id": task_id, "success": False, "error": "Failed to connect"})
        return
    
    success, message = await logout_other_sessions(client)
    await report_result("logout_sessions", {
        "task_id": task_id,
        "account_id": account.get("id"),
        "success": success,
        "message": message
    })
    print(f"    {'[OK] ' + str(message) if success else '[FAIL] ' + str(message)}")


async def handle_verify_session(task: dict, account: dict):
    """Verify if session is valid"""
    task_id = task.get("task_id")
    
    client = await get_or_create_client(account)
    if not client:
        await report_result("verify_session", {
            "task_id": task_id,
            "account_id": account.get("id"),
            "status": "disconnected",
            "error": "Failed to connect"
        })
        return
    
    status, error = await verify_session(client)
    await report_result("verify_session", {
        "task_id": task_id,
        "account_id": account.get("id"),
        "status": status,
        "error": error
    })
    print(f"    [SESSION] Status: {status}")


# ========== WARMUP HANDLER ==========
async def handle_warmup_task(task: dict, account: dict):
    """Handle warmup chat or add_contact task"""
    task_id = task.get("task_id")
    pair_id = task.get("pair_id")
    task_type = task.get("task", "warmup_chat")
    task_data = task.get("task_data", {})
    
    client = await get_or_create_client(account)
    if not client:
        await report_result("warmup_chat", {
            "task_id": task_id,
            "pair_id": pair_id,
            "success": False,
            "error": "Failed to connect"
        })
        return
    
    recipient_phone = task_data.get("recipient_phone")
    recipient_telegram_id = task_data.get("recipient_telegram_id")
    message = task_data.get("message", "")
    
    try:
        # Get entity
        entity = None
        if recipient_telegram_id:
            try:
                entity = await client.get_entity(recipient_telegram_id)
            except:
                pass
        
        if not entity and recipient_phone:
            try:
                entity = await client.get_entity(recipient_phone)
            except:
                pass
        
        if not entity:
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "success": False,
                "error": "User not found"
            })
            return
        
        if task_type == "warmup_add_contact":
            # Add contact
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            
            contact = InputPhoneContact(
                client_id=0,
                phone=recipient_phone,
                first_name=task_data.get("first_name", "Contact"),
                last_name=""
            )
            await client(ImportContactsRequest([contact]))
            print(f"    [WARMUP] Added contact: {recipient_phone}")
        else:
            # Send warmup message
            await client.send_message(entity, message)
            print(f"    [WARMUP] Sent: {message[:30]}...")
        
        await report_result("warmup_chat", {
            "task_id": task_id,
            "pair_id": pair_id,
            "is_cycle_last": task.get("is_cycle_last", False),
            "account_id": account.get("id"),
            "success": True
        })
        
    except Exception as e:
        await report_result("warmup_chat", {
            "task_id": task_id,
            "pair_id": pair_id,
            "success": False,
            "error": str(e)
        })
        print(f"    [WARMUP FAIL] {e}")


# ========== CONNECTION STATUS MONITOR ==========
async def check_connection_status():
    """Check how many accounts are still connected"""
    connected = 0
    disconnected = 0
    
    for account_id, client in list(active_clients.items()):
        try:
            if client.is_connected():
                connected += 1
            else:
                disconnected += 1
        except:
            disconnected += 1
    
    return connected, disconnected


async def connection_monitor_loop():
    """Background task: Print connection status every 1 minute"""
    while RUNNING:
        await asyncio.sleep(60)  # Wait 1 minute
        
        connected, disconnected = await check_connection_status()
        total = len(active_clients)
        
        print()
        print(f"  [STATUS] Accounts: {connected} connected | {disconnected} disconnected | {total} total")
        
        # Attempt to reconnect disconnected clients
        if disconnected > 0:
            print(f"  [RECONNECT] Attempting to reconnect {disconnected} accounts...")
            reconnected = 0
            
            for account_id, client in list(active_clients.items()):
                try:
                    if not client.is_connected():
                        await client.connect()
                        if client.is_connected():
                            reconnected += 1
                except:
                    pass
            
            if reconnected > 0:
                print(f"  [RECONNECT] Reconnected {reconnected} accounts")


# ========== SHUTDOWN ==========
async def shutdown_all():
    """Disconnect all clients"""
    print(f"  [SHUTDOWN] Disconnecting {len(active_clients)} clients...")
    for account_id, client in list(active_clients.items()):
        try:
            await client.disconnect()
        except:
            pass
    active_clients.clear()
    contacts_cache.clear()
    
    global _http_client
    if _http_client:
        await _http_client.aclose()
        _http_client = None


# ========== MAIN LOOP ==========
async def main_loop():
    """Main loop with comprehensive error handling - NEVER CRASHES"""
    print("=" * 60)
    print("  TelegramCRM - Unified Single Runner")
    print("  All-in-one: Campaign | LiveChat | Account | Warmup")
    print("=" * 60)
    print()
    print("  SAFETY FEATURES (3 Requirements):")
    print("    ✓ Never runs without SESSION FILE")
    print("    ✓ Never runs without PROXY")
    print("    ✓ Never runs without FINGERPRINT")
    print()
    print("  AUTO FEATURES:")
    print("    ✓ Auto-connects ALL accounts at startup for LiveChat")
    print("    ✓ Auto-generates and saves fingerprint if missing")
    print("    ✓ Auto-assigns proxy if not assigned")
    print("    ✓ Auto-restart on any crash")
    print()
    print("  LIMITS:")
    print("    ✓ Contacts-only filter for live chat")
    print("    ✓ Batch limits: 10 photos, 100 names")
    print("    ✓ No stagger/delay in campaigns")
    print()
    print("=" * 60)
    
    # ========== PHASE 1: CONNECT ALL ACCOUNTS FOR LIVECHAT ==========
    # This is CRITICAL - connects all accounts at startup so they can
    # receive incoming messages for LiveChat functionality
    await connect_all_accounts_for_livechat()
    
    print("=" * 60)
    print("  PHASE 2: Starting Task Processing Loop")
    print("=" * 60)
    print()
    
    # Start connection monitor in background (prints status every 1 minute)
    asyncio.create_task(connection_monitor_loop())
    
    consecutive_errors = 0
    last_heartbeat = 0
    
    while RUNNING:
        try:
            # Send heartbeat every 30 seconds
            now = asyncio.get_event_loop().time()
            if now - last_heartbeat > 30:
                asyncio.create_task(send_heartbeat())
                last_heartbeat = now
            
            # Fetch tasks from unified endpoint
            batch = await get_batch_tasks(runner="unified", batch_size=50)
            tasks = batch.get("tasks", [])
            delay_after = batch.get("delay_after", 2)
            
            # Reset error counter on successful fetch
            consecutive_errors = 0
            
            if not tasks:
                await asyncio.sleep(delay_after)
                continue
            
            # Group tasks by type
            campaign_tasks = []
            livechat_tasks = []
            photo_tasks = []
            name_tasks = []
            warmup_tasks = []
            other_tasks = []
            
            for task in tasks:
                task_type = task.get("task", "")
                if task_type == "send":
                    campaign_tasks.append(task)
                elif task_type == "livechat_send":
                    livechat_tasks.append(task)
                elif task_type == "change_photo":
                    photo_tasks.append(task)
                elif task_type == "change_name":
                    name_tasks.append(task)
                elif task_type in ("warmup_chat", "warmup_add_contact"):
                    warmup_tasks.append(task)
                else:
                    other_tasks.append(task)
            
            # Process campaign tasks (parallel, no delay) - with error handling
            if campaign_tasks:
                try:
                    await process_campaign_batch(campaign_tasks)
                except Exception as e:
                    print(f"  [ERROR] Campaign batch: {e}")
            
            # Process live chat sends - with error handling
            for task in livechat_tasks:
                try:
                    await handle_livechat_send(task, task.get("account", {}))
                except Exception as e:
                    print(f"  [ERROR] LiveChat send: {e}")
            
            # Process warmup tasks - with error handling
            for task in warmup_tasks:
                try:
                    await handle_warmup_task(task, task.get("account", {}))
                except Exception as e:
                    print(f"  [ERROR] Warmup task: {e}")
            
            # Process photo changes (batch limit: 10) - with error handling
            if photo_tasks:
                try:
                    await process_photo_changes(photo_tasks)
                except Exception as e:
                    print(f"  [ERROR] Photo changes: {e}")
            
            # Process name changes (batch limit: 100) - with error handling
            if name_tasks:
                try:
                    await process_name_changes(name_tasks)
                except Exception as e:
                    print(f"  [ERROR] Name changes: {e}")
            
            # Process other tasks - with error handling
            for task in other_tasks:
                try:
                    task_type = task.get("task", "")
                    account = task.get("account", {})
                    
                    if task_type == "sync_profile":
                        await handle_sync_profile(task, account)
                    elif task_type == "logout_sessions":
                        await handle_logout_sessions(task, account)
                    elif task_type == "verify_session":
                        await handle_verify_session(task, account)
                    elif task_type == "spambot_check":
                        # Handle spambot check
                        client = await get_or_create_client(account)
                        if client:
                            try:
                                spambot = await client.get_entity("@SpamBot")
                                await client.send_message(spambot, "/start")
                                await asyncio.sleep(2)
                                async for msg in client.iter_messages(spambot, limit=1):
                                    await report_result("spambot_check", {
                                        "task_id": task.get("task_id"),
                                        "account_id": account.get("id"),
                                        "success": True,
                                        "response": msg.text
                                    })
                            except Exception as e:
                                await report_result("spambot_check", {
                                    "task_id": task.get("task_id"),
                                    "success": False,
                                    "error": str(e)
                                })
                except Exception as e:
                    print(f"  [ERROR] Other task {task.get('task', '?')}: {e}")
            
            # Small delay between batches
            if delay_after > 0:
                await asyncio.sleep(delay_after)
                
        except asyncio.CancelledError:
            print("  [STOP] Runner cancelled")
            break
        except Exception as e:
            consecutive_errors += 1
            backoff = min(30, 2 ** consecutive_errors)
            print(f"  [ERROR] Main loop (attempt {consecutive_errors}): {e}")
            print(f"  [RETRY] Waiting {backoff}s before retry...")
            await asyncio.sleep(backoff)
    
    await shutdown_all()


# ========== ENTRY POINT ==========
if __name__ == "__main__":
    print()
    print("  Install dependencies: pip install telethon httpx pysocks")
    print()
    
    restart_count = 0
    MAX_RESTARTS = 100  # Allow many restarts before giving up
    
    while restart_count < MAX_RESTARTS:
        try:
            asyncio.run(main_loop())
            break  # Clean exit
        except KeyboardInterrupt:
            print("\\n  Goodbye!")
            break
        except Exception as e:
            restart_count += 1
            backoff = min(60, 5 * restart_count)
            print(f"\\n  [CRASH #{restart_count}] {e}")
            print(f"  Restarting in {backoff} seconds...")
            import time
            time.sleep(backoff)
    
    if restart_count >= MAX_RESTARTS:
        print(f"\\n  [FATAL] Too many crashes ({MAX_RESTARTS}). Exiting.")
        sys.exit(1)
`;

  const unifiedRunBat = `@echo off
title TelegramCRM - Unified Runner
color 0A

echo.
echo  ================================================
echo     TelegramCRM - Unified Single Runner
echo  ================================================
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx pysocks --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting Unified Runner...
echo.

py unified_runner.py
if errorlevel 1 (
    python unified_runner.py
)

pause
`;

  const unifiedRequirementsTxt = `telethon>=1.34.0
httpx>=0.27.0
pysocks>=1.7.1
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

  const downloadUnifiedZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm_unified");
    
    // Unified runner files
    folder?.file("config.py", unifiedConfigPy);
    folder?.file("fingerprint_generator.py", unifiedFingerprintPy);
    folder?.file("db_utils.py", unifiedDbUtilsPy);
    folder?.file("telegram_utils.py", unifiedTelegramUtilsPy);
    folder?.file("unified_runner.py", unifiedRunnerPy);
    folder?.file("requirements.txt", unifiedRequirementsTxt);
    folder?.file("RUN.bat", unifiedRunBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm_unified.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("Unified Runner ZIP downloaded! 7 files included.");
  };


  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python files to run on your PC"
          icon={BookOpen}
        />

        {/* Unified Runner - Primary Option */}
        <Card className="border-2 border-primary">
          <CardContent className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-primary/10 text-primary rounded-full text-sm font-medium mb-2">
                ⭐ Recommended
              </div>
              <h2 className="text-2xl font-bold">Unified Single Runner</h2>
              <p className="text-muted-foreground">
                One Python file that handles everything: Campaigns, LiveChat, Account Management
              </p>
            </div>

            <Button size="lg" onClick={downloadUnifiedZip} className="gap-2 text-lg px-8 py-6">
              <Download className="h-6 w-6" />
              Download Unified Runner
            </Button>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">📁 Files included (7 total):</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                <li><code className="text-green-600 dark:text-green-400">RUN.bat</code> - <strong>Double-click to START</strong></li>
                <li><code className="text-primary">unified_runner.py</code> - <strong>Single file for ALL operations</strong></li>
                <li><code>config.py</code> - Backend settings</li>
                <li><code>fingerprint_generator.py</code> - Device fingerprints</li>
                <li><code>db_utils.py</code> - Database utilities (proxy/fingerprint fetch)</li>
                <li><code>telegram_utils.py</code> - Telegram helper functions</li>
                <li><code>requirements.txt</code> - Dependencies</li>
              </ul>
            </div>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">🔒 Safety Features:</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                <li><strong>Never runs session without proxy</strong> - Fetches from DB if missing</li>
                <li><strong>Never runs session without fingerprint</strong> - Generates and saves if missing</li>
                <li><strong>Session verification</strong> - Checks if session is expired/banned</li>
                <li><strong>Contacts-only filter</strong> - LiveChat only receives from contacts</li>
                <li><strong>Picture support</strong> - Send/receive images in LiveChat</li>
                <li><strong>Batch limits</strong> - 10 photos, 100 names per batch</li>
                <li><strong>No stagger/delay</strong> - Campaigns run immediately</li>
                <li><strong>Profile sync</strong> - Sync profile data from Telegram</li>
                <li><strong>Logout other sessions</strong> - Remove other active sessions</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Multi-Runner - Secondary Option */}
        <Card>
          <CardContent className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Multi-Runner (Legacy)</h2>
              <p className="text-muted-foreground">
                5 separate runners + 1 BAT file to run them all
              </p>
            </div>

            <Button size="lg" variant="outline" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
              <Download className="h-6 w-6" />
              Download Multi-Runner ZIP
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
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
