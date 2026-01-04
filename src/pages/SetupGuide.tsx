import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, CheckCircle2, XCircle, Loader2, Send, MessageSquare, UserCog, Flame, Ban } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { supabase } from '@/integrations/supabase/client';

interface RunnerStatus {
  name: string;
  icon: React.ReactNode;
  color: string;
  functions: string[];
  runnerKey: string;
  lastSeen: Date | null;
  isOnline: boolean;
}

const SetupGuide: React.FC = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const [runnerStatuses, setRunnerStatuses] = useState<RunnerStatus[]>([
    {
      name: 'Campaign Runner',
      icon: <Send className="h-5 w-5" />,
      color: 'text-blue-500',
      functions: ['Send messages', 'Validate recipients'],
      runnerKey: 'campaign',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'LiveChat Runner',
      icon: <MessageSquare className="h-5 w-5" />,
      color: 'text-purple-500',
      functions: ['Incoming messages', 'Send replies'],
      runnerKey: 'livechat',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'Account Runner',
      icon: <UserCog className="h-5 w-5" />,
      color: 'text-yellow-500',
      functions: ['SpamBot', 'Name/Photo', 'Privacy', 'Import', 'Check Ban'],
      runnerKey: 'account',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'Warmup Runner',
      icon: <Flame className="h-5 w-5" />,
      color: 'text-orange-500',
      functions: ['Join channels', 'View content', 'Reactions'],
      runnerKey: 'warmup',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'Block Runner',
      icon: <Ban className="h-5 w-5" />,
      color: 'text-red-500',
      functions: ['Block contacts', 'Unblock contacts'],
      runnerKey: 'block',
      lastSeen: null,
      isOnline: false
    }
  ]);

  useEffect(() => {
    const checkRunnerStatus = async () => {
      try {
        const { data: heartbeats } = await supabase
          .from('runner_heartbeats')
          .select('runner_name, last_seen, status');
        
        const runnerMap = new Map<string, { lastSeen: Date; status: string }>();
        if (heartbeats) {
          for (const hb of heartbeats) {
            runnerMap.set(hb.runner_name, {
              lastSeen: new Date(hb.last_seen),
              status: hb.status || 'online'
            });
          }
        }
        
        const fifteenSecondsAgo = new Date(Date.now() - 15000);

        setRunnerStatuses(prev => prev.map(runner => {
          const heartbeat = runnerMap.get(runner.runnerKey);
          const isOnline = heartbeat ? heartbeat.lastSeen > fifteenSecondsAgo : false;
          return {
            ...runner,
            isOnline,
            lastSeen: heartbeat?.lastSeen || runner.lastSeen
          };
        }));
      } catch (error) {
        console.error('Error checking runner status:', error);
      }
    };

    checkRunnerStatus();
    const interval = setInterval(checkRunnerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

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


def get_proxy_settings(account: dict) -> Optional[tuple]:
    proxy = account.get("proxy")
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
    else:
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


async def get_or_create_client(account: dict, setup_handler=None) -> Optional[TelegramClient]:
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
    
    proxy = get_proxy_settings(account)
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


async def report_result(task_type: str, result: dict):
    asyncio.create_task(_report(task_type, result))


async def _report(task_type: str, result: dict):
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
        
        if media_url:
            try:
                async with httpx.AsyncClient(timeout=30) as http:
                    resp = await http.get(media_url)
                    if resp.status_code == 200:
                        await asyncio.wait_for(client.send_file(entity, resp.content, caption=content), timeout=30)
                    else:
                        await asyncio.wait_for(client.send_message(entity, content), timeout=15)
            except:
                await asyncio.wait_for(client.send_message(entity, content), timeout=15)
        else:
            await asyncio.wait_for(client.send_message(entity, content), timeout=15)
        
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
Campaign Runner - Handles campaign messages and recipient validation
"""
import asyncio
import signal

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, validate_contact, shutdown_all
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def main_loop():
    print("=" * 50)
    print("  Campaign Runner")
    print("  [Messages + Validation]")
    print("=" * 50)
    
    while RUNNING:
        try:
            task = await get_next_task(runner="campaign")
            task_type = task.get("task", "wait")
            
            if task.get("stop_signal"):
                await asyncio.sleep(5)
                continue
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc)
                await asyncio.sleep(task.get("seconds", 1))
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client and recipient:
                    print(f"  [SEND] To {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [VALIDATE] {len(recipients)} recipients...")
                    for r in recipients:
                        if not RUNNING:
                            break
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {"recipient_id": r["id"], "exists": exists, "name": name, "telegram_id": telegram_id})
        
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

SUPABASE_URL_BASE = SUPABASE_URL.replace("/functions/v1", "") if "/functions/v1" in SUPABASE_URL else SUPABASE_URL.rsplit("/", 1)[0]

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_conversation_exists(account_id: str, sender_id: int) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            response = await http.get(
                f"{SUPABASE_URL_BASE}/rest/v1/conversations",
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}"
                },
                params={
                    "account_id": f"eq.{account_id}",
                    "recipient_telegram_id": f"eq.{sender_id}",
                    "select": "id,first_message_sent"
                }
            )
            if response.status_code == 200:
                data = response.json()
                if data and len(data) > 0:
                    return data[0].get("first_message_sent", False)
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
            
            conversation_exists = await check_conversation_exists(account_id, sender.id)
            if not conversation_exists:
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
                        async with httpx.AsyncClient(timeout=30.0) as http:
                            upload_response = await http.post(
                                f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{file_path}",
                                headers={
                                    "apikey": SUPABASE_KEY,
                                    "Authorization": f"Bearer {SUPABASE_KEY}",
                                    "Content-Type": "image/jpeg"
                                },
                                content=photo_bytes
                            )
                            if upload_response.status_code in (200, 201):
                                media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{file_path}"
                                print(f"    [OK] Photo uploaded")
                            else:
                                print(f"    [WARN] Photo upload failed: {upload_response.status_code}")
                except Exception as e:
                    print(f"    [WARN] Could not upload photo: {e}")
            
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
            except:
                pass
            
            print(f"  [IN] From {sender.first_name or sender.id}: {content[:40]}...")
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                "sender_username": sender.username,
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
    
    while RUNNING:
        try:
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc, setup_handler=setup_message_handler)
                await asyncio.sleep(task.get("seconds", 0.1))
            
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
    """Check SpamBot - detects banned, frozen, restricted"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        response_lower = response.lower()
        
        # FROZEN state
        if "frozen" in response_lower or "заморожен" in response_lower:
            return "restricted", "Account frozen", response
        # BANNED state  
        if "banned" in response_lower or "deleted" in response_lower or "заблокирован" in response_lower:
            return "banned", response[:200], response
        # LIMITED state
        if "limited" in response_lower or "restricted" in response_lower or "ограничен" in response_lower:
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


async def change_profile_photo(client, photo_base64: str):
    try:
        from telethon.tl.functions.photos import UploadProfilePhotoRequest
        photo_bytes = base64.b64decode(photo_base64)
        temp_path = os.path.join(SESSION_FOLDER, "temp_photo.jpg")
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
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
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

  // ========== 7. WARMUP_RUNNER.PY ==========
  const warmupRunnerPy = `#!/usr/bin/env python3
"""
Warmup Runner - Handles join channels, view content, reactions, bio updates
"""
import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_next_task, report_result, shutdown_all
)

RUNNING = True
WARMUP_CHANNELS = ["telegram", "durov", "tginfo", "techcrunch"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😂", "🎉", "💯", "⭐"]

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


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
            await client(SendReactionRequest(
                peer=entity,
                msg_id=msg.id,
                reaction=[ReactionEmoji(emoticon=reaction)]
            ))
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


async def main_loop():
    print("=" * 50)
    print("  Warmup Runner")
    print("  [Join, View, React, Bio]")
    print("=" * 50)
    
    while RUNNING:
        try:
            task = await get_next_task(runner="warmup")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 2))
            
            elif task_type == "warmup_join_channel":
                account = task.get("account", {})
                channel = task.get("channel_username")
                client = await get_or_create_client(account)
                if client:
                    print(f"  [JOIN] Joining channel...")
                    success, channel_name, error = await join_channel(client, channel)
                    await report_result("warmup_complete", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": f"Joined @{channel_name}"
                    })
            
            elif task_type == "warmup_view_content":
                account = task.get("account", {})
                channel = task.get("channel_username")
                client = await get_or_create_client(account)
                if client:
                    print(f"  [VIEW] Viewing content...")
                    success, count, error = await view_channel_messages(client, channel)
                    await report_result("warmup_complete", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": f"Viewed {count} messages"
                    })
            
            elif task_type == "warmup_reaction":
                account = task.get("account", {})
                channel = task.get("channel_username")
                client = await get_or_create_client(account)
                if client:
                    print(f"  [REACT] Sending reaction...")
                    success, reaction, error = await send_reaction(client, channel)
                    await report_result("warmup_complete", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": f"Sent {reaction}" if reaction else "Failed"
                    })
            
            elif task_type == "warmup_update_bio":
                account = task.get("account", {})
                bio = task.get("bio")
                client = await get_or_create_client(account)
                if client:
                    print(f"  [BIO] Updating bio...")
                    success, error = await update_profile_bio(client, bio)
                    await report_result("warmup_complete", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": "Updated bio"
                    })
        
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
py -m pip install telethon httpx pysocks --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting 5 runners in parallel...
echo.

:: Start each runner in a new window
start "Campaign Runner" cmd /k "title Campaign Runner && color 0B && py campaign_runner.py"
timeout /t 1 /nobreak >nul

start "LiveChat Runner" cmd /k "title LiveChat Runner && color 0D && py livechat_runner.py"
timeout /t 1 /nobreak >nul

start "Account Runner" cmd /k "title Account Runner && color 0E && py account_runner.py"
timeout /t 1 /nobreak >nul

start "Warmup Runner" cmd /k "title Warmup Runner && color 0A && py warmup_runner.py"
timeout /t 1 /nobreak >nul

start "Block Runner" cmd /k "title Block Runner && color 0C && py block_runner.py"

echo.
echo  ================================================
echo     All 5 runners started!
echo  ================================================
echo.
echo     Blue   = Campaign Runner
echo     Purple = LiveChat Runner  
echo     Yellow = Account Runner
echo     Green  = Warmup Runner
echo     Red    = Block Runner
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
    folder?.file("block_runner.py", blockRunnerPy);
    
    // Single BAT to run all
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("ZIP downloaded! 10 files included.");
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python files and run on your PC"
        />

        <Card>
          <CardContent className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Download Python Files</h2>
              <p className="text-muted-foreground">
                5 separate runners + 1 BAT file to run them all
              </p>
            </div>

            <Button size="lg" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
              <Download className="h-6 w-6" />
              Download ZIP
            </Button>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">📁 Files included (10 total):</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                <li><code className="text-green-600 dark:text-green-400">RUN.bat</code> - <strong>Double-click to START all 5 runners</strong></li>
                <li><code className="text-blue-500">campaign_runner.py</code> - Send messages + validation</li>
                <li><code className="text-purple-500">livechat_runner.py</code> - Incoming messages + replies</li>
                <li><code className="text-yellow-500">account_runner.py</code> - SpamBot, name, photo, privacy, import</li>
                <li><code className="text-orange-500">warmup_runner.py</code> - Join channels, view, react, bio</li>
                <li><code className="text-red-500">block_runner.py</code> - Block/unblock contacts</li>
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
                <li>5 colored windows will open (one for each runner)</li>
                <li>To stop: Close all windows or press <kbd className="bg-background px-2 py-0.5 rounded border">Ctrl+C</kbd></li>
              </ol>
            </div>
          </CardContent>
        </Card>

        {/* Runner Status Section */}
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">🖥️ Runner Status</h3>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Auto-refresh every 5s
              </div>
            </div>
            
            <div className="grid gap-3">
              {runnerStatuses.map((runner, index) => (
                <div 
                  key={index}
                  className={`border rounded-lg p-4 transition-all ${
                    runner.isOnline 
                      ? 'border-green-500/50 bg-green-500/5' 
                      : 'border-border bg-muted/30'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={runner.color}>
                        {runner.icon}
                      </div>
                      <div>
                        <p className="font-medium">{runner.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {runner.lastSeen 
                            ? `Last seen: ${runner.lastSeen.toLocaleTimeString()}`
                            : 'Not connected yet'
                          }
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {runner.isOnline ? (
                        <>
                          <span className="text-xs font-medium text-green-600 dark:text-green-400">LIVE</span>
                          <CheckCircle2 className="h-5 w-5 text-green-500" />
                        </>
                      ) : (
                        <>
                          <span className="text-xs font-medium text-muted-foreground">OFFLINE</span>
                          <XCircle className="h-5 w-5 text-muted-foreground" />
                        </>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {runner.functions.map((func, funcIndex) => (
                      <span 
                        key={funcIndex}
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          runner.isOnline
                            ? 'bg-green-500/20 text-green-700 dark:text-green-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {func}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="text-center pt-2">
              <p className="text-xs text-muted-foreground">
                💡 Run <code className="bg-muted px-1.5 py-0.5 rounded">RUN.bat</code> on your PC to connect all runners
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
