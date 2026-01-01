import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
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
SUPABASE_KEY = "${supabaseKey}"
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"
`;

  // ========== 2. CLIENT_MANAGER.PY ==========
  const clientManagerPy = `"""
TelegramCRM - Client Manager
Shared Telegram client logic
"""

import os
import base64
import tempfile
import asyncio
import httpx
from typing import Dict, Optional

from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH

SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")
active_clients: Dict[str, TelegramClient] = {}
handlers_attached: set = set()


def decode_session_file(phone_number: str, base64_data: str) -> Optional[str]:
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    try:
        session_bytes = base64.b64decode(base64_data)
        with open(session_path + ".session", "wb") as f:
            f.write(session_bytes)
        return session_path
    except Exception as e:
        print(f"  [ERROR] Session decode failed: {e}")
        return None


async def get_or_create_client(account: dict, setup_handler=None) -> Optional[TelegramClient]:
    account_id = account["id"]
    
    if account_id in active_clients:
        client = active_clients[account_id]
        if client.is_connected():
            if setup_handler and account_id not in handlers_attached:
                await setup_handler(client, account_id)
                handlers_attached.add(account_id)
            return client
    
    session_data = account.get("session_data")
    if not session_data:
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    try:
        client = TelegramClient(session_path, int(TELEGRAM_API_ID), TELEGRAM_API_HASH)
        await client.connect()
        
        if not await client.is_user_authorized():
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        if setup_handler:
            await setup_handler(client, account_id)
            handlers_attached.add(account_id)
        
        active_clients[account_id] = client
        
        me = await client.get_me()
        if me:
            avatar_base64 = None
            try:
                photos = await client.get_profile_photos(me, limit=1)
                if photos:
                    photo_bytes = await client.download_media(photos[0], file=bytes)
                    if photo_bytes:
                        avatar_base64 = base64.b64encode(photo_bytes).decode('utf-8')
            except:
                pass
            
            await report_result("account_connected", {
                "account_id": account_id,
                "first_name": me.first_name,
                "last_name": me.last_name,
                "username": me.username,
                "telegram_id": me.id,
                "phone": me.phone,
                "avatar_base64": avatar_base64
            })
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
    except Exception as e:
        print(f"  [ERROR] Connect failed: {e}")
        return None


async def get_next_task(runner: str = None) -> dict:
    try:
        body = {"runner": runner} if runner else {}
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body
            )
            return resp.json()
    except Exception as e:
        return {"task": "wait", "seconds": 1}


async def report_result(task_type: str, result: dict):
    asyncio.create_task(_report(task_type, result))


async def _report(task_type: str, result: dict):
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            await client.post(
                f"{BACKEND_URL}/report-task-result",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={"task_type": task_type, "result": result}
            )
    except:
        pass


async def send_message(client: TelegramClient, recipient: str, content: str, media_url: str = None):
    try:
        if recipient.startswith("@"):
            entity = await client.get_entity(recipient)
        else:
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            contact = InputPhoneContact(client_id=random.randint(0, 2**31 - 1), phone=recipient, first_name="Contact", last_name="")
            result = await client(ImportContactsRequest([contact]))
            if result.users:
                entity = result.users[0]
            else:
                return False, "User not found on Telegram"
        await client.send_message(entity, content)
        return True, None
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
        result = await client(ImportContactsRequest([contact]))
        if result.users:
            user = result.users[0]
            return True, f"{user.first_name or ''} {user.last_name or ''}".strip(), user.id
        return False, None, None
    except:
        return False, None, None


async def shutdown_all():
    print("\\nShutting down...")
    for account_id, client in active_clients.items():
        try:
            await client.disconnect()
        except:
            pass
    print("Done.")
`;

  // ========== 3. CAMPAIGN_RUNNER.PY ==========
  const campaignRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner
Handles: Campaign messages, Recipient validation
Run: python campaign_runner.py
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
                    print(f"  Sending to {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    print(f"    {'OK' if success else 'FAIL: ' + str(error)}")
            
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  Validating {len(recipients)} recipients...")
                    for r in recipients:
                        if not RUNNING:
                            break
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {"recipient_id": r["id"], "exists": exists, "name": name, "telegram_id": telegram_id})
        
        except Exception as e:
            print(f"  Error: {e}")
            await asyncio.sleep(0.5)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\nStopped.")
`;

  // ========== 4. LIVECHAT_RUNNER.PY ==========
  const livechatRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Live Chat Runner
Handles: Incoming messages, Live chat replies
Run: python livechat_runner.py
"""

import asyncio
import signal

from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def setup_message_handler(client, account_id: str):
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                content = event.message.text or "[Media]"
                media_type = "image" if event.message.photo else None
                if event.message.photo:
                    content = "[Photo] " + (event.message.text or "")
                print(f"  From {sender.first_name or sender.id}: {content[:40]}...")
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "content": content,
                    "media_type": media_type
                })
        except Exception as e:
            print(f"  Handler error: {e}")


async def main_loop():
    print("=" * 50)
    print("  Live Chat Runner")
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
                    print(f"  Reply to {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "account_id": account.get("id")
                    })
        
        except Exception as e:
            print(f"  Error: {e}")
            await asyncio.sleep(0.5)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\nStopped.")
`;

  // ========== 5. ACCOUNT_RUNNER.PY ==========
  const accountRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Account Runner
Handles: SpamBot check, Name change, Photo change, Privacy, Password, Logout
Run: python account_runner.py
"""

import asyncio
import signal
import os
import base64

from client_manager import (
    get_or_create_client, get_next_task, report_result, shutdown_all, SESSION_FOLDER
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_spambot(client):
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(1)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        response_lower = response.lower()
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
        elif "limited" in response_lower or "restricted" in response_lower:
            return "restricted", None, response
        elif "banned" in response_lower:
            return "banned", response[:200], response
        return "active", None, response
    except Exception as e:
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


async def main_loop():
    print("=" * 50)
    print("  Account Runner")
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
                    print(f"  SpamBot check {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
                    print(f"    Result: {status}")
            
            elif task_type == "change_name":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  Changing name...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
            
            elif task_type == "change_photo":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  Changing photo...")
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
                    await report_result("change_photo", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "privacy_settings":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  Privacy settings...")
                    success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                    await report_result("privacy_settings", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "change_password":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  Password change...")
                    success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                    await report_result("change_password", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "logout_sessions":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  Logout sessions...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
        
        except Exception as e:
            print(f"  Error: {e}")
            await asyncio.sleep(1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\nStopped.")
`;

  // ========== 6. WARMUP_RUNNER.PY ==========
  const warmupRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner
Handles: Join channels, View content
Run: python warmup_runner.py
"""

import asyncio
import signal

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


async def warmup_join_channel(client):
    try:
        for channel in ["@telegram", "@durov"]:
            try:
                await client.get_entity(channel)
                await asyncio.sleep(1)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_view_content(client):
    try:
        dialogs = await client.get_dialogs(limit=5)
        for dialog in dialogs:
            try:
                await client.get_messages(dialog, limit=10)
                await asyncio.sleep(0.5)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


async def main_loop():
    print("=" * 50)
    print("  Warmup Runner")
    print("=" * 50)
    
    while RUNNING:
        try:
            task = await get_next_task(runner="warmup")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 5))
            
            elif task_type.startswith("warmup_"):
                account = task.get("account", {})
                warmup_type = task_type.replace("warmup_", "")
                client = await get_or_create_client(account)
                if client:
                    print(f"  {warmup_type} for {account.get('phone_number')}...")
                    if warmup_type == "join_channel":
                        success, error = await warmup_join_channel(client)
                    elif warmup_type == "view_content":
                        success, error = await warmup_view_content(client)
                    else:
                        success, error = True, None
                    await report_result(task_type, {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
        
        except Exception as e:
            print(f"  Error: {e}")
            await asyncio.sleep(1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\nStopped.")
`;

  // ========== 7. MAIN_RUNNER.PY (All in One) ==========
  const mainRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Main Runner (All in One)
Runs all 4 runners simultaneously in parallel
Run: python main_runner.py
"""

import asyncio
import signal
import os
import base64

from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, validate_contact, shutdown_all, SESSION_FOLDER
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== ACCOUNT FUNCTIONS ==========
async def check_spambot(client):
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(1)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        response_lower = response.lower()
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
        elif "limited" in response_lower or "restricted" in response_lower:
            return "restricted", None, response
        elif "banned" in response_lower:
            return "banned", response[:200], response
        return "active", None, response
    except Exception as e:
        return "active", None, f"Error: {e}"


async def change_name(client, first_name, last_name=""):
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_base64):
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


async def warmup_join_channel(client):
    try:
        for channel in ["@telegram", "@durov"]:
            try:
                await client.get_entity(channel)
                await asyncio.sleep(1)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_view_content(client):
    try:
        dialogs = await client.get_dialogs(limit=5)
        for dialog in dialogs:
            try:
                await client.get_messages(dialog, limit=10)
                await asyncio.sleep(0.5)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


# ========== MESSAGE HANDLER ==========
async def setup_message_handler(client, account_id):
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                content = event.message.text or "[Media]"
                media_type = "image" if event.message.photo else None
                if event.message.photo:
                    content = "[Photo] " + (event.message.text or "")
                print(f"  [CHAT] From {sender.first_name or sender.id}: {content[:40]}...")
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "content": content,
                    "media_type": media_type
                })
        except Exception as e:
            print(f"  Handler error: {e}")


# ========== 4 PARALLEL LOOPS ==========
async def campaign_loop():
    print("[CAMPAIGN] Started")
    while RUNNING:
        try:
            task = await get_next_task(runner="campaign")
            task_type = task.get("task", "wait")
            if task.get("stop_signal"):
                await asyncio.sleep(5)
                continue
            if task_type == "wait":
                for acc in task.get("accounts", []):
                    await get_or_create_client(acc)
                await asyncio.sleep(task.get("seconds", 1))
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client and recipient:
                    print(f"  [CAMPAIGN] Sending to {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {"message_id": msg.get("id"), "success": success, "error": error, "campaign_recipient_id": msg.get("campaign_recipient_id"), "account_id": account.get("id")})
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    for r in recipients:
                        if not RUNNING: break
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {"recipient_id": r["id"], "exists": exists, "name": name, "telegram_id": telegram_id})
        except:
            await asyncio.sleep(0.5)


async def livechat_loop():
    print("[LIVECHAT] Started")
    while RUNNING:
        try:
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            if task_type == "wait":
                for acc in task.get("accounts", []):
                    await get_or_create_client(acc, setup_handler=setup_message_handler)
                await asyncio.sleep(task.get("seconds", 0.1))
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    print(f"  [LIVECHAT] Reply to {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {"message_id": msg.get("id"), "success": success, "error": error, "account_id": account.get("id")})
        except:
            await asyncio.sleep(0.5)


async def account_loop():
    print("[ACCOUNT] Started")
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
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
            elif task_type == "change_name":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
            elif task_type == "change_photo":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
                    await report_result("change_photo", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            elif task_type == "privacy_settings":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                    await report_result("privacy_settings", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            elif task_type == "change_password":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                    await report_result("change_password", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            elif task_type == "logout_sessions":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
        except:
            await asyncio.sleep(1)


async def warmup_loop():
    print("[WARMUP] Started")
    while RUNNING:
        try:
            task = await get_next_task(runner="warmup")
            task_type = task.get("task", "wait")
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 5))
            elif task_type.startswith("warmup_"):
                account = task.get("account", {})
                warmup_type = task_type.replace("warmup_", "")
                client = await get_or_create_client(account)
                if client:
                    if warmup_type == "join_channel":
                        success, error = await warmup_join_channel(client)
                    elif warmup_type == "view_content":
                        success, error = await warmup_view_content(client)
                    else:
                        success, error = True, None
                    await report_result(task_type, {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
        except:
            await asyncio.sleep(1)


async def main():
    print("=" * 50)
    print("  TelegramCRM - All Runners (Parallel)")
    print("=" * 50)
    print("  Running: Campaign + LiveChat + Account + Warmup")
    print("  Stop: Ctrl+C")
    print("=" * 50 + "\\n")
    
    try:
        await asyncio.gather(campaign_loop(), livechat_loop(), account_loop(), warmup_loop())
    finally:
        await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\\nStopped.")
`;

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("livechat_runner.py", livechatRunnerPy);
    folder?.file("account_runner.py", accountRunnerPy);
    folder?.file("warmup_runner.py", warmupRunnerPy);
    folder?.file("main_runner.py", mainRunnerPy);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("ZIP downloaded!");
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
                7 files - each runner is separate
              </p>
            </div>

            <Button size="lg" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
              <Download className="h-6 w-6" />
              Download ZIP
            </Button>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">Files included:</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                <li><code>config.py</code> - Settings</li>
                <li><code>client_manager.py</code> - Shared logic</li>
                <li><code>campaign_runner.py</code> - Campaigns only</li>
                <li><code>livechat_runner.py</code> - Live chat only</li>
                <li><code>account_runner.py</code> - Account tasks only</li>
                <li><code>warmup_runner.py</code> - Warmup only</li>
                <li><code>main_runner.py</code> - All in one (parallel)</li>
              </ul>
            </div>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">How to run:</p>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>Extract ZIP folder</li>
                <li>Open CMD in folder</li>
                <li><code className="bg-background px-2 py-1 rounded">pip install telethon httpx</code></li>
                <li>Run any file:
                  <ul className="list-disc list-inside ml-4 mt-1">
                    <li><code>python main_runner.py</code> - All together</li>
                    <li><code>python campaign_runner.py</code> - Just campaigns</li>
                    <li><code>python livechat_runner.py</code> - Just chat</li>
                  </ul>
                </li>
              </ol>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
