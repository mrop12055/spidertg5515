import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, CheckCircle2, XCircle, Loader2, Send, MessageSquare, UserCog } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { supabase } from '@/integrations/supabase/client';

interface RunnerStatus {
  name: string;
  icon: React.ReactNode;
  color: string;
  functions: string[];
  lastSeen: Date | null;
  isOnline: boolean;
}

const SetupGuide: React.FC = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  // Runner status state
  const [runnerStatuses, setRunnerStatuses] = useState<RunnerStatus[]>([
    {
      name: 'Campaign Runner',
      icon: <Send className="h-5 w-5" />,
      color: 'text-blue-500',
      functions: ['Send campaign messages', 'Validate recipients', 'Track delivery'],
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'LiveChat Runner',
      icon: <MessageSquare className="h-5 w-5" />,
      color: 'text-purple-500',
      functions: ['Listen incoming messages', 'Send replies', 'Real-time updates'],
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'Account Runner',
      icon: <UserCog className="h-5 w-5" />,
      color: 'text-yellow-500',
      functions: ['SpamBot check', 'Change name/photo', 'Privacy settings', 'Password', 'Logout sessions'],
      lastSeen: null,
      isOnline: false
    }
  ]);

  // Check runner status based on recent account activity
  useEffect(() => {
    const checkRunnerStatus = async () => {
      try {
        // Check for recently active accounts (within last 30 seconds = runner is live)
        const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString();
        
        const { data: activeAccounts } = await supabase
          .from('telegram_accounts')
          .select('last_active, status')
          .gte('last_active', thirtySecondsAgo);
        
        const hasActiveAccounts = activeAccounts && activeAccounts.length > 0;
        
        // Check for pending tasks (runners are processing)
        const { data: pendingTasks } = await supabase
          .from('account_check_tasks')
          .select('task_type, status')
          .eq('status', 'pending')
          .limit(5);
        
        const hasPendingAccountTasks = pendingTasks && pendingTasks.length > 0;
        
        // Check for running campaigns
        const { data: runningCampaigns } = await supabase
          .from('campaigns')
          .select('status')
          .eq('status', 'running')
          .limit(1);
        
        const hasCampaignRunning = runningCampaigns && runningCampaigns.length > 0;
        
        // Check for active conversations (livechat)
        const { data: activeConversations } = await supabase
          .from('conversations')
          .select('last_message_at')
          .gte('last_message_at', thirtySecondsAgo)
          .limit(1);
        
        const hasRecentMessages = activeConversations && activeConversations.length > 0;

        setRunnerStatuses(prev => prev.map((runner, index) => {
          let isOnline = false;
          
          if (index === 0) { // Campaign
            isOnline = hasActiveAccounts && hasCampaignRunning;
          } else if (index === 1) { // LiveChat
            isOnline = hasActiveAccounts || hasRecentMessages;
          } else if (index === 2) { // Account
            isOnline = hasActiveAccounts || hasPendingAccountTasks;
          }
          
          return {
            ...runner,
            isOnline,
            lastSeen: isOnline ? new Date() : runner.lastSeen
          };
        }));
      } catch (error) {
        console.error('Error checking runner status:', error);
      }
    };

    checkRunnerStatus();
    const interval = setInterval(checkRunnerStatus, 5000); // Check every 5 seconds
    
    return () => clearInterval(interval);
  }, []);

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
Handles: Incoming messages, Live chat replies, Profile photos
Run: python livechat_runner.py
"""

import asyncio
import signal
import base64

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
                
                # Get sender phone if available
                sender_phone = None
                if hasattr(sender, 'phone') and sender.phone:
                    sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
                
                # Get profile photo
                avatar_base64 = None
                try:
                    photo = await client.download_profile_photo(sender, bytes)
                    if photo:
                        avatar_base64 = base64.b64encode(photo).decode('utf-8')
                except:
                    pass
                
                print(f"  From {sender.first_name or sender.id}: {content[:40]}...")
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "sender_phone": sender_phone,
                    "sender_avatar": avatar_base64,
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

  // ========== 6. MAIN_RUNNER.PY (All in One) ==========
  const mainRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Main Runner (All in One)
Runs all 3 runners simultaneously in parallel
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
                
                # Get sender phone
                sender_phone = None
                if hasattr(sender, 'phone') and sender.phone:
                    sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
                
                # Get profile photo
                avatar_base64 = None
                try:
                    photo = await client.download_profile_photo(sender, bytes)
                    if photo:
                        avatar_base64 = base64.b64encode(photo).decode('utf-8')
                except:
                    pass
                
                print(f"  [CHAT] From {sender.first_name or sender.id}: {content[:40]}...")
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "sender_phone": sender_phone,
                    "sender_avatar": avatar_base64,
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



async def main():
    print("=" * 50)
    print("  TelegramCRM - All Runners (Parallel)")
    print("=" * 50)
    print("  Running: Campaign + LiveChat + Account")
    print("  Stop: Ctrl+C")
    print("=" * 50 + "\\n")
    
    try:
        await asyncio.gather(campaign_loop(), livechat_loop(), account_loop())
    finally:
        await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\\nStopped.")
`;

  // ========== RUN_ALL.BAT ==========
  const runAllBat = `@echo off
title TelegramCRM - Starting All Runners
color 0A
echo.
echo  ================================================
echo     TelegramCRM - Starting All Runners
echo  ================================================
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx --quiet
if errorlevel 1 (
    echo  ERROR: pip install failed! Make sure Python is installed.
    pause
    exit /b 1
)
echo        Done!
echo.

echo  [2/2] Starting 3 runners in separate windows...
echo.

start "TelegramCRM - Campaign" cmd /k "title Campaign Runner && color 0B && py campaign_runner.py"
timeout /t 1 /nobreak >nul
start "TelegramCRM - LiveChat" cmd /k "title LiveChat Runner && color 0D && py livechat_runner.py"
timeout /t 1 /nobreak >nul
start "TelegramCRM - Account" cmd /k "title Account Runner && color 0E && py account_runner.py"

echo.
echo  ================================================
echo     All 3 runners started successfully!
echo  ================================================
echo.
echo     Campaign Runner  = Blue window
echo     LiveChat Runner  = Purple window
echo     Account Runner   = Yellow window
echo.
echo     To STOP all: Double-click STOP_ALL.bat
echo  ================================================
echo.
pause
`;

  // ========== STOP_ALL.BAT ==========
  const stopAllBat = `@echo off
title TelegramCRM - Stopping All Runners
color 0C
echo.
echo  ================================================
echo     TelegramCRM - Stopping All Runners
echo  ================================================
echo.

echo  Stopping all Python runners...
echo.

:: Kill by window title
taskkill /FI "WINDOWTITLE eq Campaign Runner*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq LiveChat Runner*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Account Runner*" /F >nul 2>&1

:: Also kill by script name (backup method)
taskkill /FI "WINDOWTITLE eq TelegramCRM - Campaign*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq TelegramCRM - LiveChat*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq TelegramCRM - Account*" /F >nul 2>&1

echo.
echo  ================================================
echo     All runners stopped!
echo  ================================================
echo.
timeout /t 3
`;

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("livechat_runner.py", livechatRunnerPy);
    folder?.file("account_runner.py", accountRunnerPy);
    folder?.file("main_runner.py", mainRunnerPy);
    folder?.file("RUN_ALL.bat", runAllBat);
    folder?.file("STOP_ALL.bat", stopAllBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("ZIP downloaded! 8 files included.");
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
                8 files - complete stable setup
              </p>
            </div>

            <Button size="lg" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
              <Download className="h-6 w-6" />
              Download ZIP
            </Button>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">📁 Files included (8 total):</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                <li><code className="text-green-600 dark:text-green-400">RUN_ALL.bat</code> - <strong>Double-click to START</strong></li>
                <li><code className="text-red-600 dark:text-red-400">STOP_ALL.bat</code> - <strong>Double-click to STOP</strong></li>
                <li><code>config.py</code> - Backend settings</li>
                <li><code>client_manager.py</code> - Shared Telegram logic</li>
                <li><code>campaign_runner.py</code> - Campaign messages</li>
                <li><code>livechat_runner.py</code> - Incoming messages + replies</li>
                <li><code>account_runner.py</code> - SpamBot, name, photo, privacy</li>
                <li><code>main_runner.py</code> - All 3 in one (parallel)</li>
              </ul>
            </div>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">🚀 How to use:</p>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>Extract ZIP folder</li>
                <li>Double-click <code className="bg-green-100 dark:bg-green-900 px-2 py-0.5 rounded">RUN_ALL.bat</code> to start</li>
                <li>3 colored windows will open (each runner)</li>
                <li>To stop: Double-click <code className="bg-red-100 dark:bg-red-900 px-2 py-0.5 rounded">STOP_ALL.bat</code></li>
              </ol>
            </div>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">🔧 Alternative (manual):</p>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>Open CMD in folder</li>
                <li><code className="bg-background px-2 py-1 rounded">pip install telethon httpx</code></li>
                <li>Run: <code className="bg-background px-2 py-1 rounded">python main_runner.py</code></li>
              </ol>
            </div>
          </CardContent>
        </Card>

        {/* Runner Status Section */}
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">🖥️ Python Runners Status</h3>
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
                  <div className="flex items-center justify-between mb-2">
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
                💡 Run <code className="bg-muted px-1.5 py-0.5 rounded">RUN_ALL.bat</code> on your PC to connect runners
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
