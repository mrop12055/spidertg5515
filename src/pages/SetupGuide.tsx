import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, Terminal, CheckCircle, Copy, ExternalLink, Play, Settings2, AlertTriangle, MessageCircle, Shield, Zap, Users } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';

const SetupGuide: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(null), 2000);
  };

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  // ========== SHARED CONFIG FILE ==========
  const configPy = `"""
TelegramCRM - Shared Configuration
===================================
All shared settings for Python runners
"""

# Backend Configuration
BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_KEY = "${supabaseKey}"

# Telegram API credentials  
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"
`;

  // ========== SHARED CLIENT MANAGER ==========
  const clientManagerPy = `"""
TelegramCRM - Client Manager
=============================
Shared Telegram client logic for all runners
"""

import os
import base64
import tempfile
import asyncio
import httpx
from typing import Dict, Optional

from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH

# Temp folder for session files
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")

# Active clients cache
active_clients: Dict[str, TelegramClient] = {}


def decode_session_file(phone_number: str, base64_data: str) -> Optional[str]:
    """Decode base64 session data and save to temp file"""
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    try:
        session_bytes = base64.b64decode(base64_data)
        with open(session_path + ".session", "wb") as f:
            f.write(session_bytes)
        return session_path
    except Exception as e:
        print(f"  ⚠ Failed to decode session for {phone_number}: {e}")
        return None


async def get_or_create_client(account: dict, setup_handler=None) -> Optional[TelegramClient]:
    """Get existing client or create new one"""
    account_id = account["id"]
    
    if account_id in active_clients:
        client = active_clients[account_id]
        if client.is_connected():
            return client
    
    session_data = account.get("session_data")
    if not session_data:
        print(f"  ⚠ No session data for {account.get('phone_number', 'unknown')}")
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    try:
        client = TelegramClient(session_path, int(TELEGRAM_API_ID), TELEGRAM_API_HASH)
        await client.connect()
        
        if not await client.is_user_authorized():
            print(f"  ⚠ Session expired for {account['phone_number']}")
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        # Set up message handler if provided
        if setup_handler:
            await setup_handler(client, account_id)
        
        active_clients[account_id] = client
        
        # Report connection
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
        
        print(f"  ✓ Connected: {account['phone_number']}")
        return client
    except Exception as e:
        print(f"  ⚠ Failed to connect {account['phone_number']}: {e}")
        return None


async def get_next_task(runner: str = None) -> dict:
    """Ask backend for next task"""
    try:
        body = {}
        if runner:
            body["runner"] = runner
        
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body
            )
            return resp.json()
    except Exception as e:
        print(f"  ⚠ Failed to get task: {e}")
        return {"task": "wait", "seconds": 1}


async def report_result(task_type: str, result: dict):
    """Report task result to backend (fire and forget)"""
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
    """Send a message to a recipient"""
    try:
        if recipient.startswith("@"):
            entity = await client.get_entity(recipient)
        else:
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            
            contact = InputPhoneContact(
                client_id=random.randint(0, 2**31 - 1),
                phone=recipient,
                first_name="Contact",
                last_name=""
            )
            result = await client(ImportContactsRequest([contact]))
            if result.users:
                entity = result.users[0]
            else:
                return False, "User not found on Telegram"
        
        await client.send_message(entity, content)
        return True, None
    except UserPrivacyRestrictedError:
        return False, "User privacy settings prevent messaging"
    except FloodWaitError as e:
        return False, f"Rate limited: wait {e.seconds}s"
    except Exception as e:
        return False, str(e)


async def validate_contact(client: TelegramClient, phone: str):
    """Check if phone number exists on Telegram"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        import random
        
        contact = InputPhoneContact(
            client_id=random.randint(0, 2**31 - 1),
            phone=phone,
            first_name="Validation",
            last_name=""
        )
        result = await client(ImportContactsRequest([contact]))
        
        if result.users:
            user = result.users[0]
            name = f"{user.first_name or ''} {user.last_name or ''}".strip()
            return True, name, user.id
        return False, None, None
    except Exception as e:
        print(f"    ⚠ Validation error: {e}")
        return False, None, None


async def shutdown_all():
    """Cleanup all clients on shutdown"""
    print("\\nShutting down...")
    for account_id, client in active_clients.items():
        try:
            await client.disconnect()
            print(f"  Disconnected {account_id[:8]}...")
        except:
            pass
    print("✓ All clients disconnected.")
`;

  // ========== CAMPAIGN RUNNER ==========
  const campaignRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner
==============================
Handles ONLY campaign messages and recipient validation.
Can be stopped instantly with Ctrl+C or from frontend.

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

import asyncio
import signal
import sys

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, validate_contact, shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\\n⏹ Stop signal received. Finishing current task...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def main_loop():
    """Main campaign task execution loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner")
    print("=" * 60)
    print("  📨 Handles: Campaign messages, Recipient validation")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\\n✓ Starting campaign loop...\\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY campaign tasks
            task = await get_next_task(runner="campaign")
            task_type = task.get("task", "wait")
            
            # Check for stop signal from backend
            if task.get("stop_signal"):
                print("⏹ Campaign paused from dashboard. Stopping...")
                break
            
            if task_type == "wait":
                seconds = task.get("seconds", 1)
                # Keep clients alive during wait
                accounts = task.get("accounts", [])
                if accounts:
                    asyncio.gather(*[get_or_create_client(acc) for acc in accounts])
                await asyncio.sleep(seconds)
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client and recipient:
                    print(f"  📨 Sending to {recipient}...")
                    
                    success, error = await send_message(
                        client, recipient, msg.get("content", ""),
                        msg.get("media_url")
                    )
                    
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    
                    if success:
                        print(f"    ✓ Sent!")
                    else:
                        print(f"    ✗ Failed: {error}")
            
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  📋 Validating {len(recipients)} recipients...")
                    for r in recipients:
                        if not RUNNING:
                            break
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {
                            "recipient_id": r["id"],
                            "exists": exists,
                            "name": name,
                            "telegram_id": telegram_id
                        })
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(1)
    
    print("\\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Campaign Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  // ========== LIVE CHAT LISTENER ==========
  const liveChatListenerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Live Chat Listener
=================================
Keeps all accounts connected and listens for incoming messages.
Sends outgoing messages for active conversations instantly.

Run: python live_chat_listener.py
Stop: Ctrl+C
"""

import asyncio
import signal
import sys

from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, active_clients
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


async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                content = event.message.text or "[Media message]"
                media_url = None
                media_type = None
                
                # Handle photos
                if event.message.photo:
                    print(f"    📷 Receiving photo...")
                    content = "[Photo] " + (event.message.text or "")
                    media_type = "image"
                
                print(f"  📥 Message from {sender.first_name or sender.id}: {content[:50]}...")
                
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "content": content,
                    "media_url": media_url,
                    "media_type": media_type
                })
        except Exception as e:
            print(f"    ⚠ Error handling incoming message: {e}")


async def main_loop():
    """Main live chat loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Live Chat Listener")
    print("=" * 60)
    print("  📥 Handles: Incoming messages, Live chat replies")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting live chat listener...\\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY livechat tasks
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 0.05)
                # Connect all accounts and set up handlers
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc, setup_handler=setup_message_handler)
                await asyncio.sleep(seconds)
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                
                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    print(f"  ⚡ Live reply to {recipient}...")
                    
                    success, error = await send_message(
                        client, recipient, msg.get("content", ""),
                        msg.get("media_url")
                    )
                    
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    
                    if success:
                        print(f"    ✓ Sent!")
                    else:
                        print(f"    ✗ Failed: {error}")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(0.1)
    
    print("\\n⏹ Live chat listener stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Live Chat Listener... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  // ========== ACCOUNT MANAGER ==========
  const accountManagerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Account Manager
==============================
Handles account management tasks:
- SpamBot check
- Change name
- Change photo
- Privacy settings
- Change password
- Logout other sessions

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
    """Check SpamBot for account status"""
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
    """Change account name on Telegram"""
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_base64: str):
    """Change profile photo on Telegram"""
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
    """Logout all other sessions"""
    try:
        from telethon.tl.functions.auth import ResetAuthorizationsRequest
        await client(ResetAuthorizationsRequest())
        return True, None
    except Exception as e:
        return False, str(e)


async def main_loop():
    """Main account management loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Account Manager")
    print("=" * 60)
    print("  🔧 Handles: SpamBot check, Name change, Photo, Privacy")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting account manager...\\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY account tasks
            task = await get_next_task(runner="account")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 5)
                await asyncio.sleep(seconds)
            
            elif task_type == "spambot_check":
                task_id = task.get("task_id")
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
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
                
                client = await get_or_create_client(account)
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
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  📷 Changing photo for {account.get('phone_number')}...")
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
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
                
                client = await get_or_create_client(account)
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
                
                client = await get_or_create_client(account)
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
                
                client = await get_or_create_client(account)
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
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(1)
    
    print("\\n⏹ Account manager stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Account Manager... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  // ========== WARMUP RUNNER ==========
  const warmupRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner
=============================
Handles account warmup/maturation tasks:
- Join channels
- View content
- Build account activity

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    shutdown_all
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


async def warmup_join_channel(client):
    """Join public channels for warmup"""
    try:
        channels = ["@telegram", "@durov"]
        for channel in channels:
            try:
                await client.get_entity(channel)
                await asyncio.sleep(1)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_view_content(client):
    """View messages in channels for warmup"""
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
    """Main warmup task loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Warmup Runner")
    print("=" * 60)
    print("  🔥 Handles: Channel joins, Content viewing, Maturation")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting warmup runner...\\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY warmup tasks
            task = await get_next_task(runner="warmup")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 30)
                # Connect new accounts during wait
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc)
                await asyncio.sleep(seconds)
            
            elif task_type.startswith("warmup_"):
                task_id = task.get("task_id")
                account = task.get("account", {})
                warmup_type = task_type.replace("warmup_", "")
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔥 Warmup {warmup_type} for {account.get('phone_number')}...")
                    
                    if warmup_type == "join_channel":
                        success, error = await warmup_join_channel(client)
                    elif warmup_type == "view_content":
                        success, error = await warmup_view_content(client)
                    else:
                        success, error = True, None
                    
                    await report_result(task_type, {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(5)
    
    print("\\n⏹ Warmup runner stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Warmup Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  // ========== MAIN RUNNER (ALL IN ONE) ==========
  const mainRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Main Runner (All-in-One)
========================================
Runs ALL tasks in a single script (like before).
Use this if you don't want to run separate files.

For better control, use the individual runners instead:
- campaign_runner.py - Campaign messages only
- live_chat_listener.py - Incoming messages only  
- account_manager.py - Account tasks only
- warmup_runner.py - Warmup tasks only

Run: python main_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal

from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, validate_contact, shutdown_all, SESSION_FOLDER
)

# Import account functions
import os
import base64

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    global RUNNING
    print("\\n⏹ Stop signal received...")
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
async def setup_message_handler(client, account_id: str):
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                content = event.message.text or "[Media message]"
                media_type = "image" if event.message.photo else None
                if event.message.photo:
                    content = "[Photo] " + (event.message.text or "")
                
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "content": content,
                    "media_type": media_type
                })
        except Exception as e:
            print(f"    ⚠ Handler error: {e}")


# ========== MAIN LOOP ==========
async def main_loop():
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Main Runner (All-in-One)")
    print("=" * 60)
    print("  📨 Campaigns | 💬 Live Chat | 🔧 Account | 🔥 Warmup")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting main loop...\\n")
    
    while RUNNING:
        try:
            task = await get_next_task()  # No runner filter = all tasks
            task_type = task.get("task", "wait")
            
            if task.get("stop_signal"):
                print("⏹ Stop signal from backend. Pausing...")
                await asyncio.sleep(5)
                continue
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc, setup_handler=setup_message_handler)
                await asyncio.sleep(task.get("seconds", 0.05))
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                mode = task.get("mode", "campaign")
                
                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    icon = "⚡" if mode == "live" else "📨"
                    print(f"  {icon} Sending to {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    print(f"    {'✓ Sent!' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  📋 Validating {len(recipients)} recipients...")
                    for r in recipients:
                        if not RUNNING:
                            break
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {"recipient_id": r["id"], "exists": exists, "name": name, "telegram_id": telegram_id})
            
            elif task_type == "spambot_check":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🤖 SpamBot check for {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
                    print(f"    Result: {status}")
            
            elif task_type == "change_name":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  ✏️ Changing name...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_photo":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  📷 Changing photo...")
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
                    await report_result("change_photo", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "privacy_settings":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔒 Updating privacy...")
                    success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                    await report_result("privacy_settings", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_password":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔐 Changing password...")
                    success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                    await report_result("change_password", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "logout_sessions":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🚪 Logging out other sessions...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type.startswith("warmup_"):
                account = task.get("account", {})
                warmup_type = task_type.replace("warmup_", "")
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔥 Warmup {warmup_type}...")
                    if warmup_type == "join_channel":
                        success, error = await warmup_join_channel(client)
                    elif warmup_type == "view_content":
                        success, error = await warmup_view_content(client)
                    else:
                        success, error = True, None
                    await report_result(task_type, {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(0.1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Main Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${filename}`);
  };

  const downloadAllAsZip = async () => {
    const zip = new JSZip();
    zip.file('config.py', configPy);
    zip.file('client_manager.py', clientManagerPy);
    zip.file('campaign_runner.py', campaignRunnerPy);
    zip.file('live_chat_listener.py', liveChatListenerPy);
    zip.file('account_manager.py', accountManagerPy);
    zip.file('warmup_runner.py', warmupRunnerPy);
    zip.file('main_runner.py', mainRunnerPy);
    
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'telegram_crm_scripts.zip';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded all scripts as ZIP');
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Setup Guide"
        description="Download and run Python scripts to connect with Telegram"
      />

      <div className="space-y-6">
        {/* Quick Overview */}
        <Card className="border-primary/50 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Play className="w-5 h-5 text-primary" />
              Multi-File Python System
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">
              Each task type has its own Python file. Run them independently for better control:
            </p>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="text-center p-3 rounded-lg bg-background border">
                <MessageCircle className="w-8 h-8 mx-auto mb-2 text-blue-500" />
                <p className="text-sm font-medium">Campaign Runner</p>
                <p className="text-xs text-muted-foreground">Send campaigns</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-background border">
                <Zap className="w-8 h-8 mx-auto mb-2 text-yellow-500" />
                <p className="text-sm font-medium">Live Chat</p>
                <p className="text-xs text-muted-foreground">Listen for messages</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-background border">
                <Users className="w-8 h-8 mx-auto mb-2 text-green-500" />
                <p className="text-sm font-medium">Account Manager</p>
                <p className="text-xs text-muted-foreground">Manage accounts</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-background border">
                <Shield className="w-8 h-8 mx-auto mb-2 text-orange-500" />
                <p className="text-sm font-medium">Warmup Runner</p>
                <p className="text-xs text-muted-foreground">Mature new accounts</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Download All */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              Download Scripts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={downloadAllAsZip} size="lg" className="w-full gap-2">
              <Download className="w-5 h-5" />
              Download All Scripts (ZIP)
            </Button>
            
            <div className="grid gap-2 md:grid-cols-2">
              <Button variant="outline" onClick={() => downloadFile(configPy, 'config.py')} className="gap-2">
                <Settings2 className="w-4 h-4" />
                config.py
              </Button>
              <Button variant="outline" onClick={() => downloadFile(clientManagerPy, 'client_manager.py')} className="gap-2">
                <Settings2 className="w-4 h-4" />
                client_manager.py
              </Button>
              <Button variant="outline" onClick={() => downloadFile(campaignRunnerPy, 'campaign_runner.py')} className="gap-2">
                <MessageCircle className="w-4 h-4" />
                campaign_runner.py
              </Button>
              <Button variant="outline" onClick={() => downloadFile(liveChatListenerPy, 'live_chat_listener.py')} className="gap-2">
                <Zap className="w-4 h-4" />
                live_chat_listener.py
              </Button>
              <Button variant="outline" onClick={() => downloadFile(accountManagerPy, 'account_manager.py')} className="gap-2">
                <Users className="w-4 h-4" />
                account_manager.py
              </Button>
              <Button variant="outline" onClick={() => downloadFile(warmupRunnerPy, 'warmup_runner.py')} className="gap-2">
                <Shield className="w-4 h-4" />
                warmup_runner.py
              </Button>
              <Button variant="outline" onClick={() => downloadFile(mainRunnerPy, 'main_runner.py')} className="gap-2 md:col-span-2">
                <Play className="w-4 h-4" />
                main_runner.py (All-in-One)
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Script Details */}
        <Card>
          <CardHeader>
            <CardTitle>Script Details</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="campaign" className="w-full">
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="campaign">Campaign</TabsTrigger>
                <TabsTrigger value="livechat">Live Chat</TabsTrigger>
                <TabsTrigger value="account">Account</TabsTrigger>
                <TabsTrigger value="warmup">Warmup</TabsTrigger>
                <TabsTrigger value="main">All-in-One</TabsTrigger>
              </TabsList>
              
              <TabsContent value="campaign" className="space-y-4">
                <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/30">
                  <h3 className="font-semibold flex items-center gap-2 mb-2">
                    <MessageCircle className="w-5 h-5 text-blue-500" />
                    Campaign Runner
                  </h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Sends campaign messages and validates recipients. Can be stopped instantly from dashboard.
                  </p>
                  <div className="space-y-2">
                    <p className="text-sm"><strong>Run:</strong> <code className="bg-background px-2 py-1 rounded">python campaign_runner.py</code></p>
                    <p className="text-sm"><strong>Stop:</strong> Press Ctrl+C or pause campaign in dashboard</p>
                  </div>
                </div>
              </TabsContent>
              
              <TabsContent value="livechat" className="space-y-4">
                <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                  <h3 className="font-semibold flex items-center gap-2 mb-2">
                    <Zap className="w-5 h-5 text-yellow-500" />
                    Live Chat Listener
                  </h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Keeps all accounts connected and listens for incoming messages. Instantly sends replies.
                  </p>
                  <div className="space-y-2">
                    <p className="text-sm"><strong>Run:</strong> <code className="bg-background px-2 py-1 rounded">python live_chat_listener.py</code></p>
                    <p className="text-sm"><strong>Stop:</strong> Press Ctrl+C</p>
                    <p className="text-sm text-yellow-600"><strong>Tip:</strong> Keep this running always for live chat!</p>
                  </div>
                </div>
              </TabsContent>
              
              <TabsContent value="account" className="space-y-4">
                <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30">
                  <h3 className="font-semibold flex items-center gap-2 mb-2">
                    <Users className="w-5 h-5 text-green-500" />
                    Account Manager
                  </h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Handles SpamBot checks, name changes, photo updates, privacy settings, and passwords.
                  </p>
                  <div className="space-y-2">
                    <p className="text-sm"><strong>Run:</strong> <code className="bg-background px-2 py-1 rounded">python account_manager.py</code></p>
                    <p className="text-sm"><strong>Stop:</strong> Press Ctrl+C</p>
                  </div>
                </div>
              </TabsContent>
              
              <TabsContent value="warmup" className="space-y-4">
                <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/30">
                  <h3 className="font-semibold flex items-center gap-2 mb-2">
                    <Shield className="w-5 h-5 text-orange-500" />
                    Warmup Runner
                  </h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Matures new accounts by joining channels and viewing content. Run in background.
                  </p>
                  <div className="space-y-2">
                    <p className="text-sm"><strong>Run:</strong> <code className="bg-background px-2 py-1 rounded">python warmup_runner.py</code></p>
                    <p className="text-sm"><strong>Stop:</strong> Press Ctrl+C</p>
                  </div>
                </div>
              </TabsContent>
              
              <TabsContent value="main" className="space-y-4">
                <div className="p-4 rounded-lg bg-purple-500/10 border border-purple-500/30">
                  <h3 className="font-semibold flex items-center gap-2 mb-2">
                    <Play className="w-5 h-5 text-purple-500" />
                    Main Runner (All-in-One)
                  </h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Runs ALL tasks in a single script. Use if you don't want to manage multiple terminals.
                  </p>
                  <div className="space-y-2">
                    <p className="text-sm"><strong>Run:</strong> <code className="bg-background px-2 py-1 rounded">python main_runner.py</code></p>
                    <p className="text-sm"><strong>Stop:</strong> Press Ctrl+C</p>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Quick Start */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              Quick Start
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <Badge className="mt-0.5">1</Badge>
                <div>
                  <p className="font-medium">Install Python & Libraries</p>
                  <div className="relative mt-2">
                    <pre className="bg-background p-3 rounded-lg border text-sm overflow-x-auto">pip install telethon httpx</pre>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="absolute top-1 right-1"
                      onClick={() => copyToClipboard('pip install telethon httpx', 'pip')}
                    >
                      {copied === 'pip' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <Badge className="mt-0.5">2</Badge>
                <div>
                  <p className="font-medium">Download all scripts to a folder</p>
                  <p className="text-sm text-muted-foreground">Click "Download All Scripts (ZIP)" above</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <Badge className="mt-0.5">3</Badge>
                <div>
                  <p className="font-medium">Open terminal in that folder</p>
                  <p className="text-sm text-muted-foreground">Type <code className="bg-background px-2 py-1 rounded">cmd</code> in address bar (Windows)</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <Badge className="mt-0.5">4</Badge>
                <div>
                  <p className="font-medium">Run the scripts you need</p>
                  <div className="relative mt-2">
                    <pre className="bg-background p-3 rounded-lg border text-sm overflow-x-auto"># Terminal 1 - Always running for live chat
python live_chat_listener.py

# Terminal 2 - Run when sending campaigns
python campaign_runner.py</pre>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recommended Setup */}
        <Card className="border-green-500/50 bg-green-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-600">
              <CheckCircle className="w-5 h-5" />
              Recommended Setup
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-yellow-500/10">Terminal 1</Badge>
                <span><code>python live_chat_listener.py</code> - Keep always running</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-blue-500/10">Terminal 2</Badge>
                <span><code>python campaign_runner.py</code> - Run when sending campaigns (Ctrl+C to stop)</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-green-500/10">Terminal 3</Badge>
                <span><code>python account_manager.py</code> - Run when doing bulk account actions</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-orange-500/10">Terminal 4</Badge>
                <span><code>python warmup_runner.py</code> - Run for new accounts (optional)</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Troubleshooting */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              Troubleshooting
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-accent/50">
                <p className="font-medium">Campaign won't stop?</p>
                <p className="text-sm text-muted-foreground">
                  With separate files, just press Ctrl+C in the campaign_runner.py terminal. It stops immediately!
                </p>
              </div>
              <div className="p-3 rounded-lg bg-accent/50">
                <p className="font-medium">ModuleNotFoundError: No module named 'config'</p>
                <p className="text-sm text-muted-foreground">
                  Make sure all .py files are in the same folder. config.py and client_manager.py must be present.
                </p>
              </div>
              <div className="p-3 rounded-lg bg-accent/50">
                <p className="font-medium">Session expired error?</p>
                <p className="text-sm text-muted-foreground">
                  Re-upload the session file in Accounts page. The session may have been logged out.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
