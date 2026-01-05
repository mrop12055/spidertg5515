"""
TelegramCRM - Client Manager (Ultra Fast)
Persistent connections, cached clients, minimal latency
"""

import os
import base64
import tempfile
import asyncio
import httpx
import socks
from typing import Dict, Optional, Tuple

from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")
active_clients: Dict[str, TelegramClient] = {}
client_metadata: Dict[str, dict] = {}  # Store proxy/fingerprint per account

# Speed settings - reduced for faster connections
CONNECTION_TIMEOUT = 15
CONNECTION_RETRIES = 2
RETRY_DELAY = 1

# Reusable HTTP client for faster API calls
_http_client: Optional[httpx.AsyncClient] = None


async def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(timeout=10)
    return _http_client


def decode_session_file(phone_number: str, base64_data: str) -> Optional[str]:
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    session_file = session_path + ".session"
    
    # Skip if session already exists and is recent
    if os.path.exists(session_file):
        return session_path
    
    try:
        session_bytes = base64.b64decode(base64_data)
        with open(session_file, "wb") as f:
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
            if attempt < max_retries:
                await asyncio.sleep(RETRY_DELAY)
        except Exception as e:
            if attempt < max_retries:
                await asyncio.sleep(RETRY_DELAY)
    return False


async def get_or_create_client(account: dict, setup_handler=None, fast_mode: bool = False) -> Optional[TelegramClient]:
    """
    Get or create a Telegram client for an account.
    fast_mode=True skips profile checks for faster sends.
    Always uses fingerprint and proxy from account data.
    """
    account_id = account["id"]
    
    # Check if we have a cached, connected client
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                if setup_handler and not getattr(client, "_handler", False):
                    await setup_handler(client, account_id)
                    setattr(client, "_handler", True)
                return client
        except:
            pass
        # Client disconnected, remove from cache
        try:
            await client.disconnect()
        except:
            pass
        del active_clients[account_id]
        if account_id in client_metadata:
            del client_metadata[account_id]
    
    session_data = account.get("session_data")
    if not session_data:
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    # Use fingerprint from account (database) - NEVER generate new for existing accounts
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version") or "10.14.2"
    lang_code = account.get("lang_code") or "en"
    system_lang_code = account.get("system_lang_code") or "en-US"
    
    # Only generate fingerprint if account has NONE stored
    if not device_model or not system_version:
        fp = generate_fingerprint()
        device_model = fp["device_model"]
        system_version = fp["system_version"]
        app_version = fp["app_version"]
        lang_code = fp["lang_code"]
        system_lang_code = fp["system_lang_code"]
        print(f"  [FP] Generated: {device_model} ({system_version})")
        # Report to save in DB for future consistency
        asyncio.create_task(report_result("fingerprint_generated", {
            "account_id": account_id,
            "device_model": device_model,
            "system_version": system_version,
            "app_version": app_version,
            "lang_code": lang_code,
            "system_lang_code": system_lang_code
        }))
    else:
        print(f"  [FP] Using stored: {device_model} ({system_version})")
    
    # Use proxy from account (database)
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
            request_retries=2
        )
        
        print(f"  [CONNECT] {account['phone_number']}...")
        if not await connect_with_retry(client):
            print(f"  [FAIL] Timeout: {account['phone_number']}")
            if not fast_mode:
                asyncio.create_task(report_result("account_disconnected", {"account_id": account_id, "reason": "Connection timeout"}))
            return None
        
        if not await client.is_user_authorized():
            if not fast_mode:
                asyncio.create_task(report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"}))
            return None
        
        # Fast mode: skip profile verification for speed
        if not fast_mode:
            try:
                me = await asyncio.wait_for(client.get_me(), timeout=10)
                if not me:
                    print(f"  [BANNED] Account deleted: {account['phone_number']}")
                    asyncio.create_task(report_result("account_banned", {"account_id": account_id, "reason": "Account deleted"}))
                    return None
            except Exception as me_err:
                err_str = str(me_err).lower()
                if any(x in err_str for x in ["deleted", "deactivated", "banned", "user_deactivated"]):
                    print(f"  [BANNED] {account['phone_number']}: {me_err}")
                    asyncio.create_task(report_result("account_banned", {"account_id": account_id, "reason": str(me_err)}))
                    return None
                elif any(x in err_str for x in ["session", "revoked", "auth"]):
                    print(f"  [EXPIRED] {account['phone_number']}: {me_err}")
                    asyncio.create_task(report_result("account_disconnected", {"account_id": account_id, "reason": str(me_err)}))
                    return None
        
        if setup_handler:
            await setup_handler(client, account_id)
            setattr(client, "_handler", True)
        
        # Cache client and metadata
        active_clients[account_id] = client
        client_metadata[account_id] = {
            "device_model": device_model,
            "system_version": system_version,
            "proxy": proxy
        }
        
        if not fast_mode:
            asyncio.create_task(report_result("account_connected", {"account_id": account_id, "skip_profile_update": True}))
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
    except Exception as e:
        err_str = str(e).lower()
        if any(x in err_str for x in ["deleted", "deactivated", "banned"]):
            print(f"  [BANNED] {account['phone_number']}: {e}")
            asyncio.create_task(report_result("account_banned", {"account_id": account_id, "reason": str(e)}))
        else:
            print(f"  [FAIL] {account['phone_number']}: {e}")
        return None


async def get_next_task(runner: str = None) -> dict:
    try:
        body = {"runner": runner} if runner else {}
        http = await get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/get-next-task",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json=body
        )
        return resp.json()
    except:
        return {"task": "wait", "seconds": 0}


async def report_result(task_type: str, result: dict):
    try:
        http = await get_http_client()
        await http.post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"task_type": task_type, "result": result}
        )
    except:
        pass


async def send_message(client: TelegramClient, recipient, content: str, media_url: str = None) -> Tuple[bool, Optional[str]]:
    """Send message - recipient can be telegram_id (int), username (@xxx), or phone number"""
    try:
        entity = None
        
        # Handle integer telegram IDs (fastest path)
        if isinstance(recipient, (int, float)):
            entity = await asyncio.wait_for(client.get_entity(int(recipient)), timeout=8)
        else:
            recipient_str = str(recipient or "").strip()
            
            # Numeric string = telegram ID
            if recipient_str.isdigit() or (recipient_str.startswith('-') and recipient_str[1:].isdigit()):
                entity = await asyncio.wait_for(client.get_entity(int(recipient_str)), timeout=8)
            elif recipient_str.startswith("@"):
                entity = await asyncio.wait_for(client.get_entity(recipient_str), timeout=10)
            else:
                from telethon.tl.functions.contacts import ImportContactsRequest
                from telethon.tl.types import InputPhoneContact
                import random
                
                phone = recipient_str if recipient_str.startswith("+") else "+" + recipient_str
                try:
                    entity = await asyncio.wait_for(client.get_entity(phone), timeout=8)
                except:
                    pass
                
                if not entity:
                    contact = InputPhoneContact(client_id=random.randint(0, 2**62), phone=phone, first_name="TG", last_name=str(random.randint(1000, 9999)))
                    result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
                    if result.users:
                        entity = result.users[0]
                    elif result.retry_contacts:
                        return False, "Privacy restricted"
        
        if not entity:
            return False, "User not found on Telegram"
        
        # Ensure URLs are clickable
        formatted_content = content
        parse_mode = None
        try:
            import re
            url_re = re.compile(r'(https?://[^\s<>"\']+)')
            if content and url_re.search(content):
                parse_mode = 'md'
                def _to_md_link(m):
                    url = m.group(1)
                    return f"[{url}]({url})"
                formatted_content = url_re.sub(_to_md_link, content)
        except:
            formatted_content = content
            parse_mode = None

        if media_url:
            try:
                import io
                http = await get_http_client()
                resp = await http.get(media_url, timeout=20)
                if resp.status_code == 200:
                    from urllib.parse import urlparse, unquote
                    url_path = urlparse(media_url).path
                    filename = unquote(url_path.split("/")[-1]) if url_path else "attachment"
                    content_type = resp.headers.get("content-type", "").lower()
                    ext = filename.split(".")[-1].lower() if "." in filename else ""
                    is_image = ext in ("jpg", "jpeg", "png", "gif", "webp") or content_type.startswith("image/")
                    file_bytes = io.BytesIO(resp.content)
                    file_bytes.name = filename if "." in filename else "photo.jpg"
                    await asyncio.wait_for(
                        client.send_file(entity, file_bytes, caption=formatted_content, force_document=not is_image, parse_mode=parse_mode),
                        timeout=20
                    )
                else:
                    await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=10)
            except Exception as media_err:
                print(f"  [MEDIA ERROR] {media_err}")
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=10)
        else:
            await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=10)
        
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
        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
        if result.users:
            user = result.users[0]
            return True, f"{user.first_name or ''} {user.last_name or ''}".strip(), user.id
        return False, None, None
    except:
        return False, None, None


async def shutdown_all():
    global _http_client
    print("\n[SHUTDOWN] Disconnecting...")
    for account_id, client in list(active_clients.items()):
        try:
            await asyncio.wait_for(client.disconnect(), timeout=3)
        except:
            pass
    active_clients.clear()
    client_metadata.clear()
    if _http_client:
        await _http_client.aclose()
        _http_client = None
    print("[OK] Done.")
