"""
TelegramCRM - Client Manager
=============================
Shared Telegram client logic for all runners with optimized connection speed
"""

import os
import base64
import tempfile
import asyncio
import httpx
import socks
from typing import Dict, Optional

from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError
from telethon.network.connection import ConnectionTcpFull

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

# Temp folder for session files
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")

# Active clients cache
active_clients: Dict[str, TelegramClient] = {}

# Connection settings for speed
CONNECTION_TIMEOUT = 30  # Increased timeout
CONNECTION_RETRIES = 3   # Retry attempts
RETRY_DELAY = 2          # Delay between retries


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


def get_proxy_settings(account: dict) -> Optional[tuple]:
    """Extract proxy settings from account data"""
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
    
    # Map proxy type to socks type
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
    else:
        return (ptype, host, int(port))


async def connect_with_retry(client: TelegramClient, max_retries: int = CONNECTION_RETRIES) -> bool:
    """Connect with retry logic and exponential backoff"""
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


async def get_or_create_client(account: dict, setup_handler=None, skip_avatar: bool = True, force_profile_sync: bool = False) -> Optional[TelegramClient]:
    """
    Get existing client or create new one with unique device fingerprint.
    Optimized for fast connection with retry logic and proxy support.
    """
    account_id = account["id"]
    
    # Return cached client if connected
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                if setup_handler and not getattr(client, "_handler_installed", False):
                    await setup_handler(client, account_id)
                    setattr(client, "_handler_installed", True)
                if force_profile_sync:
                    await _sync_profile(client, account_id, skip_avatar=False)
                return client
        except:
            # Client disconnected, remove from cache
            del active_clients[account_id]
    
    session_data = account.get("session_data")
    if not session_data:
        print(f"  [SKIP] No session: {account.get('phone_number', 'unknown')}")
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    # Get or generate device fingerprint
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
        print(f"  [FP] Generated: {device_model} ({system_version})")
        await report_result("fingerprint_generated", {
            "account_id": account_id,
            "device_model": device_model,
            "system_version": system_version,
            "app_version": app_version,
            "lang_code": lang_code,
            "system_lang_code": system_lang_code
        })
    
    # Get proxy settings
    proxy = get_proxy_settings(account)
    if proxy:
        print(f"  [PROXY] Using: {proxy[1]}:{proxy[2]}")
    
    try:
        # Get API credentials
        api_id = account.get("api_id") or TELEGRAM_API_ID
        api_hash = account.get("api_hash") or TELEGRAM_API_HASH
        
        # Create client with optimized settings
        client = TelegramClient(
            session_path, 
            int(api_id), 
            api_hash,
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
        
        # Connect with retry logic
        print(f"  [CONNECT] {account['phone_number']}...")
        if not await connect_with_retry(client):
            print(f"  [FAIL] Could not connect: {account['phone_number']}")
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Connection timeout"})
            return None
        
        if not await client.is_user_authorized():
            print(f"  [EXPIRED] Session expired: {account['phone_number']}")
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        # Set up message handler if provided
        if setup_handler:
            await setup_handler(client, account_id)
            setattr(client, "_handler_installed", True)
        
        active_clients[account_id] = client
        
        # Fast mode: skip profile fetch if already cached
        has_cached_profile = account.get("first_name") or account.get("username")
        if has_cached_profile and not force_profile_sync:
            await report_result("account_connected", {
                "account_id": account_id,
                "skip_profile_update": True
            })
        else:
            await _sync_profile(client, account_id, skip_avatar=skip_avatar)
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
    except Exception as e:
        print(f"  [FAIL] {account['phone_number']}: {e}")
        return None


async def _sync_profile(client: TelegramClient, account_id: str, skip_avatar: bool = True):
    """Fetch and report account profile data"""
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if me:
            avatar_base64 = None
            if not skip_avatar:
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


async def get_next_task(runner: str = None) -> dict:
    """Ask backend for next task"""
    try:
        body = {"runner": runner} if runner else {}
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body
            )
            return resp.json()
    except Exception as e:
        return {"task": "wait", "seconds": 1}


async def get_batch_tasks(runner: str = None, batch_size: int = 5) -> dict:
    """Ask backend for batch of tasks"""
    try:
        body = {"batch_size": batch_size}
        if runner:
            body["runner"] = runner
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-batch-tasks",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body
            )
            return resp.json()
    except Exception as e:
        return {"tasks": [], "delay_after": 5}


async def report_result(task_type: str, result: dict):
    """Report task result to backend (fire and forget)"""
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
    """Send a message to a recipient with timeout protection"""
    try:
        entity = None
        
        if recipient.startswith("@"):
            entity = await asyncio.wait_for(client.get_entity(recipient), timeout=15)
        else:
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            
            phone = recipient.strip()
            if not phone.startswith("+"):
                phone = "+" + phone
            
            # Try direct lookup first
            try:
                entity = await asyncio.wait_for(client.get_entity(phone), timeout=10)
            except:
                pass
            
            # Import as contact
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
                elif result.retry_contacts:
                    return False, "Privacy restricted"
        
        if not entity:
            return False, "User not found on Telegram"
        
        # Send message with timeout
        if media_url:
            try:
                async with httpx.AsyncClient(timeout=30) as http:
                    media_resp = await http.get(media_url)
                    if media_resp.status_code == 200:
                        await asyncio.wait_for(client.send_file(entity, media_resp.content, caption=content), timeout=30)
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
        error_str = str(e)
        if "No user has" in error_str:
            return False, "Username not found"
        if "private" in error_str.lower():
            return False, "Private profile"
        return False, error_str


async def validate_contact(client: TelegramClient, phone: str):
    """Check if phone number exists on Telegram with timeout"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        import random
        
        contact = InputPhoneContact(
            client_id=random.randint(0, 2**31 - 1),
            phone=phone,
            first_name="V",
            last_name=""
        )
        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
        
        if result.users:
            user = result.users[0]
            name = f"{user.first_name or ''} {user.last_name or ''}".strip()
            return True, name, user.id
        return False, None, None
    except asyncio.TimeoutError:
        raise Exception("Validation timeout")
    except Exception as e:
        raise e


async def shutdown_all():
    """Cleanup all clients on shutdown"""
    print("\n[SHUTDOWN] Disconnecting all clients...")
    for account_id, client in list(active_clients.items()):
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except:
            pass
    active_clients.clear()
    print("[OK] All clients disconnected.")
