"""
TelegramCRM - Client Manager (Optimized)
Fast connections with retry logic, timeouts, proxy support, and HTTP connection pooling
"""

import os
import base64
import tempfile
import asyncio
import httpx
import socks
from typing import Dict, Optional

from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")
active_clients: Dict[str, TelegramClient] = {}

# Speed settings
CONNECTION_TIMEOUT = 30
CONNECTION_RETRIES = 3
RETRY_DELAY = 2

# ========== SHARED HTTP CLIENT POOL ==========
# Prevents socket exhaustion by reusing connections
_http_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    """Get shared HTTP client with connection pooling"""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=30,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20)
        )
    return _http_client


def decode_session_file(phone_number: str, base64_data: str) -> Optional[str]:
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    try:
        session_bytes = base64.b64decode(base64_data)
        with open(session_path + ".session", "wb") as f:
            f.write(session_bytes)
        return session_path
    except Exception as e:
        print(f"  [ERROR] Session decode: {e}")
        return None


def get_proxy_settings(account: dict, task_proxy: dict = None) -> Optional[tuple]:
    """Extract proxy settings.

    Priority: task_proxy (from get-next-task/get-batch-tasks) > account.proxy
    """
    proxy = task_proxy or account.get("proxy")
    if not proxy:
        return None
    
    proxy_type = (proxy.get("proxy_type") or proxy.get("type") or "socks5").lower()
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
        # http / https
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
            print(f"    [TIMEOUT] Attempt {attempt}/{max_retries}")
            if attempt < max_retries:
                await asyncio.sleep(RETRY_DELAY * attempt)
        except Exception as e:
            print(f"    [ERROR] Attempt {attempt}/{max_retries}: {e}")
            if attempt < max_retries:
                await asyncio.sleep(RETRY_DELAY * attempt)
    return False


async def get_or_create_client(account: dict, setup_handler=None, task_proxy: dict = None) -> Optional[TelegramClient]:
    account_id = account["id"]
    
    if account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                if setup_handler and not getattr(client, "_handler", False):
                    await setup_handler(client, account_id)
                    setattr(client, "_handler", True)
                return client
        except:
            del active_clients[account_id]
    
    session_data = account.get("session_data")
    if not session_data:
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
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
    
    proxy = get_proxy_settings(account, task_proxy=task_proxy)
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
            request_retries=3
        )
        
        print(f"  [CONNECT] {account['phone_number']}...")
        if not await connect_with_retry(client):
            print(f"  [FAIL] Timeout: {account['phone_number']}")
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Connection timeout"})
            return None
        
        if not await client.is_user_authorized():
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        # Check if account is deleted/banned
        try:
            me = await asyncio.wait_for(client.get_me(), timeout=15)
            if not me:
                print(f"  [BANNED] Account deleted: {account['phone_number']}")
                await report_result("account_banned", {"account_id": account_id, "reason": "Account deleted"})
                return None
        except Exception as me_err:
            err_str = str(me_err).lower()
            if any(x in err_str for x in ["deleted", "deactivated", "banned", "user_deactivated"]):
                print(f"  [BANNED] {account['phone_number']}: {me_err}")
                await report_result("account_banned", {"account_id": account_id, "reason": str(me_err)})
                return None
            elif any(x in err_str for x in ["session", "revoked", "auth"]):
                print(f"  [EXPIRED] {account['phone_number']}: {me_err}")
                await report_result("account_disconnected", {"account_id": account_id, "reason": str(me_err)})
                return None
        
        if setup_handler:
            await setup_handler(client, account_id)
            setattr(client, "_handler", True)
        
        active_clients[account_id] = client
        
        # Fast mode: skip profile if cached
        if account.get("first_name") or account.get("username"):
            await report_result("account_connected", {"account_id": account_id, "skip_profile_update": True})
        else:
            if me:
                await report_result("account_connected", {
                    "account_id": account_id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username,
                    "telegram_id": me.id,
                    "phone": me.phone
                })
        
        print(f"  [OK] Connected: {account['phone_number']}")
        return client
    except Exception as e:
        err_str = str(e).lower()
        if any(x in err_str for x in ["deleted", "deactivated", "banned"]):
            print(f"  [BANNED] {account['phone_number']}: {e}")
            await report_result("account_banned", {"account_id": account_id, "reason": str(e)})
        else:
            print(f"  [FAIL] {account['phone_number']}: {e}")
        return None


async def get_next_task(runner: str = None) -> dict:
    """Fetch single task using shared HTTP client"""
    try:
        body = {"runner": runner} if runner else {}
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/get-next-task",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json=body
        )
        return resp.json()
    except Exception as e:
        print(f"  [HTTP ERROR] get_next_task: {e}")
        return {"task": "wait", "seconds": 1}


async def get_batch_tasks(runner: str = None, batch_size: int = 50) -> dict:
    """Fetch batch of tasks using shared HTTP client"""
    try:
        body = {"runner": runner, "batch_size": batch_size}
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json=body
        )
        return resp.json()
    except Exception as e:
        print(f"  [HTTP ERROR] get_batch_tasks: {e}")
        return {"tasks": [], "delay_after": 1}


async def report_result(task_type: str, result: dict):
    """Report task result using shared HTTP client"""
    try:
        http = get_http_client()
        await http.post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"task_type": task_type, "result": result}
        )
    except:
        pass


async def report_batch_results(results: list) -> bool:
    """Report many send results in one request for speed."""
    try:
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/report-batch-results",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"results": results}
        )
        if 200 <= resp.status_code < 300:
            return True
        print(f"  [BATCH REPORT] {resp.status_code}: {resp.text[:200]}")
        return False
    except Exception as e:
        print(f"  [BATCH REPORT ERROR] {e}")
        return False

async def send_message(client: TelegramClient, recipient: str, content: str, media_url: str = None):
    try:
        entity = None
        if recipient.startswith("@"):
            entity = await asyncio.wait_for(client.get_entity(recipient), timeout=15)
        else:
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            
            phone = recipient if recipient.startswith("+") else "+" + recipient
            try:
                entity = await asyncio.wait_for(client.get_entity(phone), timeout=10)
            except:
                pass
            
            if not entity:
                contact = InputPhoneContact(client_id=random.randint(0, 2**62), phone=phone, first_name="TG", last_name=str(random.randint(1000, 9999)))
                result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
                if result.users:
                    entity = result.users[0]
                elif result.retry_contacts:
                    return False, "Privacy restricted"
        
        if not entity:
            return False, "User not found on Telegram"
        
        # Ensure URLs are clickable: format URLs as Telegram Markdown links when detected
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
                print(f"  [LINK] Formatted with Markdown: {formatted_content[:120]}...")
        except Exception as e:
            print(f"  [LINK ERROR] {e}")
            formatted_content = content
            parse_mode = None

        if media_url:
            try:
                import io
                http = get_http_client()
                resp = await http.get(media_url)
                if resp.status_code == 200:
                    # Determine filename from URL to help Telethon classify the file
                    from urllib.parse import urlparse, unquote
                    url_path = urlparse(media_url).path
                    filename = unquote(url_path.split("/")[-1]) if url_path else "attachment"
                    
                    # Check if it's an image based on extension or content-type
                    content_type = resp.headers.get("content-type", "").lower()
                    ext = filename.split(".")[-1].lower() if "." in filename else ""
                    is_image = ext in ("jpg", "jpeg", "png", "gif", "webp") or content_type.startswith("image/")
                    
                    # Wrap bytes in BytesIO with a name so Telethon knows the file type
                    file_bytes = io.BytesIO(resp.content)
                    file_bytes.name = filename if "." in filename else f"photo.jpg"
                    
                    print(f"  [MEDIA] filename={filename}, content_type={content_type}, is_image={is_image}")
                    
                    # For images, use force_document=False to send as photo preview
                    await asyncio.wait_for(
                        client.send_file(entity, file_bytes, caption=formatted_content, force_document=not is_image, parse_mode=parse_mode),
                        timeout=30
                    )
                else:
                    await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
            except Exception as media_err:
                print(f"  [MEDIA ERROR] {media_err}")
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
        else:
            await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=15)
        
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
        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
        if result.users:
            user = result.users[0]
            return True, f"{user.first_name or ''} {user.last_name or ''}".strip(), user.id
        return False, None, None
    except:
        return False, None, None


async def disconnect_batch(account_ids: list):
    """Disconnect multiple clients after batch completion to free memory."""
    disconnected = 0
    for acc_id in account_ids:
        if acc_id in active_clients:
            try:
                await asyncio.wait_for(active_clients[acc_id].disconnect(), timeout=5)
            except:
                pass
            del active_clients[acc_id]
            disconnected += 1
    if disconnected > 0:
        print(f"  [CLEANUP] Disconnected {disconnected} clients after batch")


async def cleanup_stale_clients():
    """Remove disconnected Telegram clients from active_clients - call periodically"""
    stale = []
    for acc_id, client in list(active_clients.items()):
        try:
            if not client.is_connected():
                stale.append(acc_id)
        except:
            stale.append(acc_id)
    
    for acc_id in stale:
        try:
            await asyncio.wait_for(active_clients[acc_id].disconnect(), timeout=5)
        except:
            pass
        del active_clients[acc_id]
    
    if stale:
        print(f"  [CLEANUP] Removed {len(stale)} stale Telegram clients")
    
    return len(stale)


async def shutdown_all():
    print("\n[SHUTDOWN] Disconnecting...")
    for account_id, client in list(active_clients.items()):
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except:
            pass
    active_clients.clear()
    
    # Close HTTP client
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None
    
    print("[OK] Done.")
