#!/usr/bin/env python3
"""
TelegramCRM - Unified Runner
==============================
Single process that handles ALL task types concurrently:
- Live chat (receiving messages, sending replies)
- Campaign messages
- Account management (spambot check, sync profile, etc.)
- Warmup tasks (pair chat, channel joins, reactions)

Benefits:
- NO session file conflicts (one client per account)
- Shared client pool = faster response
- Simpler to run (just one script)

Run: python unified_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import time
import random
import os
import base64

from telethon import events
from telethon.tl.functions.contacts import ImportContactsRequest
from telethon.tl.types import InputPhoneContact, User

from client_manager import (
    get_or_create_client, get_next_task, get_batch_tasks, report_result,
    send_message, shutdown_all, active_clients, send_heartbeat
)

# ========== CONFIGURATION ==========
RUNNING = True
POLL_INTERVAL = 1  # Main loop polling interval
KEEP_ALIVE_INTERVAL = 60  # Ping connections every 60 seconds
HEARTBEAT_INTERVAL = 30  # Send heartbeat every 30 seconds

# Warmup channels (safe public channels for building history)
WARMUP_CHANNELS = ["telegram", "durov", "TelegramTips", "android", "ios"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😊", "🎉", "💯", "⭐"]


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== LIVECHAT HANDLERS ==========

async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages - ONLY for campaign-initiated conversations"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            # Get sender with error handling
            try:
                sender = await event.get_sender()
            except Exception as sender_error:
                error_str = str(sender_error).lower()
                if any(x in error_str for x in ["private", "banned", "channel", "permission"]):
                    return
                raise
            
            if not sender:
                return
            
            # Skip channel/group messages
            if not isinstance(sender, User):
                return
            
            # Skip bots
            if getattr(sender, 'bot', False):
                return
            
            # Only process messages from contacts
            if not getattr(sender, 'contact', False):
                return
            
            # Get sender info
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
                                print(f"    ⚠ Photo upload failed: {upload_response.status_code}")
                except Exception as e:
                    print(f"    ⚠ Could not download/upload photo: {e}")
            
            # Get profile photo
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
            except:
                pass
            
            print(f"  📥 [IN] From {sender_name}: {content[:50]}...")
            
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


# ========== LIVECHAT TASK PROCESSING ==========

async def process_livechat_task(task: dict) -> dict:
    """Process a single livechat send task"""
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
        
        print(f"    {'✓ Sent!' if success else '✗ Failed: ' + str(error)}")
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


# ========== CAMPAIGN TASK PROCESSING ==========

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
        return {
            "success": False,
            "error": "Missing account or recipient",
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "account_id": account_id,
        }
    
    try:
        client = await get_or_create_client(account, task_proxy=proxy)
        
        if not client:
            return {
                "success": False,
                "error": "Could not connect client",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account_id,
            }
        
        # Small random delay to stagger sends
        await asyncio.sleep(random.uniform(0.5, 3))
        
        print(f"  📨 [{account_phone}] → {recipient}")
        
        success, error, meta = await send_message(
            client, recipient, content,
            msg.get("media_url")
        )
        
        # Check for sender-side errors
        is_sender_error = error and any(x in error.lower() for x in [
            "privacyrestricted", "privacy restricted", "userprivacyrestricted",
            "too many requests", "sendmessagerequest"
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
        
        if is_sender_error:
            result["skip_account"] = True
            result["retry_with_different_account"] = True
            print(f"    ⚠ [{account_phone}] Sender error (will retry)")
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


# ========== ACCOUNT MANAGEMENT TASK PROCESSING ==========

async def check_spambot(client):
    """Check SpamBot for account status"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        
        response_lower = response.lower()
        
        if "banned" in response_lower or "deleted" in response_lower:
            return "banned", response[:200], response
        if "limited" in response_lower or "restricted" in response_lower:
            return "restricted", "Limited by Telegram", response
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
            
        return "active", None, response
    except Exception as e:
        error_str = str(e).lower()
        if "banned" in error_str or "deleted" in error_str:
            return "banned", str(e), f"Connection error: {e}"
        return "active", None, f"SpamBot error: {e}"


async def change_name(client, first_name: str, last_name: str = ""):
    """Change account name"""
    from telethon.tl.functions.account import UpdateProfileRequest
    await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
    return True, None


async def change_profile_photo(client, photo_source: str):
    """Change profile photo"""
    from telethon.tl.functions.photos import UploadProfilePhotoRequest
    import aiohttp
    from client_manager import SESSION_FOLDER
    
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


async def update_privacy(client, hide_phone: bool, hide_last_seen: bool, disable_calls: bool):
    """Update privacy settings"""
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


async def logout_other_sessions(client):
    """Logout all other sessions"""
    from telethon.tl.functions.account import GetAuthorizationsRequest, ResetAuthorizationRequest
    
    result = await client(GetAuthorizationsRequest())
    terminated = 0
    for auth in result.authorizations:
        if auth.current:
            continue
        try:
            await client(ResetAuthorizationRequest(hash=auth.hash))
            terminated += 1
        except:
            pass
    return True, f"Terminated {terminated} session(s)"


async def verify_session(client, account_id: str):
    """Verify session status"""
    me = await asyncio.wait_for(client.get_me(), timeout=10)
    if not me:
        return "disconnected", "Could not get user info", None
    
    try:
        await asyncio.wait_for(client.get_dialogs(limit=1), timeout=10)
    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["deleted", "deactivated", "banned"]):
            return "banned", f"Account deleted: {e}", None
    
    return "active", None, {
        "telegram_id": me.id,
        "username": me.username,
        "first_name": me.first_name,
        "last_name": me.last_name
    }


async def process_account_task(task: dict):
    """Process a single account management task"""
    task_type = task.get("task")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    task_proxy = task.get("proxy")
    
    phone = account.get("phone_number", "????")[-4:]
    
    try:
        if task_type == "sync_profile":
            print(f"  🔄 [{phone}] Syncing profile...")
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
            return
        
        client = await get_or_create_client(account, task_proxy=task_proxy)
        if not client:
            await report_result(task_type, {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": False,
                "error": "Could not connect"
            })
            return
        
        if task_type == "spambot_check":
            print(f"  🤖 [{phone}] SpamBot check...")
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
            print(f"  ✏️ [{phone}] Changing name...")
            success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
            await report_result("change_name", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "error": error,
                "first_name": task_data.get("first_name"),
                "last_name": task_data.get("last_name")
            })
            print(f"    {'✓ Done' if success else '✗ Failed'}")
        
        elif task_type == "change_photo":
            print(f"  📷 [{phone}] Changing photo...")
            photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
            success, error = await change_profile_photo(client, photo_source)
            await report_result("change_photo", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "error": error
            })
            print(f"    {'✓ Done' if success else '✗ Failed'}")
        
        elif task_type == "privacy_settings":
            print(f"  🔒 [{phone}] Updating privacy...")
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
            print(f"    {'✓ Done' if success else '✗ Failed'}")
        
        elif task_type == "logout_sessions":
            print(f"  🚪 [{phone}] Logging out other sessions...")
            success, error = await logout_other_sessions(client)
            await report_result("logout_sessions", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "error": error
            })
            print(f"    {'✓ Done' if success else '✗ Failed'}")
        
        elif task_type == "verify_session":
            print(f"  🔍 [{phone}] Verifying session...")
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
            print(f"  ❓ Unknown account task: {task_type}")
    
    except Exception as e:
        print(f"  ⚠ Account task error [{phone}]: {e}")
        await report_result(task_type or "unknown", {
            "task_id": task_id,
            "account_id": account.get("id"),
            "success": False,
            "error": str(e)
        })


# ========== WARMUP TASK PROCESSING ==========

async def add_contact(client, phone: str, first_name: str, last_name: str = ""):
    """Add a contact"""
    contact = InputPhoneContact(client_id=0, phone=phone, first_name=first_name, last_name=last_name)
    result = await client(ImportContactsRequest([contact]))
    if result.imported:
        return True, phone, None
    return True, phone, "Contact exists or invalid"


async def send_warmup_chat(client, recipient_phone: str, message: str, recipient_telegram_id=None, recipient_username=None, recipient_first_name=None):
    """Send warmup chat message"""
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
    total_time = min(base_delay + typing_delay + random.uniform(0, 2), 15)
    
    async with client.action(user, 'typing'):
        await asyncio.sleep(total_time)
    
    await client.send_message(user, message)
    await asyncio.sleep(random.uniform(0.5, 2))
    
    return True, None


async def join_channel(client, channel_username=None):
    """Join a public channel"""
    from telethon.tl.functions.channels import JoinChannelRequest
    
    channel = channel_username or random.choice(WARMUP_CHANNELS)
    entity = await client.get_entity(channel)
    await client(JoinChannelRequest(entity))
    await asyncio.sleep(random.uniform(1, 3))
    
    return True, channel, None


async def process_warmup_task(task: dict):
    """Process a single warmup task"""
    task_type = task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    is_cycle_last = task.get("is_cycle_last", False)
    
    phone = account.get("phone_number", "????")[-4:]
    
    try:
        task_proxy = account.get("proxy")
        client = await get_or_create_client(account, task_proxy=task_proxy)
        
        if not client:
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": False,
                "error": "Could not connect client",
                "is_cycle_last": is_cycle_last,
            })
            return
        
        if task_type == "warmup_add_contact":
            target_phone = task_data.get("phone") or task_data.get("recipient_phone")
            first_name = task_data.get("first_name", "Friend")
            
            print(f"  👤 [{phone}] Saving contact...")
            success, _, error = await add_contact(client, target_phone, first_name)
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
        
        elif task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            recipient_tid = task_data.get("recipient_telegram_id")
            recipient_username = task_data.get("recipient_username")
            recipient_first_name = task_data.get("first_name")
            message = task_data.get("message", "Hey! 👋")
            
            print(f"  🔥 [{phone}] Warmup chat...")
            success, error = await send_warmup_chat(
                client, recipient_phone, message,
                recipient_tid, recipient_username, recipient_first_name
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
            print(f"    {'✓' if success else '✗'} {message[:30]}...")
        
        elif task_type in ("join_channel", "warmup_join_channel"):
            channel = task_data.get("channel") or task_data.get("channel_username")
            print(f"  📢 [{phone}] Joining channel...")
            success, channel_name, error = await join_channel(client, channel)
            await report_result("warmup", {
                "task_id": task_id,
                "account_id": account.get("id"),
                "success": success,
                "channel": channel_name,
                "error": error
            })
            print(f"    {'✓' if success else '✗'} Joined {channel_name}")
        
        else:
            print(f"  ❓ Unknown warmup task: {task_type}")
    
    except Exception as e:
        print(f"  ⚠ Warmup task error [{phone}]: {e}")
        await report_result("warmup_chat", {
            "task_id": task_id,
            "pair_id": pair_id,
            "account_id": account.get("id"),
            "success": False,
            "error": str(e),
            "is_cycle_last": is_cycle_last,
        })


# ========== MAIN UNIFIED LOOP ==========

async def main_loop():
    """Main unified loop - handles ALL task types concurrently"""
    global RUNNING
    
    print("=" * 70)
    print("  TelegramCRM - UNIFIED RUNNER")
    print("=" * 70)
    print("  📥 Live Chat: Incoming messages + replies")
    print("  📨 Campaigns: Parallel batch sending")
    print("  🔧 Account:   Sync profile, spambot check, etc.")
    print("  🔥 Warmup:    Pair chat, channel joins")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 70)
    print("\n✓ Starting unified runner...\n")
    
    connected_ids = set()
    last_keep_alive = time.time()
    last_heartbeat = time.time()
    
    # Send initial heartbeat
    await send_heartbeat("unified")
    
    while RUNNING:
        try:
            # 1. Poll for livechat tasks (highest priority - real-time)
            livechat_batch = await get_batch_tasks(runner="livechat", batch_size=50)
            livechat_tasks = livechat_batch.get("tasks", [])
            livechat_accounts = livechat_batch.get("accounts", [])
            
            # 2. Connect new accounts for incoming message listening
            new_accounts = [acc for acc in livechat_accounts if acc.get("id") not in connected_ids]
            if new_accounts:
                print(f"  🔌 Connecting {len(new_accounts)} accounts for livechat...")
                await asyncio.gather(
                    *[get_or_create_client(acc, setup_handler=setup_message_handler, task_proxy=acc.get("proxy")) 
                      for acc in new_accounts],
                    return_exceptions=True
                )
                for acc in new_accounts:
                    if acc.get("id"):
                        connected_ids.add(acc["id"])
            
            # 3. Process livechat send tasks
            if livechat_tasks:
                print(f"\n  📦 Processing {len(livechat_tasks)} livechat tasks...")
                results = await asyncio.gather(
                    *[process_livechat_task(task) for task in livechat_tasks],
                    return_exceptions=True
                )
                for result in results:
                    if isinstance(result, dict):
                        await report_result("send", result)
            
            # 4. Poll for campaign tasks
            campaign_batch = await get_batch_tasks(runner="campaign")
            campaign_tasks = campaign_batch.get("tasks", [])
            
            if campaign_tasks:
                print(f"\n  📨 Processing {len(campaign_tasks)} campaign tasks...")
                results = await asyncio.gather(
                    *[process_campaign_task(task) for task in campaign_tasks],
                    return_exceptions=True
                )
                for result in results:
                    if isinstance(result, dict):
                        await report_result("send", result)
            
            # 5. Poll for account management tasks (use connected clients!)
            account_task = await get_next_task(runner="account")
            if account_task.get("task") != "wait":
                await process_account_task(account_task)
            
            # 6. Poll for warmup tasks
            warmup_batch = await get_batch_tasks(runner="warmup_chat")
            warmup_tasks = warmup_batch.get("tasks", [])
            
            if warmup_tasks:
                print(f"\n  🔥 Processing {len(warmup_tasks)} warmup tasks...")
                await asyncio.gather(
                    *[process_warmup_task(task) for task in warmup_tasks],
                    return_exceptions=True
                )
            
            # Also check for regular warmup tasks (channel joins, etc.)
            regular_warmup = await get_next_task(runner="warmup")
            if regular_warmup.get("task") != "wait":
                await process_warmup_task(regular_warmup)
            
            # 7. Keep-alive ping
            if time.time() - last_keep_alive > KEEP_ALIVE_INTERVAL:
                print("  💓 Keep-alive check...")
                await ping_connected_clients()
                last_keep_alive = time.time()
            
            # 8. Send heartbeat
            if time.time() - last_heartbeat > HEARTBEAT_INTERVAL:
                await send_heartbeat("unified")
                last_heartbeat = time.time()
            
            # 9. Short sleep before next iteration
            await asyncio.sleep(POLL_INTERVAL)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(1)
    
    print("\n⏹ Unified runner stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Unified Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx aiohttp")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
