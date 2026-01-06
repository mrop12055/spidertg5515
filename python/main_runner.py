#!/usr/bin/env python3
"""
TelegramCRM - Master Runner (ALL-IN-ONE)
==========================================
Single process that handles ALL tasks:
- Campaigns (bulk messaging)
- LiveChat (incoming messages + replies)
- Account (SpamBot, name, photo, privacy, import)
- Warmup (channel joins, reactions, pair chats)
- Block (block/unblock contacts)

Benefits:
- Connects to each account ONCE (shared connection pool)
- Single event loop = faster polling
- Less memory usage
- Easier to run (just one file)

Run: python main_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import os
import base64
import random
import time

from telethon import events
from telethon.tl.functions.contacts import BlockRequest, UnblockRequest

from client_manager import (
    get_or_create_client, get_next_task, get_batch_tasks, report_result,
    send_message, validate_contact, shutdown_all, active_clients,
    SESSION_FOLDER, SUPABASE_URL, SUPABASE_KEY
)

import httpx
from urllib.parse import urlparse

# Parse SUPABASE_URL to get base URL for storage
_u = urlparse(SUPABASE_URL)
SUPABASE_URL_BASE = f"{_u.scheme}://{_u.netloc}" if _u.scheme and _u.netloc else SUPABASE_URL.rstrip("/")

# ========== GLOBAL STATE ==========
RUNNING = True
CONNECTED_LIVECHAT_IDS = set()  # Track which accounts have livechat handlers installed


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n" + "=" * 60)
    print("  ⏹ Stop signal received. Shutting down gracefully...")
    print("=" * 60)
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ==================== LIVECHAT FUNCTIONS ====================

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
                digits = re.sub(r'\D', '', sender_phone)
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
        return False


async def setup_livechat_handler(client, account_id: str):
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
            
            # Get sender info for matching
            sender_username = getattr(sender, 'username', None)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
            
            # Check if conversation exists
            conversation_exists = await check_conversation_exists(account_id, sender.id, sender_username, sender_phone)
            if not conversation_exists:
                return
            
            content = event.message.text or "[Media]"
            media_url = None
            media_type = None
            
            if event.message.photo:
                print(f"    📷 [PHOTO] Receiving...")
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
                                print(f"    ✓ Photo uploaded")
                except Exception as e:
                    print(f"    ⚠ Photo upload failed: {e}")
            
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
            except:
                pass
            
            print(f"  📥 [IN] From {sender_name}: {content[:40]}...")
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
            print(f"    ⚠ Handler error: {e}")


# ==================== ACCOUNT FUNCTIONS ====================

async def check_spambot(client):
    """Check SpamBot - detects banned, restricted"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        response_lower = response.lower()
        
        if "banned" in response_lower or "deleted" in response_lower or "заблокирован" in response_lower:
            return "banned", response[:200], response
        if "limited" in response_lower or "restricted" in response_lower or "frozen" in response_lower:
            return "restricted", "Limited", response
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
        
        if photo_source.startswith("http://") or photo_source.startswith("https://"):
            async with aiohttp.ClientSession() as session:
                async with session.get(photo_source) as resp:
                    if resp.status == 200:
                        photo_bytes = await resp.read()
                        with open(temp_path, "wb") as f:
                            f.write(photo_bytes)
                    else:
                        return False, f"HTTP {resp.status}"
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


# ==================== WARMUP FUNCTIONS ====================

WARMUP_CHANNELS = ["telegram", "durov", "TelegramTips", "android", "ios"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😊", "🎉", "💯", "⭐"]


async def join_channel(client, channel_username=None):
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


async def view_channel_messages(client, channel_username=None):
    try:
        from telethon.tl.functions.messages import GetHistoryRequest, ReadHistoryRequest
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        history = await client(GetHistoryRequest(
            peer=entity, limit=20, offset_date=None, offset_id=0,
            max_id=0, min_id=0, add_offset=0, hash=0
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


async def send_reaction(client, channel_username=None):
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
                await client(SendReactionRequest(peer=entity, msg_id=msg.id, reaction=[ReactionEmoji(emoticon=reaction)]))
                await asyncio.sleep(random.uniform(1, 2))
                return True, channel, reaction
            except:
                return True, channel, "Viewed (reactions disabled)"
        return True, channel, "No messages"
    except Exception as e:
        return False, channel_username, str(e)


async def send_warmup_chat(client, recipient_phone, message, recipient_telegram_id=None, recipient_username=None, recipient_first_name=None):
    """Send warmup chat message with typing simulation"""
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
        
        # Typing simulation
        typing_time = min(random.uniform(2, 4) + len(message) * random.uniform(0.08, 0.15), 15)
        async with client.action(user, 'typing'):
            await asyncio.sleep(typing_time)
        
        await client.send_message(user, message)
        await asyncio.sleep(random.uniform(0.5, 2))
        return True, None
    except Exception as e:
        return False, str(e)


async def add_contact(client, phone, first_name, last_name=""):
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        contact = InputPhoneContact(client_id=0, phone=phone, first_name=first_name, last_name=last_name)
        result = await client(ImportContactsRequest([contact]))
        if result.imported:
            return True, phone, None
        return True, phone, "Contact exists"
    except Exception as e:
        return False, phone, str(e)


# ==================== TASK PROCESSORS ====================

async def process_campaign_task(task: dict) -> dict:
    """Process a single campaign send task"""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    account = task.get("account", {})
    proxy = task.get("proxy")
    content = msg.get("content", "")
    
    account_id = account.get("id")
    account_phone = account.get("phone_number", "????")[-4:]
    
    if not account_id or not recipient:
        return {"success": False, "error": "Missing account/recipient", "campaign_recipient_id": msg.get("campaign_recipient_id"), "account_id": account_id}
    
    try:
        client = await get_or_create_client(account, task_proxy=proxy)
        if not client:
            return {"success": False, "error": "Could not connect", "campaign_recipient_id": msg.get("campaign_recipient_id"), "account_id": account_id}
        
        await asyncio.sleep(random.uniform(0.5, 3))  # Human-like stagger
        print(f"  📨 [{account_phone}] → {recipient}")
        
        success, error = await send_message(client, recipient, content, msg.get("media_url"))
        
        is_privacy_error = error and "privacy" in error.lower()
        api_creds = account.get("telegram_api_credentials")
        api_credential_id = api_creds.get("id") if api_creds else account.get("api_credential_id")
        
        result = {
            "success": success, "error": error,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"), "account_id": account_id,
            "api_credential_id": api_credential_id,
            "content": content, "recipient_phone": recipient, "recipient_name": recipient_name,
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
        return {"success": False, "error": str(e), "campaign_recipient_id": msg.get("campaign_recipient_id"), "account_id": account_id}


async def process_warmup_task(task: dict) -> dict:
    """Process a single warmup task"""
    task_type = task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    is_cycle_last = task.get("is_cycle_last", False)
    phone = account.get("phone_number", "Unknown")
    
    try:
        client = await get_or_create_client(account, task_proxy=account.get("proxy"))
        if not client:
            await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": False, "error": "Could not connect"})
            return {"task_id": task_id, "success": False}
        
        if task_type == "warmup_add_contact":
            target_phone = task_data.get("phone") or task_data.get("recipient_phone")
            first_name = task_data.get("first_name", "Friend")
            print(f"  👤 [{phone}] Saving contact...")
            success, added_phone, error = await add_contact(client, target_phone, first_name)
            await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": success, "error": error, "message_type": "add_contact", "is_cycle_last": is_cycle_last})
            return {"task_id": task_id, "success": success}
        
        elif task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            message = task_data.get("message", "Hey! 👋")
            print(f"  🔥 [{phone}] Warmup chat...")
            success, error = await send_warmup_chat(client, recipient_phone, message, task_data.get("recipient_telegram_id"), task_data.get("recipient_username"), task_data.get("first_name"))
            await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": success, "error": error, "message_type": "text", "is_cycle_last": is_cycle_last})
            return {"task_id": task_id, "success": success}
        
        elif task_type == "warmup_join_channel":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  📢 [{phone}] Joining channel...")
            success, channel_name, error = await join_channel(client, channel)
            await report_result("warmup", {"task_id": task_id, "task_type": "join_channel", "account_id": account.get("id"), "success": success, "error": error})
            return {"task_id": task_id, "success": success}
        
        elif task_type == "warmup_view_content":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  👁 [{phone}] Viewing content...")
            success, count, error = await view_channel_messages(client, channel)
            await report_result("warmup", {"task_id": task_id, "task_type": "view_content", "account_id": account.get("id"), "success": success, "error": error})
            return {"task_id": task_id, "success": success}
        
        elif task_type == "warmup_send_reaction":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  ⭐ [{phone}] Sending reaction...")
            success, reaction, error = await send_reaction(client, channel)
            await report_result("warmup", {"task_id": task_id, "task_type": "send_reaction", "account_id": account.get("id"), "success": success, "error": error})
            return {"task_id": task_id, "success": success}
        
        return {"task_id": task_id, "success": False, "error": f"Unknown: {task_type}"}
    except Exception as e:
        await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": False, "error": str(e)})
        return {"task_id": task_id, "success": False}


# ==================== MAIN RUNNER LOOPS ====================

async def campaign_loop():
    """Campaign tasks - batch parallel processing"""
    consecutive_empty = 0
    while RUNNING:
        try:
            batch_result = await get_batch_tasks(runner="campaign", batch_size=20)
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", 5)
            
            if batch_result.get("stop_signal"):
                break
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty % 12 == 1:
                    print("  📨 [CAMPAIGN] Waiting for tasks...")
                await asyncio.sleep(delay_after)
                continue
            
            consecutive_empty = 0
            print(f"\n  📦 [CAMPAIGN] Processing {len(tasks)} messages...")
            
            results = await asyncio.gather(*[process_campaign_task(task) for task in tasks], return_exceptions=True)
            
            for result in results:
                if isinstance(result, dict):
                    await report_result("send", result)
            
            success_count = sum(1 for r in results if isinstance(r, dict) and r.get("success"))
            print(f"  📊 [CAMPAIGN] Done: {success_count}/{len(results)} success")
            
            if delay_after > 0:
                await asyncio.sleep(delay_after)
        except Exception as e:
            print(f"  ⚠ [CAMPAIGN] Error: {e}")
            await asyncio.sleep(5)


async def livechat_loop():
    """LiveChat tasks - keep accounts connected, process send tasks"""
    global CONNECTED_LIVECHAT_IDS
    
    while RUNNING:
        try:
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                new_accounts = [acc for acc in accounts if acc.get("id") not in CONNECTED_LIVECHAT_IDS]
                if new_accounts:
                    print(f"  💬 [LIVECHAT] Connecting {len(new_accounts)} accounts...")
                    await asyncio.gather(*[
                        get_or_create_client(acc, setup_handler=setup_livechat_handler, task_proxy=acc.get("proxy"))
                        for acc in new_accounts
                    ], return_exceptions=True)
                    for acc in new_accounts:
                        if acc.get("id"):
                            CONNECTED_LIVECHAT_IDS.add(acc["id"])
                await asyncio.sleep(task.get("seconds", 1))
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                client = await get_or_create_client(account, setup_handler=setup_livechat_handler, task_proxy=task.get("proxy"))
                if client and recipient:
                    print(f"  ⚡ [LIVECHAT] Reply to {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {"message_id": msg.get("id"), "success": success, "error": error, "account_id": account.get("id")})
        except Exception as e:
            print(f"  ⚠ [LIVECHAT] Error: {e}")
            await asyncio.sleep(1)


async def account_loop():
    """Account tasks - SpamBot, name, photo, privacy, import, sync"""
    while RUNNING:
        try:
            task = await get_next_task(runner="account")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 2))
                continue
            
            account = task.get("account", {})
            task_id = task.get("task_id")
            task_data = task.get("task_data", {})
            phone = account.get("phone_number", "????")
            
            client = await get_or_create_client(account, task_proxy=task.get("proxy"))
            if not client:
                continue
            
            if task_type == "spambot_check":
                print(f"  🤖 [ACCOUNT] SpamBot check {phone}...")
                status, ban_reason, response = await check_spambot(client)
                await report_result("spambot_check", {"task_id": task_id, "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
                print(f"    Result: {status}")
            
            elif task_type == "change_name":
                print(f"  ✏️ [ACCOUNT] Changing name...")
                success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                await report_result("change_name", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
            
            elif task_type == "change_photo":
                print(f"  📷 [ACCOUNT] Changing photo...")
                photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
                success, error = await change_profile_photo(client, photo_source)
                await report_result("change_photo", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "privacy_settings":
                print(f"  🔒 [ACCOUNT] Updating privacy...")
                success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                await report_result("privacy_settings", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "change_password":
                print(f"  🔐 [ACCOUNT] Changing password...")
                success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                await report_result("change_password", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "logout_sessions":
                print(f"  🚪 [ACCOUNT] Logout other sessions...")
                success, error = await logout_other_sessions(client)
                await report_result("logout_sessions", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "contact_import":
                phone_numbers = task.get("phone_numbers", [])
                valid_numbers = list(task.get("valid_numbers", []))
                invalid_numbers = list(task.get("invalid_numbers", []))
                print(f"  📇 [ACCOUNT] Validating {len(phone_numbers)} contacts...")
                for phone_num in phone_numbers:
                    if not RUNNING:
                        break
                    try:
                        exists, name, telegram_id = await validate_contact(client, phone_num)
                        if exists:
                            valid_numbers.append(phone_num)
                        else:
                            invalid_numbers.append(phone_num)
                    except Exception as e:
                        err = str(e).lower()
                        if "flood" in err or "restricted" in err or "banned" in err:
                            remaining = [p for p in phone_numbers if p not in valid_numbers and p not in invalid_numbers]
                            await report_result("contact_import", {"task_id": task_id, "success": False, "account_failed": True, "failed_account_id": account.get("id"), "remaining_numbers": remaining, "valid_numbers": valid_numbers, "invalid_numbers": invalid_numbers, "error": str(e)})
                            break
                        invalid_numbers.append(phone_num)
                else:
                    await report_result("contact_import", {"task_id": task_id, "success": True, "valid_numbers": valid_numbers, "invalid_numbers": invalid_numbers})
                    print(f"    Done: {len(valid_numbers)} valid, {len(invalid_numbers)} invalid")
            
            elif task_type == "verify_session":
                print(f"  🔍 [ACCOUNT] Verifying session...")
                try:
                    me = await asyncio.wait_for(client.get_me(), timeout=10)
                    if me:
                        await report_result("verify_session", {"task_id": task_id, "account_id": account.get("id"), "status": "active", "user_data": {"telegram_id": me.id, "username": me.username, "first_name": me.first_name}})
                    else:
                        await report_result("verify_session", {"task_id": task_id, "account_id": account.get("id"), "status": "disconnected", "error": "No user info"})
                except Exception as e:
                    await report_result("verify_session", {"task_id": task_id, "account_id": account.get("id"), "status": "disconnected", "error": str(e)})
            
            elif task_type == "sync_profile":
                print(f"  🔄 [ACCOUNT] Syncing profile {phone}...")
                try:
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
                        await report_result("sync_profile", {"task_id": task_id, "account_id": account.get("id"), "success": True, "first_name": me.first_name, "last_name": me.last_name or "", "username": me.username, "telegram_id": me.id, "avatar_url": avatar_url})
                        print(f"    ✓ Synced: {me.first_name}")
                    else:
                        await report_result("sync_profile", {"task_id": task_id, "account_id": account.get("id"), "success": False, "error": "No user info"})
                except Exception as e:
                    await report_result("sync_profile", {"task_id": task_id, "account_id": account.get("id"), "success": False, "error": str(e)})
        
        except Exception as e:
            print(f"  ⚠ [ACCOUNT] Error: {e}")
            await asyncio.sleep(1)


async def warmup_loop():
    """Warmup tasks - batch parallel processing"""
    consecutive_empty = 0
    while RUNNING:
        try:
            batch_result = await get_batch_tasks(runner="warmup_chat", batch_size=20)
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", 5)
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty % 12 == 1:
                    print("  🔥 [WARMUP] Waiting for tasks...")
                
                # Check regular warmup tasks too
                regular_task = await get_next_task(runner="warmup")
                if regular_task.get("task") != "wait":
                    await process_warmup_task(regular_task)
                    consecutive_empty = 0
                else:
                    await asyncio.sleep(delay_after)
                continue
            
            consecutive_empty = 0
            print(f"\n  📦 [WARMUP] Processing {len(tasks)} tasks...")
            
            results = await asyncio.gather(*[process_warmup_task(task) for task in tasks], return_exceptions=True)
            
            success_count = sum(1 for r in results if isinstance(r, dict) and r.get("success"))
            print(f"  📊 [WARMUP] Done: {success_count}/{len(results)} success")
            
            await asyncio.sleep(delay_after)
        except Exception as e:
            print(f"  ⚠ [WARMUP] Error: {e}")
            await asyncio.sleep(2)


async def block_loop():
    """Block tasks - block/unblock contacts"""
    while RUNNING:
        try:
            task = await get_next_task(runner="block")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 2))
                continue
            
            if task_type == "block_contact":
                account = task.get("account", {})
                target = task.get("target", {})
                action = task.get("action", "block")
                
                client = await get_or_create_client(account, task_proxy=task.get("proxy"))
                if client:
                    print(f"  🚫 [BLOCK] {action.upper()}...")
                    try:
                        target_id = target.get("telegram_id") or target.get("username") or target.get("phone")
                        entity = await client.get_entity(target_id)
                        if action == "block":
                            await client(BlockRequest(id=entity))
                        else:
                            await client(UnblockRequest(id=entity))
                        await report_result("block_contact", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": True, "action": action})
                        print(f"    ✓ Done")
                    except Exception as e:
                        await report_result("block_contact", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": False, "error": str(e), "action": action})
                        print(f"    ✗ {e}")
        except Exception as e:
            print(f"  ⚠ [BLOCK] Error: {e}")
            await asyncio.sleep(1)


async def main():
    """Main entry point - runs all loops concurrently"""
    print("=" * 60)
    print("  TelegramCRM - Master Runner (ALL-IN-ONE)")
    print("=" * 60)
    print("  Running 5 tasks types in a SINGLE process:")
    print("    📨 Campaigns")
    print("    💬 LiveChat")
    print("    🤖 Account Management")
    print("    🔥 Warmup")
    print("    🚫 Block/Unblock")
    print("=" * 60)
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print()
    
    # Run all loops concurrently
    await asyncio.gather(
        campaign_loop(),
        livechat_loop(),
        account_loop(),
        warmup_loop(),
        block_loop(),
        return_exceptions=True
    )
    
    print("\n⏹ All loops stopped. Disconnecting...")
    await shutdown_all()
    print("✓ Goodbye!")


if __name__ == "__main__":
    print("\nStarting Master Runner... Press Ctrl+C to stop.\n")
    print("Required: pip install telethon httpx pysocks aiohttp\n")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹ Interrupted.")
