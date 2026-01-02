"""
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
from fingerprint_generator import generate_fingerprint

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


async def get_or_create_client(account: dict, setup_handler=None, max_retries: int = 3) -> Optional[TelegramClient]:
    """Get existing client or create new one with unique device fingerprint and proxy support"""
    account_id = account["id"]
    
    if account_id in active_clients:
        client = active_clients[account_id]
        if client.is_connected():
            # Ensure incoming message handler is installed (important when a client was created by another runner)
            if setup_handler and not getattr(client, "_telegramcrm_handler_installed", False):
                try:
                    await setup_handler(client, account_id)
                    setattr(client, "_telegramcrm_handler_installed", True)
                except Exception as e:
                    print(f"  ⚠ Failed to set up handler for {account.get('phone_number', 'unknown')}: {e}")
            return client
    
    session_data = account.get("session_data")
    if not session_data:
        print(f"  ⚠ No session data for {account.get('phone_number', 'unknown')}")
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    # Get device fingerprint from account or generate new one
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version")
    lang_code = account.get("lang_code") or "en"
    system_lang_code = account.get("system_lang_code") or "en-US"
    
    # If no fingerprint stored, generate one and report it
    if not device_model or not system_version:
        fp = generate_fingerprint()
        device_model = fp["device_model"]
        system_version = fp["system_version"]
        app_version = fp["app_version"]
        lang_code = fp["lang_code"]
        system_lang_code = fp["system_lang_code"]
        print(f"  [FP] Generated: {device_model} ({system_version})")
        
        # Report fingerprint to be saved in database
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
    
    # Get API credentials from account (from backend) or use default
    api_id = account.get("api_id") or TELEGRAM_API_ID
    api_hash = account.get("api_hash") or TELEGRAM_API_HASH
    
    # Set up proxy if provided
    proxy_settings = None
    proxy_info = account.get("proxy")
    if proxy_info and proxy_info.get("host"):
        proxy_type = (proxy_info.get("proxy_type") or "socks5").lower()
        proxy_host = proxy_info.get("host")
        proxy_port = proxy_info.get("port")
        proxy_user = proxy_info.get("username")
        proxy_pass = proxy_info.get("password")
        
        # Telethon proxy format: (type, host, port, secret, username, password)
        if proxy_type in ("socks5", "socks4"):
            import socks
            sock_type = socks.SOCKS5 if proxy_type == "socks5" else socks.SOCKS4
            proxy_settings = (sock_type, proxy_host, int(proxy_port), True, proxy_user, proxy_pass)
            print(f"  [PROXY] Using {proxy_type.upper()} proxy: {proxy_host}:{proxy_port}")
        elif proxy_type in ("http", "https"):
            # For HTTP proxy, Telethon uses a different format
            proxy_settings = {
                'proxy_type': 'http',
                'addr': proxy_host,
                'port': int(proxy_port),
                'username': proxy_user,
                'password': proxy_pass,
            }
            print(f"  [PROXY] Using HTTP proxy: {proxy_host}:{proxy_port}")
    
    for attempt in range(1, max_retries + 1):
        try:
            # Create client with unique device fingerprint and optional proxy
            client = TelegramClient(
                session_path, 
                int(api_id), 
                api_hash,
                device_model=device_model,
                system_version=system_version,
                app_version=app_version,
                lang_code=lang_code,
                system_lang_code=system_lang_code,
                proxy=proxy_settings
            )
            await client.connect()
            
            if not await client.is_user_authorized():
                print(f"  ⚠ Session expired for {account['phone_number']}")
                await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
                return None
            
            # Set up message handler if provided
            if setup_handler:
                await setup_handler(client, account_id)
                setattr(client, "_telegramcrm_handler_installed", True)
            
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
            
            print(f"  [OK] Connected: {account['phone_number']}")
            return client
        except Exception as e:
            print(f"  Attempt {attempt} at connecting failed: {e}")
            if attempt < max_retries:
                await asyncio.sleep(2)
            else:
                print(f"  ⚠ Failed to connect {account['phone_number']} after {max_retries} attempts")
                return None
    
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
    print("\nShutting down...")
    for account_id, client in active_clients.items():
        try:
            await client.disconnect()
            print(f"  Disconnected {account_id[:8]}...")
        except:
            pass
    print("✓ All clients disconnected.")
