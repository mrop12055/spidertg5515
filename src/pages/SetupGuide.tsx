import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, CheckCircle2, XCircle, Loader2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { supabase } from '@/integrations/supabase/client';

const SetupGuide: React.FC = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  // Runner status state
  const [isRunnerOnline, setIsRunnerOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState<Date | null>(null);

  // Check runner status from heartbeats table
  useEffect(() => {
    const checkRunnerStatus = async () => {
      try {
        const { data: heartbeats } = await supabase
          .from('runner_heartbeats')
          .select('runner_name, last_seen, status')
          .eq('runner_name', 'main')
          .limit(1);
        
        if (heartbeats && heartbeats.length > 0) {
          const hb = heartbeats[0];
          const lastSeenDate = new Date(hb.last_seen);
          setLastSeen(lastSeenDate);
          // A runner is online if last_seen is within 15 seconds
          const fifteenSecondsAgo = new Date(Date.now() - 15000);
          setIsRunnerOnline(lastSeenDate > fifteenSecondsAgo);
        }
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
SUPABASE_KEY = "${supabaseKey}"
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"
`;

  // ========== 2. CLIENT_MANAGER.PY ==========
  const clientManagerPy = `"""
TelegramCRM - Client Manager
Shared Telegram client logic with device fingerprint support
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
from fingerprint_generator import generate_fingerprint

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
    
    # Get device fingerprint from account or generate new one
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
    else:
        print(f"  [FP] Using: {device_model} ({system_version})")
    
    try:
        client = TelegramClient(
            session_path, int(TELEGRAM_API_ID), TELEGRAM_API_HASH,
            device_model=device_model,
            system_version=system_version,
            app_version=app_version,
            lang_code=lang_code,
            system_lang_code=system_lang_code
        )
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

  // ========== 3. MAIN_RUNNER.PY (All-in-One) ==========
  const mainRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Main Runner (All-in-One)
========================================
This single script handles ALL tasks:
- Campaign messages
- Live chat (incoming/outgoing)
- Account management (SpamBot, name, photo, privacy, password)
- Contact import & validation
- Warmup tasks (join channels, view content, reactions)
- Block/unblock contacts

Run: python main_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import os
import base64

from telethon import events
from telethon.tl.functions.contacts import BlockRequest, UnblockRequest

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, validate_contact, shutdown_all, SESSION_FOLDER
)

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down gracefully...")
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


async def warmup_join_channel(client, channel_username=None):
    try:
        from telethon.tl.functions.channels import JoinChannelRequest
        import random
        channels = ["telegram", "durov", "tginfo"]
        if not channel_username:
            channel_username = random.choice(channels)
        entity = await client.get_entity(channel_username)
        await client(JoinChannelRequest(entity))
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_view_content(client, channel_username=None):
    try:
        import random
        channels = ["telegram", "durov", "tginfo"]
        if not channel_username:
            channel_username = random.choice(channels)
        entity = await client.get_entity(channel_username)
        messages = await client.get_messages(entity, limit=10)
        if messages:
            await client.send_read_acknowledge(entity, messages[-1])
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_reaction(client, channel_username=None):
    try:
        from telethon.tl.functions.messages import SendReactionRequest
        from telethon.tl.types import ReactionEmoji
        import random
        channels = ["telegram", "durov"]
        reactions = ["👍", "❤️", "🔥", "👏", "😂"]
        if not channel_username:
            channel_username = random.choice(channels)
        entity = await client.get_entity(channel_username)
        messages = await client.get_messages(entity, limit=5)
        if messages:
            msg = random.choice(messages)
            reaction = random.choice(reactions)
            await client(SendReactionRequest(
                peer=entity,
                msg_id=msg.id,
                reaction=[ReactionEmoji(emoticon=reaction)]
            ))
        return True, None
    except Exception as e:
        return False, str(e)


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
                
                print(f"  [IN] From {sender.first_name or sender.id}: {content[:40]}...")
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
            print(f"  [WARN] Handler error: {e}")


# ========== MAIN LOOP ==========
async def main_loop():
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Main Runner (All-in-One)")
    print("=" * 60)
    print("  📨 Campaigns | 💬 Live Chat | 🔧 Account | 🔥 Warmup | 🚫 Block")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print("\\n[OK] Starting main loop...\\n")
    
    while RUNNING:
        try:
            task = await get_next_task(runner="main")
            task_type = task.get("task", "wait")
            
            if task.get("stop_signal"):
                print("[PAUSE] Stop signal from dashboard. Waiting...")
                await asyncio.sleep(5)
                continue
            
            # ========== WAIT (keep connections alive) ==========
            if task_type == "wait":
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc, setup_handler=setup_message_handler)
                await asyncio.sleep(task.get("seconds", 0.05))
            
            # ========== SEND MESSAGE ==========
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
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            # ========== VALIDATE CONTACTS ==========
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
            
            # ========== CONTACT IMPORT ==========
            elif task_type == "contact_import":
                task_id = task.get("task_id")
                tag_id = task.get("tag_id")
                phone_numbers = task.get("phone_numbers", [])
                valid_numbers = list(task.get("valid_numbers", []))
                invalid_numbers = list(task.get("invalid_numbers", []))
                account = task.get("account", {})
                
                print(f"  [IMPORT] {len(phone_numbers)} numbers with {account.get('phone_number')}")
                
                client = await get_or_create_client(account)
                if not client:
                    await report_result("contact_import", {
                        "task_id": task_id,
                        "success": False,
                        "account_failed": True,
                        "failed_account_id": account.get("id"),
                        "remaining_numbers": phone_numbers,
                        "valid_numbers": valid_numbers,
                        "invalid_numbers": invalid_numbers,
                        "error": "Could not connect to account"
                    })
                    continue
                
                processed = 0
                for phone in phone_numbers:
                    if not RUNNING:
                        break
                    
                    try:
                        exists, name, telegram_id = await validate_contact(client, phone)
                        if exists:
                            valid_numbers.append(phone)
                            print(f"    + {phone} valid ({name})")
                        else:
                            invalid_numbers.append(phone)
                            print(f"    - {phone} not on Telegram")
                        processed += 1
                    except Exception as e:
                        error_str = str(e).lower()
                        if any(x in error_str for x in ['flood', 'restricted', 'banned', 'wait', 'auth_key']):
                            print(f"    [WARN] Account restricted: {e}")
                            remaining = phone_numbers[processed:]
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
                            break
                        else:
                            invalid_numbers.append(phone)
                            print(f"    - {phone} error: {e}")
                            processed += 1
                else:
                    await report_result("contact_import", {
                        "task_id": task_id,
                        "success": True,
                        "valid_numbers": valid_numbers,
                        "invalid_numbers": invalid_numbers
                    })
                    print(f"    [OK] Import complete: {len(valid_numbers)} valid, {len(invalid_numbers)} invalid")
            
            # ========== SPAMBOT CHECK ==========
            elif task_type == "spambot_check":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [SPAM] Checking {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
                    print(f"    Result: {status}")
            
            # ========== CHANGE NAME ==========
            elif task_type == "change_name":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [NAME] Changing name...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            # ========== CHANGE PHOTO ==========
            elif task_type == "change_photo":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PHOTO] Changing photo...")
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
                    await report_result("change_photo", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            # ========== PRIVACY SETTINGS ==========
            elif task_type == "privacy_settings":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PRIV] Updating privacy...")
                    success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                    await report_result("privacy_settings", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            # ========== CHANGE PASSWORD ==========
            elif task_type == "change_password":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PASS] Changing password...")
                    success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                    await report_result("change_password", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            # ========== LOGOUT SESSIONS ==========
            elif task_type == "logout_sessions":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [LOGOUT] Logging out other sessions...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            # ========== BLOCK CONTACT ==========
            elif task_type == "block_contact":
                account = task.get("account", {})
                target = task.get("target", {})
                action = task.get("action", "block")
                client = await get_or_create_client(account)
                if client:
                    print(f"  [BLOCK] {action.capitalize()} contact...")
                    success, error = await block_contact(client, target, action)
                    await report_result("block_contact", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": action
                    })
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
            
            # ========== WARMUP TASKS ==========
            elif task_type.startswith("warmup_"):
                account = task.get("account", {})
                channel = task.get("channel_username")
                warmup_type = task_type.replace("warmup_", "")
                client = await get_or_create_client(account)
                if client:
                    print(f"  [WARMUP] {warmup_type}...")
                    if warmup_type == "join_channel":
                        success, error = await warmup_join_channel(client, channel)
                    elif warmup_type == "view_content":
                        success, error = await warmup_view_content(client, channel)
                    elif warmup_type == "reaction":
                        success, error = await warmup_reaction(client, channel)
                    else:
                        success, error = True, None
                    await report_result("warmup_complete", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": warmup_type
                    })
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
        
        except Exception as e:
            print(f"  [ERROR] Loop error: {e}")
            await asyncio.sleep(0.1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\\n" + "=" * 60)
    print("  TelegramCRM - Main Runner")
    print("  Install: pip install telethon httpx")
    print("=" * 60 + "\\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\\n[STOP] Keyboard interrupt.")
    finally:
        print("Goodbye!")
`;

  // ========== FINGERPRINT_GENERATOR.PY ==========
  const fingerprintGeneratorPy = `"""Device Fingerprint Generator - Unique device identities for each account"""
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
    if use_android:
        device = random.choice(ANDROID_DEVICES)
    else:
        device = random.choice(IOS_DEVICES)
    lang = random.choice(LANGUAGES)
    return {
        "device_model": device["model"],
        "system_version": random.choice(device["versions"]),
        "app_version": random.choice(VERSIONS),
        "lang_code": lang["code"],
        "system_lang_code": random.choice(lang["systems"])
    }
`;

  // ========== RUN.BAT (Single file to run everything) ==========
  const runBat = `@echo off
title TelegramCRM - Main Runner
color 0A

echo.
echo  ================================================
echo       TelegramCRM - Main Runner
echo  ================================================
echo.
echo  This runs ALL tasks in a single process:
echo    - Campaign messages
echo    - Live chat (incoming + replies)
echo    - Account management
echo    - Contact import
echo    - Warmup tasks
echo    - Block/unblock contacts
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx --quiet
if errorlevel 1 (
    python -m pip install telethon httpx --quiet
)
echo        Done!
echo.

echo  [2/2] Starting Main Runner...
echo        Press Ctrl+C to stop
echo.
echo  ================================================
echo.

py main_runner.py
if errorlevel 1 (
    python main_runner.py
)

echo.
echo  Runner stopped.
pause
`;

  // ========== REQUIREMENTS.TXT ==========
  const requirementsTxt = `telethon>=1.34.0
httpx>=0.24.0
`;

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("fingerprint_generator.py", fingerprintGeneratorPy);
    folder?.file("main_runner.py", mainRunnerPy);
    folder?.file("requirements.txt", requirementsTxt);
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("ZIP downloaded! 6 files included.");
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
                Single runner handles everything - just double-click to start
              </p>
            </div>

            <Button size="lg" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
              <Download className="h-6 w-6" />
              Download ZIP
            </Button>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">📁 Files included (6 total):</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                <li><code className="text-green-600 dark:text-green-400">RUN.bat</code> - <strong>Double-click to START</strong></li>
                <li><code>main_runner.py</code> - All-in-one runner (handles everything)</li>
                <li><code>config.py</code> - Backend settings</li>
                <li><code>client_manager.py</code> - Telegram client logic</li>
                <li><code>fingerprint_generator.py</code> - Device fingerprints</li>
                <li><code>requirements.txt</code> - Python dependencies</li>
              </ul>
            </div>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">🚀 How to use:</p>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>Extract ZIP folder</li>
                <li>Double-click <code className="bg-green-100 dark:bg-green-900 px-2 py-0.5 rounded">RUN.bat</code></li>
                <li>Runner handles all tasks automatically</li>
                <li>To stop: Press <kbd className="bg-background px-2 py-0.5 rounded border">Ctrl+C</kbd> in the window</li>
              </ol>
            </div>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">⚡ What it handles:</p>
              <div className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                <div>📨 Campaign messages</div>
                <div>💬 Live chat replies</div>
                <div>🤖 SpamBot checks</div>
                <div>📋 Contact import</div>
                <div>🔥 Warmup tasks</div>
                <div>🚫 Block contacts</div>
                <div>✏️ Name/photo/privacy</div>
                <div>🔒 Password changes</div>
              </div>
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
            
            <div 
              className={`border rounded-lg p-4 transition-all ${
                isRunnerOnline 
                  ? 'border-green-500/50 bg-green-500/5' 
                  : 'border-border bg-muted/30'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Zap className={isRunnerOnline ? "h-6 w-6 text-green-500" : "h-6 w-6 text-muted-foreground"} />
                  <div>
                    <p className="font-medium">Main Runner</p>
                    <p className="text-xs text-muted-foreground">
                      {lastSeen 
                        ? `Last seen: ${lastSeen.toLocaleTimeString()}`
                        : 'Not connected yet'
                      }
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isRunnerOnline ? (
                    <>
                      <span className="text-sm font-medium text-green-600 dark:text-green-400">LIVE</span>
                      <CheckCircle2 className="h-6 w-6 text-green-500" />
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-medium text-muted-foreground">OFFLINE</span>
                      <XCircle className="h-6 w-6 text-muted-foreground" />
                    </>
                  )}
                </div>
              </div>
              
              {isRunnerOnline && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {['Campaigns', 'Live Chat', 'Account', 'Import', 'Warmup', 'Block'].map((func) => (
                    <span 
                      key={func}
                      className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-700 dark:text-green-300"
                    >
                      {func}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="text-center pt-2">
              <p className="text-xs text-muted-foreground">
                💡 Run <code className="bg-muted px-1.5 py-0.5 rounded">RUN.bat</code> on your PC to connect
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
