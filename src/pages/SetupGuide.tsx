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
    get_or_create_client, report_result, shutdown_all,
    validate_contact, SESSION_FOLDER, SUPABASE_KEY, BACKEND_URL
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

async def disconnect_client(account_id: str, phone: str = None):
    """Disconnect and remove client from cache to free session file for LiveChat runner."""
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


  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python files to run on your PC"
          icon={BookOpen}
        />

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
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
