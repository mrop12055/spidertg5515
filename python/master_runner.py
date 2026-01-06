#!/usr/bin/env python3
"""
TelegramCRM - Master Runner
============================
UNIFIED runner that handles ALL tasks with SINGLE session per account.

Features:
- Connects to each account ONCE and keeps connection alive
- Handles: Campaigns, Live Chat, Warmup, Account Management
- Parallel batch processing for speed
- Automatic reconnection on disconnect
- Shared client pool across all task types

Run: python master_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import random
import time
import os
import base64
import tempfile
from typing import Dict, Optional

import httpx
import socks
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError
from telethon.network.connection import ConnectionTcpFull

from config import BACKEND_URL, SUPABASE_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

# ========== CONFIGURATION ==========
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")
CONNECTION_TIMEOUT = 30
CONNECTION_RETRIES = 3
RETRY_DELAY = 2

# Polling intervals (in seconds)
CAMPAIGN_POLL = 3      # Check campaign tasks
WARMUP_POLL = 5        # Check warmup tasks
ACCOUNT_POLL = 2       # Check account tasks
LIVECHAT_POLL = 1      # Check live chat tasks
KEEP_ALIVE = 60        # Keep-alive ping

# Warmup channels
WARMUP_CHANNELS = ["telegram", "durov", "TelegramTips", "android", "ios"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😊", "🎉", "💯", "⭐"]

# ========== GLOBAL STATE ==========
RUNNING = True
active_clients: Dict[str, TelegramClient] = {}
handler_installed: set = set()  # Track which accounts have message handlers


def signal_handler(sig, frame):
    global RUNNING
    print("\n⏹ Stop signal received. Shutting down gracefully...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== CLIENT MANAGEMENT ==========

def decode_session_file(phone_number: str, base64_data: str) -> Optional[str]:
    """Decode base64 session data and save to temp file"""
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    try:
        session_bytes = base64.b64decode(base64_data)
        with open(session_path + ".session", "wb") as f:
            f.write(session_bytes)
        return session_path
    except Exception as e:
        print(f"  [ERROR] Session decode failed: {e}")
        return None


def get_proxy_settings(account: dict, task_proxy: dict = None) -> Optional[tuple]:
    """Extract proxy settings from account or task"""
    proxy = task_proxy or account.get("proxy")
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
    elif proxy_type in ("http", "https"):
        ptype = socks.HTTP
    else:
        ptype = socks.SOCKS5
    
    if username and password:
        return (ptype, host, int(port), True, username, password)
    return (ptype, host, int(port))


async def connect_with_retry(client: TelegramClient, max_retries: int = CONNECTION_RETRIES) -> tuple:
    """Connect with retry logic"""
    last_error = ""
    for attempt in range(1, max_retries + 1):
        try:
            await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
            return True, ""
        except asyncio.TimeoutError:
            last_error = "Connection timeout"
        except Exception as e:
            last_error = str(e)
        
        if attempt < max_retries:
            await asyncio.sleep(RETRY_DELAY * attempt)
    
    return False, last_error


async def get_or_create_client(account: dict, task_proxy: dict = None, install_handler: bool = False) -> Optional[TelegramClient]:
    """Get existing client or create new one - SHARED across all runners"""
    account_id = account["id"]
    
    # Return cached client if connected
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                # Install handler if needed
                if install_handler and account_id not in handler_installed:
                    await setup_message_handler(client, account_id)
                    handler_installed.add(account_id)
                return client
        except:
            del active_clients[account_id]
    
    session_data = account.get("session_data")
    if not session_data:
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    # Get device fingerprint
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version")
    lang_code = account.get("lang_code") or "en"
    system_lang_code = account.get("system_lang_code") or "en-US"
    
    if not device_model or not system_version:
        fp = generate_fingerprint()
        device_model = fp["device_model"]
        system_version = fp["system_version"]
        app_version = fp["app_version"]
        lang_code = fp["lang_code"]
        system_lang_code = fp["system_lang_code"]
        await report_result("fingerprint_generated", {
            "account_id": account_id,
            "device_model": device_model,
            "system_version": system_version,
            "app_version": app_version,
            "lang_code": lang_code,
            "system_lang_code": system_lang_code
        })
    
    proxy = get_proxy_settings(account, task_proxy)
    
    # Get API credentials
    api_creds = account.get("telegram_api_credentials")
    if api_creds and api_creds.get("api_id") and api_creds.get("api_hash"):
        api_id = api_creds["api_id"]
        api_hash = api_creds["api_hash"]
    else:
        api_id = account.get("api_id") or TELEGRAM_API_ID
        api_hash = account.get("api_hash") or TELEGRAM_API_HASH
    
    try:
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
        
        connected, connect_error = await connect_with_retry(client)
        if not connected:
            await report_result("account_disconnected", {"account_id": account_id, "reason": connect_error})
            return None
        
        if not await client.is_user_authorized():
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        # Verify account is active
        try:
            me = await asyncio.wait_for(client.get_me(), timeout=15)
            if not me:
                await report_result("account_banned", {"account_id": account_id, "reason": "Account deleted"})
                return None
        except Exception as me_error:
            error_str = str(me_error).lower()
            if any(x in error_str for x in ["user_deactivated", "deactivated"]):
                await report_result("account_frozen", {"account_id": account_id, "reason": str(me_error)})
                return None
            elif any(x in error_str for x in ["banned", "deleted"]):
                await report_result("account_banned", {"account_id": account_id, "reason": str(me_error)})
                return None
            elif any(x in error_str for x in ["session", "revoked", "auth"]):
                await report_result("account_disconnected", {"account_id": account_id, "reason": str(me_error)})
                return None
        
        # Install message handler if requested
        if install_handler:
            await setup_message_handler(client, account_id)
            handler_installed.add(account_id)
        
        active_clients[account_id] = client
        
        # Sync profile on first connection
        await sync_profile(client, account_id)
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
        
    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["deleted", "banned", "deactivated"]):
            await report_result("account_banned", {"account_id": account_id, "reason": str(e)})
        return None


async def sync_profile(client: TelegramClient, account_id: str):
    """Sync profile data to backend"""
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if me:
            avatar_base64 = None
            try:
                photos = await asyncio.wait_for(client.get_profile_photos(me, limit=1), timeout=10)
                if photos:
                    photo_bytes = await asyncio.wait_for(client.download_media(photos[0], file=bytes), timeout=15)
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
    except Exception as e:
        print(f"  [WARN] Profile sync error: {e}")


# ========== API HELPERS ==========

async def get_batch_tasks(runner: str, batch_size: int = 10) -> dict:
    """Get batch of tasks from backend"""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-batch-tasks",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={"runner": runner, "batch_size": batch_size}
            )
            return resp.json()
    except:
        return {"tasks": [], "delay_after": 5}


async def get_next_task(runner: str) -> dict:
    """Get single task from backend"""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={"runner": runner}
            )
            return resp.json()
    except:
        return {"task": "wait", "seconds": 1}


async def report_result(task_type: str, result: dict):
    """Report result to backend"""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{BACKEND_URL}/report-task-result",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={"task_type": task_type, "result": result}
            )
    except Exception as e:
        print(f"  [WARN] Failed to report: {e}")


# ========== MESSAGE SENDING ==========

async def send_message(client: TelegramClient, recipient, content: str, media_url: str = None):
    """Send message to recipient"""
    meta = None
    try:
        entity = None
        
        if isinstance(recipient, int):
            entity = await asyncio.wait_for(client.get_entity(recipient), timeout=10)
        else:
            recipient_str = str(recipient or "").strip()
            if recipient_str.isdigit():
                entity = await asyncio.wait_for(client.get_entity(int(recipient_str)), timeout=10)
            elif recipient_str.startswith("@"):
                entity = await asyncio.wait_for(client.get_entity(recipient_str), timeout=15)
            else:
                from telethon.tl.functions.contacts import ImportContactsRequest
                from telethon.tl.types import InputPhoneContact
                
                phone = recipient_str if recipient_str.startswith("+") else "+" + recipient_str
                
                try:
                    entity = await asyncio.wait_for(client.get_entity(phone), timeout=10)
                except:
                    pass
                
                if not entity:
                    contact = InputPhoneContact(
                        client_id=random.randint(0, 2**62),
                        phone=phone,
                        first_name="TG",
                        last_name=str(random.randint(1000, 9999))
                    )
                    result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
                    if result.users:
                        entity = result.users[0]
        
        if not entity:
            return False, "User not found on Telegram", None
        
        meta = {
            "recipient_telegram_id": getattr(entity, "id", None),
            "recipient_username": getattr(entity, "username", None),
        }
        
        # Format URLs as clickable
        import re
        formatted_content = content
        parse_mode = None
        url_re = re.compile(r'(https?://[^\s<>"\']+)')
        if content and url_re.search(content):
            parse_mode = 'md'
            formatted_content = url_re.sub(lambda m: f"[{m.group(1)}]({m.group(1)})", content)
        
        # Send with media if provided
        if media_url:
            try:
                import io
                async with httpx.AsyncClient(timeout=30) as http:
                    media_resp = await http.get(media_url)
                    if media_resp.status_code == 200:
                        from urllib.parse import urlparse, unquote
                        url_path = urlparse(media_url).path
                        filename = unquote(url_path.split("/")[-1]) if url_path else "attachment"
                        content_type = media_resp.headers.get("content-type", "").lower()
                        ext = filename.split(".")[-1].lower() if "." in filename else ""
                        is_image = ext in ("jpg", "jpeg", "png", "gif", "webp") or content_type.startswith("image/")
                        
                        file_bytes = io.BytesIO(media_resp.content)
                        file_bytes.name = filename if "." in filename else "photo.jpg"
                        await asyncio.wait_for(
                            client.send_file(entity, file_bytes, caption=formatted_content, force_document=not is_image, parse_mode=parse_mode),
                            timeout=30
                        )
                    else:
                        await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
            except:
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
        else:
            await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
        
        return True, None, meta
    except asyncio.TimeoutError:
        return False, "Request timeout", meta
    except UserPrivacyRestrictedError as e:
        return False, f"UserPrivacyRestrictedError: {e}", meta
    except FloodWaitError as e:
        return False, f"FloodWaitError: {e.seconds}s wait required", meta
    except Exception as e:
        return False, f"{type(e).__name__}: {e}", meta


# ========== LIVE CHAT HANDLER ==========

async def setup_message_handler(client: TelegramClient, account_id: str):
    """Set up handler for incoming messages"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            try:
                sender = await event.get_sender()
            except:
                return
            
            if not sender:
                return
            
            from telethon.tl.types import User
            if not isinstance(sender, User) or getattr(sender, 'bot', False):
                return
            
            # Only process contacts
            if not getattr(sender, 'contact', False):
                return
            
            first_name = getattr(sender, 'first_name', None) or ''
            last_name = getattr(sender, 'last_name', None) or ''
            sender_name = f"{first_name} {last_name}".strip() or str(sender.id)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            
            content = event.message.text or "[Media message]"
            media_url = None
            media_type = None
            
            # Handle photos
            if event.message.photo:
                content = "[Photo] " + (event.message.text or "")
                media_type = "image"
                try:
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        async with httpx.AsyncClient(timeout=30.0) as http:
                            upload_response = await http.put(
                                f"{SUPABASE_URL}/storage/v1/object/message-attachments/{file_path}",
                                headers={
                                    "apikey": SUPABASE_KEY,
                                    "Authorization": f"Bearer {SUPABASE_KEY}",
                                    "Content-Type": "image/jpeg",
                                    "x-upsert": "true"
                                },
                                content=photo_bytes
                            )
                            if upload_response.status_code in (200, 201):
                                media_url = f"{SUPABASE_URL}/storage/v1/object/public/message-attachments/{file_path}"
                except:
                    pass
            
            # Get avatar
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
                "sender_username": getattr(sender, 'username', None),
                "sender_phone": sender_phone,
                "sender_avatar": avatar_base64,
                "content": content,
                "media_url": media_url,
                "media_type": media_type
            })
        except Exception as e:
            print(f"  ⚠ Handler error: {e}")


# ========== ACCOUNT MANAGEMENT FUNCTIONS ==========

async def check_spambot(client):
    """Check SpamBot status"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        
        response_lower = response.lower()
        if "banned" in response_lower or "deleted" in response_lower:
            return "banned", response[:200], response
        if "limited" in response_lower or "restricted" in response_lower or "frozen" in response_lower:
            return "restricted", "Limited by Telegram", response
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
        return "active", None, response
    except Exception as e:
        error_str = str(e).lower()
        if "banned" in error_str or "deleted" in error_str:
            return "banned", str(e), f"Error: {e}"
        return "active", None, f"SpamBot error: {e}"


async def change_name(client, first_name: str, last_name: str = ""):
    """Change account name"""
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_source: str):
    """Change profile photo from URL or base64"""
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
                        return False, f"Failed to download: HTTP {resp.status}"
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


async def update_privacy(client, hide_phone: bool, hide_last_seen: bool, disable_calls: bool):
    """Update privacy settings"""
    try:
        from telethon.tl.functions.account import SetPrivacyRequest
        from telethon.tl.types import InputPrivacyKeyPhoneNumber, InputPrivacyKeyStatusTimestamp, InputPrivacyKeyPhoneCall, InputPrivacyValueDisallowAll
        
        if hide_phone:
            await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneNumber(), rules=[InputPrivacyValueDisallowAll()]))
        if hide_last_seen:
            await client(SetPrivacyRequest(key=InputPrivacyKeyStatusTimestamp(), rules=[InputPrivacyValueDisallowAll()]))
        if disable_calls:
            await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneCall(), rules=[InputPrivacyValueDisallowAll()]))
        return True, None
    except Exception as e:
        return False, str(e)


async def logout_other_sessions(client):
    """Logout all other sessions"""
    try:
        from telethon.tl.functions.account import GetAuthorizationsRequest, ResetAuthorizationRequest
        result = await client(GetAuthorizationsRequest())
        terminated = 0
        for auth in result.authorizations:
            if not auth.current:
                try:
                    await client(ResetAuthorizationRequest(hash=auth.hash))
                    terminated += 1
                except:
                    pass
        return True, f"Terminated {terminated} session(s)"
    except Exception as e:
        return False, str(e)


# ========== WARMUP FUNCTIONS ==========

async def join_channel(client, channel_username: str = None):
    """Join a public channel"""
    try:
        from telethon.tl.functions.channels import JoinChannelRequest
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        await client(JoinChannelRequest(entity))
        await asyncio.sleep(random.uniform(1, 3))
        return True, channel, None
    except Exception as e:
        if "already" in str(e).lower():
            return True, channel_username, "Already joined"
        return False, channel_username, str(e)


async def view_channel_messages(client, channel_username: str = None):
    """View messages in a channel"""
    try:
        from telethon.tl.functions.messages import GetHistoryRequest, ReadHistoryRequest
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        history = await client(GetHistoryRequest(
            peer=entity, limit=20, offset_date=None, offset_id=0, max_id=0, min_id=0, add_offset=0, hash=0
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


async def send_reaction(client, channel_username: str = None):
    """Send reaction to a message"""
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
                return True, channel, reaction
            except:
                return True, channel, "Viewed (reactions disabled)"
        return True, channel, "No messages"
    except Exception as e:
        return False, channel_username, str(e)


async def send_warmup_chat(client, recipient_phone: str, message: str, recipient_telegram_id: int = None, recipient_username: str = None, recipient_first_name: str = None):
    """Send warmup chat with human-like typing"""
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
        
        # Human-like typing
        typing_time = min(2 + len(message) * 0.1 + random.uniform(0, 2), 15)
        async with client.action(user, 'typing'):
            await asyncio.sleep(typing_time)
        
        await client.send_message(user, message)
        await asyncio.sleep(random.uniform(0.5, 2))
        return True, None
    except Exception as e:
        return False, str(e)


async def add_contact(client, phone: str, first_name: str, last_name: str = ""):
    """Add a contact"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        contact = InputPhoneContact(client_id=0, phone=phone, first_name=first_name, last_name=last_name)
        result = await client(ImportContactsRequest([contact]))
        return True, phone, None if result.imported else "Contact exists"
    except Exception as e:
        return False, phone, str(e)


# ========== TASK PROCESSORS ==========

async def process_campaign_task(task: dict) -> dict:
    """Process campaign send task"""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    account = task.get("account", {})
    proxy = task.get("proxy")
    content = msg.get("content", "")
    account_id = account.get("id")
    
    try:
        client = await get_or_create_client(account, task_proxy=proxy, install_handler=True)
        if not client:
            return {"success": False, "error": "Could not connect", "campaign_recipient_id": msg.get("campaign_recipient_id"), "account_id": account_id}
        
        await asyncio.sleep(random.uniform(0.5, 3))  # Human-like stagger
        
        success, error, meta = await send_message(client, recipient, content, msg.get("media_url"))
        
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
        
        if error and any(x in error.lower() for x in ["privacyrestricted", "too many requests"]):
            result["skip_account"] = True
            result["retry_with_different_account"] = True
        
        if meta:
            result.update(meta)
        
        return result
    except Exception as e:
        return {"success": False, "error": str(e), "campaign_recipient_id": msg.get("campaign_recipient_id"), "account_id": account_id}


async def process_livechat_task(task: dict) -> dict:
    """Process live chat send task"""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_tid = task.get("recipient_telegram_id")
    account = task.get("account", {})
    
    try:
        client = await get_or_create_client(account, task_proxy=task.get("proxy"), install_handler=True)
        if not client:
            return {"message_id": msg.get("id"), "success": False, "error": "Could not connect", "account_id": account.get("id")}
        
        target = recipient_tid if recipient_tid else recipient
        success, error, meta = await send_message(client, target, msg.get("content", ""), msg.get("media_url"))
        
        result = {"message_id": msg.get("id"), "success": success, "error": error, "account_id": account.get("id")}
        if meta:
            result.update(meta)
        return result
    except Exception as e:
        return {"message_id": msg.get("id"), "success": False, "error": str(e), "account_id": account.get("id")}


async def process_warmup_task(task: dict) -> dict:
    """Process warmup task"""
    task_type = task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    is_cycle_last = task.get("is_cycle_last", False)
    
    try:
        client = await get_or_create_client(account, task_proxy=account.get("proxy"))
        if not client:
            await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": False, "error": "Could not connect", "is_cycle_last": is_cycle_last})
            return {"task_id": task_id, "success": False}
        
        if task_type == "warmup_add_contact":
            success, _, error = await add_contact(client, task_data.get("phone") or task_data.get("recipient_phone"), task_data.get("first_name", "Friend"))
            await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": success, "error": error, "message_type": "add_contact", "is_cycle_last": is_cycle_last})
            return {"task_id": task_id, "success": success}
        
        elif task_type == "warmup_chat":
            success, error = await send_warmup_chat(client, task_data.get("recipient_phone"), task_data.get("message", "Hey! 👋"), task_data.get("recipient_telegram_id"), task_data.get("recipient_username"), task_data.get("first_name"))
            await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": success, "error": error, "message_type": "text", "is_cycle_last": is_cycle_last})
            return {"task_id": task_id, "success": success}
        
        return {"task_id": task_id, "success": False, "error": f"Unknown task: {task_type}"}
    except Exception as e:
        await report_result("warmup_chat", {"task_id": task_id, "pair_id": pair_id, "account_id": account.get("id"), "success": False, "error": str(e), "is_cycle_last": is_cycle_last})
        return {"task_id": task_id, "success": False}


async def process_account_task(task: dict):
    """Process account management task"""
    task_type = task.get("task", "wait")
    if task_type == "wait":
        return
    
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    task_proxy = task.get("proxy")
    phone = account.get("phone_number", "???")
    
    client = await get_or_create_client(account, task_proxy=task_proxy)
    if not client and task_type != "sync_profile":
        await report_result(task_type, {"task_id": task_id, "account_id": account.get("id"), "success": False, "error": "Could not connect"})
        return
    
    if task_type == "spambot_check":
        print(f"  🤖 SpamBot check: {phone}")
        status, ban_reason, response = await check_spambot(client)
        await report_result("spambot_check", {"task_id": task_id, "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
    
    elif task_type == "change_name":
        print(f"  ✏️ Changing name: {phone}")
        success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
        await report_result("change_name", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
    
    elif task_type == "change_photo":
        print(f"  📷 Changing photo: {phone}")
        photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
        success, error = await change_profile_photo(client, photo_source)
        await report_result("change_photo", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error})
    
    elif task_type == "privacy_settings":
        print(f"  🔒 Updating privacy: {phone}")
        success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
        await report_result("privacy_settings", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error})
    
    elif task_type == "logout_sessions":
        print(f"  🚪 Logging out sessions: {phone}")
        success, error = await logout_other_sessions(client)
        await report_result("logout_sessions", {"task_id": task_id, "account_id": account.get("id"), "success": success, "error": error})
    
    elif task_type == "sync_profile":
        print(f"  🔄 Syncing profile: {phone}")
        client = await get_or_create_client(account, task_proxy=task_proxy)
        if client:
            await sync_profile(client, account.get("id"))
            await report_result("sync_profile", {"task_id": task_id, "account_id": account.get("id"), "success": True})
        else:
            await report_result("sync_profile", {"task_id": task_id, "account_id": account.get("id"), "success": False, "error": "Could not connect"})


# ========== MAIN LOOP ==========

async def campaign_loop():
    """Campaign task processor"""
    consecutive_empty = 0
    while RUNNING:
        try:
            batch = await get_batch_tasks("campaign")
            tasks = batch.get("tasks", [])
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print("  ⏳ No campaign tasks")
                await asyncio.sleep(batch.get("delay_after", CAMPAIGN_POLL))
                continue
            
            consecutive_empty = 0
            print(f"\n  📨 Campaign batch: {len(tasks)} messages")
            
            results = await asyncio.gather(*[process_campaign_task(t) for t in tasks], return_exceptions=True)
            
            success = sum(1 for r in results if isinstance(r, dict) and r.get("success"))
            print(f"  📊 Campaign: {success}/{len(results)} success")
            
            for result in results:
                if isinstance(result, dict):
                    await report_result("send", result)
            
            await asyncio.sleep(batch.get("delay_after", CAMPAIGN_POLL))
        except Exception as e:
            print(f"  ⚠ Campaign error: {e}")
            await asyncio.sleep(5)


async def livechat_loop():
    """Live chat processor"""
    last_keepalive = time.time()
    while RUNNING:
        try:
            batch = await get_batch_tasks("livechat", batch_size=50)
            tasks = batch.get("tasks", [])
            accounts = batch.get("accounts", [])
            
            # Connect new accounts (for incoming message handlers)
            for acc in accounts:
                if acc.get("id") not in active_clients:
                    await get_or_create_client(acc, task_proxy=acc.get("proxy"), install_handler=True)
            
            # Process send tasks
            if tasks:
                print(f"\n  ⚡ Live chat: {len(tasks)} messages")
                results = await asyncio.gather(*[process_livechat_task(t) for t in tasks], return_exceptions=True)
                for result in results:
                    if isinstance(result, dict):
                        await report_result("send", result)
            
            # Keep-alive
            if time.time() - last_keepalive > KEEP_ALIVE:
                for acc_id, client in list(active_clients.items()):
                    try:
                        if not client.is_connected():
                            del active_clients[acc_id]
                        else:
                            await asyncio.wait_for(client.get_me(), timeout=5)
                    except:
                        del active_clients[acc_id]
                last_keepalive = time.time()
            
            await asyncio.sleep(LIVECHAT_POLL)
        except Exception as e:
            print(f"  ⚠ Livechat error: {e}")
            await asyncio.sleep(1)


async def warmup_loop():
    """Warmup task processor"""
    consecutive_empty = 0
    while RUNNING:
        try:
            batch = await get_batch_tasks("warmup_chat")
            tasks = batch.get("tasks", [])
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print("  ⏳ No warmup tasks")
                await asyncio.sleep(batch.get("delay_after", WARMUP_POLL))
                continue
            
            consecutive_empty = 0
            print(f"\n  🔥 Warmup batch: {len(tasks)} tasks")
            
            results = await asyncio.gather(*[process_warmup_task(t) for t in tasks], return_exceptions=True)
            success = sum(1 for r in results if isinstance(r, dict) and r.get("success"))
            print(f"  📊 Warmup: {success}/{len(results)} success")
            
            await asyncio.sleep(batch.get("delay_after", WARMUP_POLL))
        except Exception as e:
            print(f"  ⚠ Warmup error: {e}")
            await asyncio.sleep(2)


async def account_loop():
    """Account management task processor"""
    while RUNNING:
        try:
            task = await get_next_task("account")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", ACCOUNT_POLL))
                continue
            
            await process_account_task(task)
            await asyncio.sleep(0.5)
        except Exception as e:
            print(f"  ⚠ Account error: {e}")
            await asyncio.sleep(1)


async def main():
    """Main entry point - runs all loops concurrently"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - MASTER RUNNER")
    print("=" * 60)
    print("  📨 Campaign | ⚡ Live Chat | 🔥 Warmup | 🔧 Account")
    print("  ✨ Single session per account - maximum efficiency")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting all runners concurrently...\n")
    
    try:
        await asyncio.gather(
            campaign_loop(),
            livechat_loop(),
            warmup_loop(),
            account_loop(),
        )
    except asyncio.CancelledError:
        pass
    finally:
        print("\n[SHUTDOWN] Disconnecting all clients...")
        for client in active_clients.values():
            try:
                await asyncio.wait_for(client.disconnect(), timeout=5)
            except:
                pass
        active_clients.clear()
        print("[OK] All clients disconnected. Goodbye!")


if __name__ == "__main__":
    print("Starting Master Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx pysocks aiohttp")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
