"""
TelegramCRM - Client Manager (Server-Controlled)
==================================================
Shared Telegram client logic for all runners.
All settings (batch sizes, delays, limits) controlled by server.
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

# Phone lookup cache: phone -> telegram_id (speeds up repeated lookups)
_phone_cache: Dict[str, int] = {}

# Connection settings - optimized for speed
CONNECTION_TIMEOUT = 30
CONNECTION_RETRIES = 1  # Single attempt, then try random proxy

# HTTP client refresh for long-running processes
HTTP_CLIENT_MAX_AGE = 3600  # Refresh HTTP clients every hour to prevent stale connections
_http_client_created_at = None

# Shared HTTP clients
# - Prevents socket exhaustion from creating a new client for every request
# - Also surfaces real connection/SSL errors instead of silently "waiting"
_BACKEND_HTTP: Optional[httpx.AsyncClient] = None
_BACKEND_HTTP_LOOP = None

_MEDIA_HTTP: Optional[httpx.AsyncClient] = None
_MEDIA_HTTP_LOOP = None


def _http_limits() -> httpx.Limits:
    """Ultra high-capacity HTTP limits for 5000+ batch processing"""
    return httpx.Limits(max_connections=1000, max_keepalive_connections=500, keepalive_expiry=60.0)


async def _get_backend_http() -> httpx.AsyncClient:
    global _BACKEND_HTTP, _BACKEND_HTTP_LOOP, _http_client_created_at
    import time
    loop = asyncio.get_running_loop()
    now = time.time()
    
    # Check if client needs refresh (stale after HTTP_CLIENT_MAX_AGE)
    needs_refresh = (
        _http_client_created_at is not None 
        and (now - _http_client_created_at) > HTTP_CLIENT_MAX_AGE
    )
    
    if (
        _BACKEND_HTTP is None
        or getattr(_BACKEND_HTTP, "is_closed", False)
        or _BACKEND_HTTP_LOOP is not loop
        or needs_refresh
    ):
        if _BACKEND_HTTP is not None and not getattr(_BACKEND_HTTP, "is_closed", False):
            try:
                await _BACKEND_HTTP.aclose()
            except Exception:
                pass
        _BACKEND_HTTP = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=60.0),  # High timeout for massive batches
            limits=_http_limits(),
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
        )
        _BACKEND_HTTP_LOOP = loop
        _http_client_created_at = now
        if needs_refresh:
            print("  🔄 HTTP client refreshed for long-running process")
    return _BACKEND_HTTP


async def _get_media_http() -> httpx.AsyncClient:
    global _MEDIA_HTTP, _MEDIA_HTTP_LOOP
    loop = asyncio.get_running_loop()
    if _MEDIA_HTTP is None or getattr(_MEDIA_HTTP, "is_closed", False) or _MEDIA_HTTP_LOOP is not loop:
        if _MEDIA_HTTP is not None and not getattr(_MEDIA_HTTP, "is_closed", False):
            try:
                await _MEDIA_HTTP.aclose()
            except Exception:
                pass
        _MEDIA_HTTP = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=30.0), limits=_http_limits())
        _MEDIA_HTTP_LOOP = loop
    return _MEDIA_HTTP


async def _close_http_clients():
    global _BACKEND_HTTP, _BACKEND_HTTP_LOOP, _MEDIA_HTTP, _MEDIA_HTTP_LOOP
    if _BACKEND_HTTP is not None and not getattr(_BACKEND_HTTP, "is_closed", False):
        try:
            await _BACKEND_HTTP.aclose()
        except Exception:
            pass
    if _MEDIA_HTTP is not None and not getattr(_MEDIA_HTTP, "is_closed", False):
        try:
            await _MEDIA_HTTP.aclose()
        except Exception:
            pass
    _BACKEND_HTTP = None
    _BACKEND_HTTP_LOOP = None
    _MEDIA_HTTP = None
    _MEDIA_HTTP_LOOP = None

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
    """Extract proxy settings from account data or task-level proxy."""
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
    else:
        return (ptype, host, int(port))


def proxy_dict_from_tuple(proxy_tuple: tuple) -> Optional[dict]:
    """Convert proxy tuple back to dict format."""
    if not proxy_tuple or len(proxy_tuple) < 3:
        return None
    
    ptype = proxy_tuple[0]
    if ptype == socks.SOCKS5:
        proxy_type = "socks5"
    elif ptype == socks.SOCKS4:
        proxy_type = "socks4"
    elif ptype == socks.HTTP:
        proxy_type = "http"
    else:
        proxy_type = "socks5"
    
    result = {
        "proxy_type": proxy_type,
        "host": proxy_tuple[1],
        "port": proxy_tuple[2]
    }
    
    if len(proxy_tuple) >= 6:
        result["username"] = proxy_tuple[4]
        result["password"] = proxy_tuple[5]
    
    return result


async def get_random_proxy(exclude_host: str = None) -> Optional[dict]:
    """Fetch a random active proxy from the database."""
    try:
        http = await _get_backend_http()
        body = {"exclude_host": exclude_host} if exclude_host else {}
        resp = await http.post(f"{BACKEND_URL}/get-random-proxy", json=body)
        if resp.status_code == 200:
            data = resp.json()
            return data.get("proxy")
        return None
    except Exception as e:
        print(f"  [WARN] Failed to get random proxy: {e}")
        return None


async def connect_with_retry(client: TelegramClient) -> tuple[bool, str]:
    """Connect with single attempt - no retries, no delays."""
    try:
        await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
        return (True, "")
    except asyncio.TimeoutError:
        return (False, "Connection timeout - proxy may be slow or unresponsive")
    except ConnectionRefusedError:
        return (False, "Proxy connection refused")
    except OSError as e:
        error_str = str(e).lower()
        if "proxy" in error_str or "socks" in error_str or "connect" in error_str:
            return (False, f"Proxy error: {e}")
        elif "network" in error_str or "unreachable" in error_str:
            return (False, f"Network unreachable - proxy may be down: {e}")
        else:
            return (False, f"Connection error: {e}")
    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["proxy", "socks", "connection refused", "connect error", "unreachable"]):
            return (False, f"Proxy error: {e}")
        else:
            return (False, f"Connection failed: {e}")


async def get_or_create_client(account: dict, setup_handler=None, skip_avatar: bool = True, force_profile_sync: bool = False, task_proxy: dict = None) -> Optional[TelegramClient]:
    """Get existing client or create new one with consistent device fingerprint."""
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
            del active_clients[account_id]
    
    session_data = account.get("session_data")
    if not session_data:
        print(f"  [SKIP] No session: {account.get('phone_number', 'unknown')}")
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    # Get fingerprint - ALWAYS use stored values if available (consistency)
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version")
    lang_code = account.get("lang_code")
    system_lang_code = account.get("system_lang_code")
    
    # Only generate new fingerprint if ALL fields are missing
    if device_model and system_version and app_version:
        # Use stored fingerprint - ensures same session = same device
        lang_code = lang_code or "en"
        system_lang_code = system_lang_code or "en-US"
        print(f"  [FP] Using stored: {device_model} ({system_version})")
    else:
        # Generate new fingerprint only once per account
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
    
    # Get initial proxy
    proxy = get_proxy_settings(account, task_proxy)
    original_proxy_host = proxy[1] if proxy else None
    
    if proxy:
        print(f"  [PROXY] Using: {proxy[1]}:{proxy[2]}")
    else:
        print(f"  [WARN] No proxy configured for {account.get('phone_number', 'unknown')}")
    
    # Get API credentials
    api_creds = account.get("telegram_api_credentials")
    if api_creds and api_creds.get("api_id") and api_creds.get("api_hash"):
        api_id = api_creds["api_id"]
        api_hash = api_creds["api_hash"]
        print(f"  [API] Using credential: {api_creds.get('client_type', 'unknown')} ({api_id})")
    else:
        api_id = account.get("api_id") or TELEGRAM_API_ID
        api_hash = account.get("api_hash") or TELEGRAM_API_HASH
        print(f"  [API] Using account/default API: {api_id}")
    
    # Try to connect - with random proxy fallback on failure
    for attempt in range(2):  # Max 2 attempts: original proxy + random proxy
        try:
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
                connection_retries=1,
                retry_delay=0,
                auto_reconnect=True,
                request_retries=3
            )
            
            print(f"  [CONNECT] {account['phone_number']} (attempt {attempt + 1})...")
            connected, connect_error = await connect_with_retry(client)
            
            if not connected:
                error_lower = connect_error.lower()
                is_proxy_error = any(x in error_lower for x in ["proxy", "socks", "refused", "unreachable", "timeout"])
                
                # If first attempt failed with proxy error, try random proxy
                if attempt == 0 and is_proxy_error:
                    print(f"  [RETRY] Proxy failed, fetching random proxy...")
                    
                    # Report original proxy error
                    await report_result("proxy_error", {
                        "account_id": account_id, 
                        "reason": connect_error,
                        "proxy_id": original_proxy_host
                    })
                    
                    # Get random proxy (excluding the failed one)
                    random_proxy_dict = await get_random_proxy(exclude_host=original_proxy_host)
                    if random_proxy_dict:
                        proxy = get_proxy_settings({"proxy": random_proxy_dict})
                        if proxy:
                            print(f"  [PROXY] Trying random: {proxy[1]}:{proxy[2]}")
                            continue  # Retry with new proxy
                    
                    print(f"  [FAIL] No random proxy available")
                
                # Final failure
                print(f"  [FAIL] Could not connect: {account['phone_number']} - {connect_error}")
                if is_proxy_error:
                    await report_result("proxy_error", {
                        "account_id": account_id, 
                        "reason": connect_error,
                        "proxy_id": proxy[1] + ":" + str(proxy[2]) if proxy else None
                    })
                else:
                    await report_result("account_disconnected", {"account_id": account_id, "reason": connect_error})
                return None
            
            # Connection successful
            if not await client.is_user_authorized():
                print(f"  [EXPIRED] Session expired: {account['phone_number']}")
                await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
                return None
            
            try:
                me = await asyncio.wait_for(client.get_me(), timeout=15)
                if not me:
                    print(f"  [DELETED] Account deleted: {account['phone_number']}")
                    await report_result("account_banned", {"account_id": account_id, "reason": "Account deleted or banned"})
                    return None
            except Exception as me_error:
                error_str = str(me_error).lower()
                if any(x in error_str for x in ["user_deactivated", "deactivated"]):
                    print(f"  [FROZEN] Account deleted by user: {account['phone_number']} - {me_error}")
                    await report_result("account_frozen", {"account_id": account_id, "reason": str(me_error)})
                    return None
                elif any(x in error_str for x in ["banned", "deleted"]):
                    print(f"  [BANNED] Account banned by Telegram: {account['phone_number']} - {me_error}")
                    await report_result("account_banned", {"account_id": account_id, "reason": str(me_error)})
                    return None
                elif any(x in error_str for x in ["session", "revoked", "auth", "auth_key"]):
                    print(f"  [EXPIRED] Session revoked: {account['phone_number']} - {me_error}")
                    await report_result("account_disconnected", {"account_id": account_id, "reason": str(me_error)})
                    return None
                else:
                    print(f"  [WARN] get_me error: {me_error}")
            
            if setup_handler:
                await setup_handler(client, account_id)
                setattr(client, "_handler_installed", True)
            
            active_clients[account_id] = client
            
            # Only sync profile once per client (skip if already synced)
            if not getattr(client, "_profile_synced", False):
                await _sync_profile(client, account_id, skip_avatar=skip_avatar)
                setattr(client, "_profile_synced", True)
            
            print(f"  [OK] Connected: {account['phone_number']}")
            return client
            
        except Exception as e:
            error_str = str(e).lower()
            if any(x in error_str for x in ["user_deactivated", "deactivated"]):
                print(f"  [FROZEN] {account['phone_number']}: {e}")
                await report_result("account_frozen", {"account_id": account_id, "reason": str(e)})
            elif any(x in error_str for x in ["deleted", "banned"]):
                print(f"  [BANNED] {account['phone_number']}: {e}")
                await report_result("account_banned", {"account_id": account_id, "reason": str(e)})
            else:
                print(f"  [FAIL] {account['phone_number']}: {e}")
            return None
    
    return None


async def _sync_profile(client: TelegramClient, account_id: str, skip_avatar: bool = True):
    """Fetch and report account profile data."""
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
            
            has_profile = bool(me.first_name or me.last_name or me.username)
            
            if not has_profile:
                print(f"  [FROZEN] Account has no profile info (possibly deleted by user)")
                await report_result("account_frozen", {
                    "account_id": account_id,
                    "reason": "No profile info - account may be deleted by user",
                    "telegram_id": me.id
                })
            else:
                await report_result("account_connected", {
                    "account_id": account_id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username,
                    "telegram_id": me.id,
                    "phone": me.phone,
                    "avatar_base64": avatar_base64
                })
        else:
            print(f"  [FROZEN] get_me() returned None - account may be deleted")
            await report_result("account_frozen", {
                "account_id": account_id,
                "reason": "get_me() returned None - account deleted by user"
            })
    except Exception as e:
        error_str = str(e).lower()
        if any(x in error_str for x in ["user_deactivated", "deactivated"]):
            print(f"  [FROZEN] Account deactivated by user: {e}")
            await report_result("account_frozen", {
                "account_id": account_id,
                "reason": f"User deactivated: {e}"
            })
        else:
            print(f"  [WARN] Profile sync error: {e}")


async def get_next_task(runner: str = None) -> dict:
    """Ask backend for next task."""
    try:
        body = {"runner": runner} if runner else {}
        http = await _get_backend_http()
        resp = await http.post(f"{BACKEND_URL}/get-next-task", json=body)
        return resp.json()
    except Exception as e:
        # IMPORTANT: Surface errors (SSL/time/firewall) instead of silently returning "wait"
        print(f"  [BACKEND ERROR] get-next-task: {type(e).__name__}: {e}")
        return {"task": "wait", "seconds": 3, "reason": f"backend_error:{type(e).__name__}"}


async def get_batch_tasks(runner: str = None) -> dict:
    """Ask backend for batch of tasks - server controls batch size."""
    try:
        body = {"runner": runner} if runner else {}
        http = await _get_backend_http()
        resp = await http.post(f"{BACKEND_URL}/get-batch-tasks", json=body)
        return resp.json()
    except Exception as e:
        print(f"  [BACKEND ERROR] get-batch-tasks: {type(e).__name__}: {e}")
        return {
            "tasks": [],
            "delay_after": 0.1,  # Minimal delay on error - retry immediately
            "reason": f"Backend unreachable ({type(e).__name__})",
        }


async def report_result(task_type: str, result: dict):
    """Report task result to backend."""
    try:
        http = await _get_backend_http()
        await http.post(
            f"{BACKEND_URL}/report-task-result",
            json={"task_type": task_type, "result": result},
        )
    except Exception as e:
        print(f"  [WARN] Failed to report result: {type(e).__name__}: {e}")


async def report_batch_results(results: list) -> bool:
    """Report multiple campaign results in a single request.
    
    Much faster than individual reports - reduces HTTP overhead significantly.
    Returns True if batch was accepted, False if should fall back to individual.
    """
    if not results:
        return True
    
    try:
        http = await _get_backend_http()
        resp = await http.post(
            f"{BACKEND_URL}/report-batch-results",
            json={"results": results},
            timeout=30.0  # Allow more time for batch processing
        )
        if resp.status_code == 200:
            return True
        elif resp.status_code == 404:
            # Endpoint doesn't exist yet, fall back to individual
            return False
        else:
            print(f"  [WARN] Batch report returned {resp.status_code}")
            return False
    except Exception as e:
        print(f"  [WARN] Batch report failed: {type(e).__name__}: {e}")
        return False


async def send_message(client: TelegramClient, recipient, content: str, media_url: str = None):
    """Send a message and return (success, error, meta). No delays."""
    global _phone_cache
    meta = None
    original_recipient = recipient
    try:
        entity = None

        # Fast path: telegram user id
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
                import random

                phone = recipient_str
                if not phone.startswith("+"):
                    phone = "+" + phone

                # Check phone cache first for faster lookup
                if phone in _phone_cache:
                    try:
                        entity = await asyncio.wait_for(client.get_entity(_phone_cache[phone]), timeout=10)
                        if entity:
                            print(f"  [CACHE] Using cached telegram_id for {phone}")
                    except Exception:
                        # Cache entry invalid, remove it
                        del _phone_cache[phone]
                        entity = None

                if not entity:
                    try:
                        entity = await asyncio.wait_for(client.get_entity(phone), timeout=10)
                    except Exception:
                        pass

                if not entity:
                    max_retries = 2
                    for attempt in range(max_retries + 1):
                        contact = InputPhoneContact(
                            client_id=random.randint(0, 2**62),
                            phone=phone,
                            first_name="TG",
                            last_name=str(random.randint(1000, 9999))
                        )
                        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)

                        if result.users:
                            entity = result.users[0]
                            # Cache the phone -> telegram_id mapping
                            if hasattr(entity, 'id'):
                                _phone_cache[phone] = entity.id
                                print(f"  [CACHE] Cached telegram_id {entity.id} for {phone}")
                            break
                        elif result.retry_contacts:
                            if attempt < max_retries:
                                print(f"  [RATE] Contact lookup rate limited, retrying immediately (attempt {attempt + 1}/{max_retries})")
                                # No delay - retry immediately
                            else:
                                try:
                                    from telethon.tl.functions.contacts import ResolvePhoneRequest
                                    resolve_result = await asyncio.wait_for(client(ResolvePhoneRequest(phone=phone)), timeout=10)
                                    if resolve_result.users:
                                        entity = resolve_result.users[0]
                                        if hasattr(entity, 'id'):
                                            _phone_cache[phone] = entity.id
                                        break
                                except Exception as resolve_err:
                                    print(f"  [WARN] ResolvePhoneRequest failed: {resolve_err}")
                                return False, "Contact lookup rate limited - try again later", None
                        else:
                            break

        if not entity:
            return False, "User not found on Telegram", None

        meta = {
            "recipient_telegram_id": getattr(entity, "id", None),
            "recipient_username": getattr(entity, "username", None),
        }

        # Format URLs as Markdown links
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

        # Send message
        if media_url:
            try:
                import io
                http = await _get_media_http()
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

                        print(f"  [MEDIA] filename={filename}, content_type={content_type}, is_image={is_image}")

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

        return True, None, meta
    except asyncio.TimeoutError:
        return False, "Request timeout", meta
    except UserPrivacyRestrictedError as e:
        return False, f"UserPrivacyRestrictedError: {e}", meta
    except FloodWaitError as e:
        return False, f"FloodWaitError: {e.seconds}s wait required (caused by {e.request.__class__.__name__ if e.request else 'unknown'})", meta
    except Exception as e:
        error_str = str(e)
        error_type = type(e).__name__
        if "No user has" in error_str:
            return False, f"{error_type}: Username not found - {error_str}", meta
        if "private" in error_str.lower():
            return False, f"{error_type}: Private profile - {error_str}", meta
        return False, f"{error_type}: {error_str}", meta


async def validate_contact(client: TelegramClient, phone: str):
    """Check if phone number exists on Telegram"""
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


async def disconnect_client(account_id: str):
    """Disconnect a single client after task completion."""
    if account_id in active_clients:
        try:
            await asyncio.wait_for(active_clients[account_id].disconnect(), timeout=5)
            print(f"  [DISCONNECT] {account_id[:8]}...")
        except:
            pass
        del active_clients[account_id]


async def disconnect_batch(account_ids: list):
    """Disconnect multiple clients after batch completion."""
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
