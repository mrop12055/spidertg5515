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
import { UnifiedLogConsole } from '@/components/setup/UnifiedLogConsole';

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

  // ========== 2. CLIENT_MANAGER.PY (Optimized for Speed) ==========
  const clientManagerPy = `"""
TelegramCRM - Client Manager (Optimized)
Fast connections with retry logic, timeouts, and proxy support
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

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")
active_clients: Dict[str, TelegramClient] = {}

# Speed settings
CONNECTION_TIMEOUT = 30
CONNECTION_RETRIES = 3
RETRY_DELAY = 2


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
    for attempt in range(1, max_retries + 1):
        try:
            await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
            return True
        except asyncio.TimeoutError:
            print(f"    [TIMEOUT] Attempt {attempt}/{max_retries}")
            if attempt < max_retries:
                await asyncio.sleep(RETRY_DELAY * attempt)
        except Exception as e:
            print(f"    [ERROR] Attempt {attempt}/{max_retries}: {e}")
            if attempt < max_retries:
                await asyncio.sleep(RETRY_DELAY * attempt)
    return False


async def get_or_create_client(account: dict, setup_handler=None, task_proxy: dict = None) -> Optional[TelegramClient]:
    account_id = account["id"]
    
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                if setup_handler and not getattr(client, "_handler", False):
                    await setup_handler(client, account_id)
                    setattr(client, "_handler", True)
                return client
        except:
            del active_clients[account_id]
    
    session_data = account.get("session_data")
    if not session_data:
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version") or "10.14.2"
    lang_code = account.get("lang_code") or "en"
    system_lang_code = account.get("system_lang_code") or "en-US"
    
    if not device_model or not system_version:
        fp = generate_fingerprint()
        device_model = fp["device_model"]
        system_version = fp["system_version"]
        app_version = fp["app_version"]
        lang_code = fp["lang_code"]
        system_lang_code = fp["system_lang_code"]
        print(f"  [FP] Generated: {device_model} ({system_version})")
        await report_result("fingerprint_generated", {
            "account_id": account_id,
            "device_model": device_model,
            "system_version": system_version,
            "app_version": app_version,
            "lang_code": lang_code,
            "system_lang_code": system_lang_code
        })
    
    proxy = get_proxy_settings(account, task_proxy=task_proxy)
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
            connection_retries=CONNECTION_RETRIES,
            retry_delay=RETRY_DELAY,
            auto_reconnect=True,
            request_retries=3
        )
        
        print(f"  [CONNECT] {account['phone_number']}...")
        if not await connect_with_retry(client):
            print(f"  [FAIL] Timeout: {account['phone_number']}")
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Connection timeout"})
            return None
        
        if not await client.is_user_authorized():
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        # Check if account is deleted/banned
        try:
            me = await asyncio.wait_for(client.get_me(), timeout=15)
            if not me:
                print(f"  [BANNED] Account deleted: {account['phone_number']}")
                await report_result("account_banned", {"account_id": account_id, "reason": "Account deleted"})
                return None
        except Exception as me_err:
            err_str = str(me_err).lower()
            if any(x in err_str for x in ["deleted", "deactivated", "banned", "user_deactivated"]):
                print(f"  [BANNED] {account['phone_number']}: {me_err}")
                await report_result("account_banned", {"account_id": account_id, "reason": str(me_err)})
                return None
            elif any(x in err_str for x in ["session", "revoked", "auth"]):
                print(f"  [EXPIRED] {account['phone_number']}: {me_err}")
                await report_result("account_disconnected", {"account_id": account_id, "reason": str(me_err)})
                return None
        
        if setup_handler:
            await setup_handler(client, account_id)
            setattr(client, "_handler", True)
        
        active_clients[account_id] = client
        
        # Fast mode: skip profile if cached
        if account.get("first_name") or account.get("username"):
            await report_result("account_connected", {"account_id": account_id, "skip_profile_update": True})
        else:
            if me:
                await report_result("account_connected", {
                    "account_id": account_id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username,
                    "telegram_id": me.id,
                    "phone": me.phone
                })
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
    except Exception as e:
        err_str = str(e).lower()
        if any(x in err_str for x in ["deleted", "deactivated", "banned"]):
            print(f"  [BANNED] {account['phone_number']}: {e}")
            await report_result("account_banned", {"account_id": account_id, "reason": str(e)})
        else:
            print(f"  [FAIL] {account['phone_number']}: {e}")
        return None


async def get_next_task(runner: str = None) -> dict:
    try:
        body = {"runner": runner} if runner else {}
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body
            )
            return resp.json()
    except:
        return {"task": "wait", "seconds": 1}


async def get_batch_tasks(runner: str = None, batch_size: int = 50) -> dict:
    """Fetch a batch of tasks for parallel processing."""
    try:
        body = {"runner": runner, "batch_size": batch_size}
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-batch-tasks",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body
            )
            return resp.json()
    except Exception as e:
        print(f"  [ERROR] get_batch_tasks: {e}")
        return {"tasks": [], "delay_after": 7}


async def report_result(task_type: str, result: dict):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{BACKEND_URL}/report-task-result",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={"task_type": task_type, "result": result}
            )
    except:
        pass


async def send_message(client: TelegramClient, recipient: str, content: str, media_url: str = None):
    try:
        entity = None
        if recipient.startswith("@"):
            entity = await asyncio.wait_for(client.get_entity(recipient), timeout=15)
        else:
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            
            phone = recipient if recipient.startswith("+") else "+" + recipient
            try:
                entity = await asyncio.wait_for(client.get_entity(phone), timeout=10)
            except:
                pass
            
            if not entity:
                contact = InputPhoneContact(client_id=random.randint(0, 2**62), phone=phone, first_name="TG", last_name=str(random.randint(1000, 9999)))
                result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
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
                async with httpx.AsyncClient(timeout=30) as http:
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
                            timeout=30
                        )
                    else:
                        await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
            except Exception as media_err:
                print(f"  [MEDIA ERROR] {media_err}")
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
        else:
            await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
        
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


async def shutdown_all():
    print("\\n[SHUTDOWN] Disconnecting...")
    for account_id, client in list(active_clients.items()):
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except:
            pass
    active_clients.clear()
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
  const campaignRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (PARALLEL BATCH MODE)
=====================================================
Handles campaign messages with PARALLEL execution across multiple accounts.
Polls server every 7 seconds. RUNS FOREVER with auto-restart.

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, disconnect_batch
)

# ========== GLOBAL STATE ==========
RUNNING = True
DEFAULT_POLL_INTERVAL = 3  # Default polling (server can override)


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def process_single_task(task: dict, stagger_min: float, stagger_max: float) -> dict:
    """Process a single campaign send task - fully isolated"""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    account = task.get("account", {})
    proxy = task.get("proxy")
    content = msg.get("content", "")

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
        client = await get_or_create_client(account, task_proxy=proxy)
        if not client:
            print(f"    ✗ [{account_phone}] No client")
            return {
                "success": False,
                "error": "Could not connect client",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account_id,
            }

        # Server-controlled stagger
        stagger = random.uniform(stagger_min, stagger_max)
        await asyncio.sleep(stagger)
        print(f"  📨 [{account_phone}] → {recipient}")

        send_res = await send_message(client, recipient, content, msg.get("media_url"))
        if isinstance(send_res, tuple) and len(send_res) == 2:
            success, error = send_res
        elif isinstance(send_res, tuple) and len(send_res) == 3:
            success, error, _meta = send_res
        else:
            success, error = False, f"Unexpected send_message return: {type(send_res)}"

        is_privacy_error = error and any(x in error.lower() for x in [
            "privacyrestricted", "privacy restricted", "userprivacyrestricted"
        ])

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
        }

        if is_privacy_error:
            result["skip_account"] = True
            result["retry_with_different_account"] = True
            print(f"    ⚠ [{account_phone}] Privacy restricted")
        elif success:
            print(f"    ✓ [{account_phone}] Sent")
        else:
            print(f"    ✗ [{account_phone}] {error}")

        return result

    except Exception as e:
        print(f"    ✗ [{account_phone}] Error: {str(e)[:50]}")
        return {
            "success": False,
            "error": str(e),
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"),
            "account_id": account_id,
        }


async def main_loop():
    """Main campaign loop - RUNS FOREVER with server-controlled speed"""
    global RUNNING

    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Server-Controlled Speed)")
    print("=" * 60)
    print("  🚀 Speed settings from admin dashboard")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\\n✓ Starting campaign runner...\\n")

    consecutive_empty = 0

    while RUNNING:
        try:
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            
            # Get server-controlled speed settings
            stagger_min = batch_result.get("stagger_min", 0.3)
            stagger_max = batch_result.get("stagger_max", 1.5)
            delay_after = batch_result.get("delay_after", DEFAULT_POLL_INTERVAL)
            more_pending = batch_result.get("more_pending", False)

            if batch_result.get("stop_signal"):
                print("[STOP] Campaign paused from dashboard. Stopping...")
                break

            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    reason = batch_result.get("reason", "")
                    print(f"  [WAIT] {reason or 'No pending campaign tasks, waiting...'}")
                elif consecutive_empty % 10 == 0:
                    print("  [WAIT] Still waiting for campaign tasks...")
                await asyncio.sleep(delay_after if delay_after > 0 else DEFAULT_POLL_INTERVAL)
                continue

            consecutive_empty = 0
            print(f"\\n  [BATCH] Processing {len(tasks)} messages (stagger: {stagger_min:.1f}-{stagger_max:.1f}s)...")

            results = await asyncio.gather(
                *[process_single_task(task, stagger_min, stagger_max) for task in tasks],
                return_exceptions=True
            )

            success_count = 0
            for result in results:
                if isinstance(result, Exception):
                    print(f"  ⚠ Task exception: {result}")
                    continue
                if result.get("success"):
                    success_count += 1
                await report_result("send", result)

            fail_count = len(results) - success_count
            print(f"  [RESULT] Batch complete: {success_count} success, {fail_count} failed")

            # IMPORTANT: Disconnect batch clients to avoid memory/connection buildup
            batch_account_ids = list({
                (t.get("account") or {}).get("id")
                for t in tasks
                if (t.get("account") or {}).get("id")
            })
            if batch_account_ids:
                await disconnect_batch(batch_account_ids)

            # Use server-controlled delay (can be 0 for immediate repoll if more pending)
            if RUNNING and delay_after > 0:
                print(f"  [WAIT] Next batch in {delay_after}s...")
                await asyncio.sleep(delay_after)
            elif RUNNING and more_pending:
                print("  [FAST] More pending, immediate repoll...")

        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(DEFAULT_POLL_INTERVAL)

    print("\\n[STOP] Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Campaign Runner - Server-Controlled Speed")
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

  // ========== 5. LIVECHAT_RUNNER.PY ==========
  const livechatRunnerPy = `#!/usr/bin/env python3
"""
LiveChat Runner - Handles incoming messages and live chat replies
"""
import asyncio
import signal
import base64
import time

import httpx
from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all
)
from config import SUPABASE_URL, SUPABASE_KEY
from urllib.parse import urlparse

# Ensure we always get the *origin* (e.g. https://xxxx.supabase.co)
_u = urlparse(SUPABASE_URL)
SUPABASE_URL_BASE = f"{_u.scheme}://{_u.netloc}" if _u.scheme and _u.netloc else SUPABASE_URL.rstrip("/")

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_conversation_exists(account_id: str, sender_id: int, sender_username: str = None, sender_phone: str = None) -> bool:
    """Multi-strategy matching: telegram_id -> username -> phone"""
    import re
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
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
            
            # Multi-strategy conversation check
            conversation_exists = await check_conversation_exists(account_id, sender.id, sender_username, sender_phone)
            if not conversation_exists:
                # Rate-limited logging for ignored messages
                if not hasattr(handler, '_ignored_log') or time.time() - handler._ignored_log.get(sender.id, 0) > 60:
                    if not hasattr(handler, '_ignored_log'):
                        handler._ignored_log = {}
                    handler._ignored_log[sender.id] = time.time()
                    print(f"    [IGNORED] {sender_name} (id={sender.id}): no campaign conversation")
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
                        
                        async with httpx.AsyncClient(timeout=30.0) as http:
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
            print(f"  [WARN] Handler error: {e}")


async def main_loop():
    print("=" * 50)
    print("  LiveChat Runner")
    print("  [Incoming + Replies]")
    print("=" * 50)
    
    connected_ids = set()  # Track connected accounts to avoid redundant work
    
    while RUNNING:
        try:
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                # Only connect NEW accounts (skip already connected)
                new_accounts = [acc for acc in accounts if acc.get("id") not in connected_ids]
                if new_accounts:
                    # Connect in parallel for speed
                    results = await asyncio.gather(
                        *[get_or_create_client(acc, setup_handler=setup_message_handler) for acc in new_accounts],
                        return_exceptions=True
                    )
                    for acc in new_accounts:
                        if acc.get("id"):
                            connected_ids.add(acc["id"])
                # No artificial delay - server returns seconds=0 for instant polling
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    print(f"  [REPLY] To {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "account_id": account.get("id")
                    })
        
        except Exception as e:
            print(f"  [ERROR] {e}")
            await asyncio.sleep(0.5)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\nStopped.")
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

from client_manager import (
    get_or_create_client, get_next_task, report_result, shutdown_all, 
    validate_contact, SESSION_FOLDER
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


async def main_loop():
    print("=" * 50)
    print("  Account Runner")
    print("  [SpamBot, Name, Photo, Privacy, Import]")
    print("=" * 50)
    
    while RUNNING:
        try:
            task = await get_next_task(runner="account")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 2))
            
            elif task_type == "spambot_check":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [SPAM] Checking {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
                    print(f"    Result: {status}")
            
            elif task_type == "contact_import":
                account = task.get("account", {})
                task_id = task.get("task_id")
                phone_numbers = task.get("phone_numbers", [])
                valid_numbers = list(task.get("valid_numbers", []))
                invalid_numbers = list(task.get("invalid_numbers", []))
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  [IMPORT] Validating {len(phone_numbers)} contacts...")
                    for phone in phone_numbers:
                        if not RUNNING:
                            break
                        try:
                            exists, name, telegram_id = await validate_contact(client, phone)
                            if exists:
                                valid_numbers.append(phone)
                                print(f"    + {phone} valid")
                            else:
                                invalid_numbers.append(phone)
                                print(f"    - {phone} invalid")
                        except Exception as e:
                            err = str(e).lower()
                            if "flood" in err or "restricted" in err or "banned" in err:
                                remaining = [p for p in phone_numbers if p not in valid_numbers and p not in invalid_numbers]
                                await report_result("contact_import", {
                                    "task_id": task_id,
                                    "success": False,
                                    "account_failed": True,
                                    "failed_account_id": account.get("id"),
                                    "remaining_numbers": remaining,
                                    "valid_numbers": valid_numbers,
                                    "invalid_numbers": invalid_numbers,
                                    "error": str(e)
                                })
                                print(f"  [WARN] Account restricted, switching...")
                                break
                            invalid_numbers.append(phone)
                    else:
                        await report_result("contact_import", {
                            "task_id": task_id,
                            "success": True,
                            "valid_numbers": valid_numbers,
                            "invalid_numbers": invalid_numbers
                        })
                        print(f"  [OK] Import: {len(valid_numbers)} valid, {len(invalid_numbers)} invalid")
            
            elif task_type == "change_name":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [NAME] Changing...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
            
            elif task_type == "change_photo":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PHOTO] Changing...")
                    # Support both photo_url and photo_base64
                    photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
                    success, error = await change_profile_photo(client, photo_source)
                    await report_result("change_photo", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "privacy_settings":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PRIVACY] Updating...")
                    success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                    await report_result("privacy_settings", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "change_password":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PASS] Changing...")
                    success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                    await report_result("change_password", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "logout_sessions":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [LOGOUT] Logging out other sessions...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "verify_session":
                account = task.get("account", {})
                print(f"  [VERIFY] Checking {account.get('phone_number')}...")
                try:
                    client = await get_or_create_client(account)
                    if client:
                        status, error, user_data = await verify_session(client, account.get("id"))
                        await report_result("verify_session", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "error": error, "user_data": user_data})
                        print(f"    Status: {status}" + (f" ({error})" if error else ""))
                    else:
                        await report_result("verify_session", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": "disconnected", "error": "Could not connect"})
                        print(f"    Could not connect")
                except Exception as e:
                    await report_result("verify_session", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": "disconnected", "error": str(e)})
                    print(f"    Error: {e}")
            
            elif task_type == "sync_profile":
                account = task.get("account", {})
                print(f"  [SYNC] Syncing profile for {account.get('phone_number')}...")
                try:
                    client = await get_or_create_client(account)
                    if client:
                        me = await client.get_me()
                        if me:
                            # Get profile photo if available
                            avatar_url = None
                            try:
                                photos = await client.get_profile_photos("me", limit=1)
                                if photos:
                                    # Download to bytes and encode
                                    photo_bytes = await client.download_media(photos[0], bytes)
                                    if photo_bytes:
                                        avatar_url = f"data:image/jpeg;base64,{base64.b64encode(photo_bytes).decode()}"
                            except:
                                pass
                            
                            await report_result("sync_profile", {
                                "task_id": task.get("task_id"),
                                "account_id": account.get("id"),
                                "success": True,
                                "first_name": me.first_name,
                                "last_name": me.last_name or "",
                                "username": me.username,
                                "telegram_id": me.id,
                                "avatar_url": avatar_url
                            })
                            print(f"    Synced: {me.first_name} {me.last_name or ''}")
                        else:
                            await report_result("sync_profile", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": False, "error": "Could not get user info"})
                    else:
                        await report_result("sync_profile", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": False, "error": "Could not connect"})
                except Exception as e:
                    await report_result("sync_profile", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": False, "error": str(e)})
                    print(f"    Error: {e}")
        
        except Exception as e:
            print(f"  [ERROR] {e}")
            await asyncio.sleep(1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx aiohttp\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\nStopped.")
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

start "LiveChat Runner" cmd /k "title LiveChat Runner && color 0D && py livechat_runner.py"
timeout /t 1 /nobreak >nul

start "Account Runner" cmd /k "title Account Runner && color 0E && py account_runner.py"
timeout /t 1 /nobreak >nul

start "Warmup Runner" cmd /k "title Warmup Runner && color 0A && py warmup_runner.py"

echo.
echo  ================================================
echo     All 4 runners started!
echo  ================================================
echo.
echo     Blue   = Campaign Runner
echo     Purple = LiveChat Runner  
echo     Yellow = Account Runner
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

  // ========== VPS AGENT ==========
  const generateVpsApiKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'vps_';
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
from datetime import datetime, timezone
from typing import Dict, Optional

import httpx

# Configuration
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
VPS_API_KEY = "REPLACE_WITH_YOUR_VPS_KEY"  # Will be set on first run

# Runner definitions
RUNNERS = {
    "campaign": "campaign_runner.py",
    "livechat": "livechat_runner.py",
    "account": "account_runner.py",
    "warmup": "warmup_runner.py",
}

# Global state
RUNNING = True
processes: Dict[str, subprocess.Popen] = {}
vps_id: Optional[str] = None

POLL_INTERVAL = 5
HEARTBEAT_INTERVAL = 10


def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


async def register_vps(client: httpx.AsyncClient) -> Optional[str]:
    global vps_id
    
    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers=get_headers(),
        params={"api_key": f"eq.{VPS_API_KEY}", "select": "id"}
    )
    
    if resp.status_code == 200 and resp.json():
        vps_id = resp.json()[0]["id"]
        print(f"[VPS] Connected: {vps_id[:8]}...")
        return vps_id
    
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
        print(f"[VPS] Registered: {vps_id[:8]}...")
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
    if not vps_id:
        return
    
    await client.patch(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers=get_headers(),
        params={"id": f"eq.{vps_id}"},
        json={
            "status": "online",
            "last_seen": datetime.now(timezone.utc).isoformat(),
        }
    )


async def send_log(client: httpx.AsyncClient, runner: str, level: str, message: str):
    if not vps_id:
        return
    
    await client.post(
        f"{SUPABASE_URL}/rest/v1/vps_logs",
        headers=get_headers(),
        json={
            "vps_id": vps_id,
            "runner_name": runner,
            "log_level": level,
            "message": message[:500],
        }
    )


async def poll_commands(client: httpx.AsyncClient) -> list:
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
    await client.patch(
        f"{SUPABASE_URL}/rest/v1/vps_commands",
        headers=get_headers(),
        params={"id": f"eq.{cmd_id}"},
        json={
            "status": status,
            "result": result,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
    )


async def fetch_single_script(client: httpx.AsyncClient, script_name: str) -> bool:
    """Fetch a single script from storage and overwrite local copy."""
    try:
        resp = await client.get(
            f"{SUPABASE_URL}/storage/v1/object/public/python-scripts/{script_name}",
            timeout=30
        )
        if resp.status_code == 200:
            with open(script_name, 'wb') as f:
                f.write(resp.content)
            print(f"[SYNC] Updated: {script_name}")
            return True
        else:
            print(f"[SYNC] {script_name} not in storage (using local)")
            return False
    except Exception as e:
        print(f"[SYNC] Failed to fetch {script_name}: {e}")
        return False


async def fetch_scripts_from_zip(client: httpx.AsyncClient, target_scripts: list = None) -> bool:
    """Fetch runners.zip and extract scripts. If target_scripts provided, only extract those."""
    try:
        resp = await client.get(
            f"{SUPABASE_URL}/storage/v1/object/public/python-scripts/runners.zip",
            timeout=60
        )
        
        if resp.status_code != 200:
            print(f"[SYNC] No runners.zip in storage (using local scripts)")
            return False
        
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            for info in zf.infolist():
                if info.filename.endswith('.py') and not info.filename.startswith('__'):
                    target_path = os.path.basename(info.filename)
                    # Skip protected files
                    if target_path in ['vps_agent.py', 'config.py']:
                        continue
                    # If filtering, only extract requested scripts
                    if target_scripts and target_path not in target_scripts:
                        continue
                    with zf.open(info) as source:
                        with open(target_path, 'wb') as target:
                            target.write(source.read())
                    print(f"[SYNC] Extracted: {target_path}")
        return True
    except Exception as e:
        print(f"[SYNC] ZIP fetch failed: {e}")
        return False


def start_runner_sync(name: str) -> bool:
    """Start runner without fetching (internal use after sync)."""
    if name in processes and processes[name].poll() is None:
        print(f"[RUNNER] {name} already running")
        return False
    
    script = RUNNERS.get(name)
    if not script or not os.path.exists(script):
        print(f"[ERROR] Script not found: {script}")
        return False
    
    try:
        proc = subprocess.Popen(
            [sys.executable, script],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=os.path.dirname(os.path.abspath(__file__)) or ".",
        )
        processes[name] = proc
        print(f"[RUNNER] Started {name} (PID: {proc.pid})")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to start {name}: {e}")
        return False


async def start_runner(client: httpx.AsyncClient, name: str) -> bool:
    """Stop old runner, fetch latest script, then start."""
    # Stop existing instance first
    stop_runner(name)
    
    # Fetch latest script from storage
    script = RUNNERS.get(name)
    if script:
        await fetch_scripts_from_zip(client, [script])
    
    return start_runner_sync(name)


def stop_runner(name: str) -> bool:
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


async def start_all(client: httpx.AsyncClient):
    """Stop all, fetch all scripts, start all."""
    stop_all()
    await fetch_scripts_from_zip(client)
    results = []
    for name in RUNNERS:
        if start_runner_sync(name):
            results.append(name)
    return results


def stop_all():
    results = []
    for name in list(processes.keys()):
        if stop_runner(name):
            results.append(name)
    return results


async def restart_all(client: httpx.AsyncClient):
    stop_all()
    return await start_all(client)


async def process_command(client: httpx.AsyncClient, cmd: dict):
    cmd_id = cmd["id"]
    command = cmd["command"]
    target = cmd.get("target_runner")
    
    print(f"[CMD] Processing: {command}" + (f" ({target})" if target else ""))
    
    await update_command(client, cmd_id, "processing")
    
    try:
        result = ""
        
        if command == "start_all":
            started = await start_all(client)
            result = f"Started: {', '.join(started) if started else 'none'}"
            
        elif command == "stop_all":
            stopped = stop_all()
            result = f"Stopped: {', '.join(stopped) if stopped else 'none'}"
            
        elif command == "restart_all":
            restarted = await restart_all(client)
            result = f"Restarted: {', '.join(restarted) if restarted else 'none'}"
            
        elif command == "start_runner" and target:
            if await start_runner(client, target):
                result = f"Started {target}"
            else:
                result = f"Failed to start {target}"
                
        elif command == "stop_runner" and target:
            if stop_runner(target):
                result = f"Stopped {target}"
            else:
                result = f"{target} was not running"
                
        elif command == "update":
            if await fetch_scripts_from_zip(client):
                result = "Scripts updated (use Start All to run new versions)"
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
    for name, proc in list(processes.items()):
        if proc.poll() is not None:
            exit_code = proc.returncode
            await send_log(client, name, "warning", f"Process exited with code {exit_code}, restarting...")
            del processes[name]
            start_runner_sync(name)


async def main_loop():
    global RUNNING
    
    print("=" * 50)
    print("  TelegramCRM VPS Agent")
    print("=" * 50)
    
    async with httpx.AsyncClient() as client:
        if not await register_vps(client):
            print("[FATAL] Could not register VPS")
            return
        
        await send_log(client, "agent", "info", "VPS Agent started")
        
        last_heartbeat = 0
        
        while RUNNING:
            try:
                now = asyncio.get_event_loop().time()
                
                if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                    await send_heartbeat(client)
                    last_heartbeat = now
                
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
    
    // Individual runners
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("livechat_runner.py", livechatRunnerPy);
    folder?.file("account_runner.py", accountRunnerPy);
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
    
    // Individual runners
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("livechat_runner.py", livechatRunnerPy);
    folder?.file("account_runner.py", accountRunnerPy);
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

  // Auto-sync scripts to storage on page load
  React.useEffect(() => {
    const syncScriptsToStorage = async () => {
      try {
        const zip = new JSZip();
        zip.file("campaign_runner.py", campaignRunnerPy);
        zip.file("livechat_runner.py", livechatRunnerPy);
        zip.file("account_runner.py", accountRunnerPy);
        zip.file("warmup_runner.py", warmupRunnerPy);
        zip.file("client_manager.py", clientManagerPy);
        zip.file("fingerprint_generator.py", fingerprintGeneratorPy);
        
        const blob = await zip.generateAsync({ type: "blob" });
        
        await supabase.storage
          .from('python-scripts')
          .upload('runners.zip', blob, { 
            upsert: true,
            contentType: 'application/zip'
          });
        
        console.log('[Auto-Sync] Scripts synced to storage');
      } catch (error) {
        console.error('[Auto-Sync] Failed to sync scripts:', error);
      }
    };
    
    syncScriptsToStorage();
  }, [campaignRunnerPy, livechatRunnerPy, accountRunnerPy, warmupRunnerPy, clientManagerPy, fingerprintGeneratorPy]);

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
                    4 separate runners + 1 BAT file to run them all
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
                    <li><code className="text-blue-500">campaign_runner.py</code> - Send messages + validation</li>
                    <li><code className="text-purple-500">livechat_runner.py</code> - Incoming messages + replies</li>
                    <li><code className="text-yellow-500">account_runner.py</code> - SpamBot, name, photo, privacy, import</li>
                    <li><code className="text-orange-500">warmup_runner.py</code> - Warmup chat (pairs) + join/view/react/bio</li>
                    <li><code>config.py</code> - Backend settings</li>
                    <li><code>client_manager.py</code> - Shared Telegram logic</li>
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

              {/* Unified Live Log Console */}
              <UnifiedLogConsole />

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

              {/* Auto-Sync Info */}
              <Card className="border-blue-500/30 bg-blue-500/5">
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    <RefreshCw className="h-5 w-5 text-blue-500 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-blue-600 dark:text-blue-400">Auto-Sync Enabled</p>
                      <p className="text-xs text-muted-foreground">
                        Scripts automatically sync to storage when you open this page. When you click "Start All" or start any runner, 
                        the VPS fetches the latest scripts, stops old processes, and runs the new version.
                      </p>
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
