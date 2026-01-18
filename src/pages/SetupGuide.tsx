import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';

const SetupGuide: React.FC = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  // ========== 1. CONFIG.PY ==========
  const configPy = `"""
TelegramCRM - Configuration
"""

BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"
`;

  // ========== 2. CLIENT_MANAGER.PY (STRICT 1:1 PROXY - OFFICIAL TELEGRAM API) ==========
  const clientManagerPy = `"""
TelegramCRM - Client Manager (OFFICIAL TELEGRAM API - SAFE)

BUILD: 2026-01-16-sqlite-lock-fix

CRITICAL RULES:
- NO ACCOUNT RUNS WITHOUT PROXY AND FINGERPRINT!
- Proxy checked FIRST (before fingerprint generation)
- Fingerprint generated if missing, saved to DB SYNCHRONOUSLY
- Each account uses EXACTLY ONE proxy (assigned by admin)
- NO automatic proxy switching - ever
- If proxy fails, report error and STOP using account
- Admin must manually reassign proxy in dashboard

ORDER OF OPERATIONS:
1. PROXY FIRST - check assigned proxy is valid (MANDATORY)
2. FINGERPRINT - generate if missing, save to DB SYNCHRONOUSLY before connect
3. CONNECT - using both proxy and fingerprint
4. PERFORM ACTION - after successful connection

SAFETY FEATURES:
- get_input_entity() instead of get_entity() (reduces API calls)
- Proper Telethon exception handling
- Smaller client_id range for contact imports
- Comprehensive error detection patterns

SQLITE LOCK FIX (2026-01-16):
- Global per-account locks that persist across function calls
- Retry mechanism for "database is locked" errors
- Proper session file release with delay after disconnect
- Single connection per account enforced across all runners
"""

import os
import base64
import tempfile
import asyncio
import httpx
import socks
import threading
from typing import Dict, Optional

# ========== PER-ACCOUNT CONNECTION LOCKS (prevents SQLite "database is locked") ==========
# Uses threading.Lock wrapped in asyncio for cross-coroutine safety
_connection_locks: Dict[str, asyncio.Lock] = {}
_connection_locks_mutex = threading.Lock()  # Protects _connection_locks dict itself

def get_account_lock(account_id: str) -> asyncio.Lock:
    """Get or create a per-account lock in a thread-safe manner."""
    with _connection_locks_mutex:
        if account_id not in _connection_locks:
            _connection_locks[account_id] = asyncio.Lock()
        return _connection_locks[account_id]

from telethon import TelegramClient
from telethon.errors import (
    RPCError,
    FloodWaitError,
    UserPrivacyRestrictedError,
    UserBannedInChannelError,
    ChatWriteForbiddenError,
    SlowModeWaitError,
    PeerFloodError,
    UserDeactivatedBanError,
    AuthKeyUnregisteredError,
    SessionRevokedError,
    UserBlockedError,
    PhoneNumberBannedError,
    PhoneNumberInvalidError,
    InputUserDeactivatedError,
    UsernameNotOccupiedError,
    UsernameInvalidError,
    ChannelPrivateError,
    ChatAdminRequiredError,
    UserNotMutualContactError,
    MessageNotModifiedError,
    MediaEmptyError
)

from config import BACKEND_URL, SUPABASE_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
from fingerprint_generator import generate_fingerprint

SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")
active_clients: Dict[str, TelegramClient] = {}

# ========== PROXY ERROR RETRY SETTINGS ==========
PROXY_RETRY_DELAY = 30  # Retry proxy error accounts after 30 seconds
PROXY_MAX_RETRIES = 3   # Max retry attempts before giving up (per session)

# ========== SPLIT TIMEOUTS ==========
CONNECTION_TIMEOUT = 15      # Telegram connection timeout (was 10, increased for slow proxies)
CONNECTION_RETRIES = 1       # Fail fast - no proxy switching
RETRY_DELAY = 0              # No retry delay

# HTTP Timeouts - split by purpose (increased for high-load 300+ clients)
HTTP_TIMEOUT_DISPATCH = 60   # Task fetching (get-next-task, get-batch-tasks) - was 45
HTTP_TIMEOUT_REPORT = 45     # Reporting (report-task-result, report-batch-results) - was 30
HTTP_TIMEOUT_UPLOAD = 90     # Media uploads (photos, videos) - was 60
HTTP_TIMEOUT_DEFAULT = 30    # Other REST calls - was 20

# Telegram operation-specific timeouts
SEND_FILE_TIMEOUT = 45       # send_file operations (was 30)
SEND_MESSAGE_TIMEOUT = 20    # send_message operations (was 10)
DIALOG_FETCH_TIMEOUT = 45    # get_dialogs operations (was 30)
AUTH_CHECK_TIMEOUT = 15      # is_user_authorized check
GET_ME_TIMEOUT = 10          # client.get_me() timeout

# Backoff tracking for HTTP errors
_consecutive_http_errors = 0
MAX_HTTP_BACKOFF = 30

# Proxy error patterns - report these immediately
PROXY_ERROR_PATTERNS = [
    "semaphore timeout", "winerror 121", "connection refused", 
    "proxy", "socks", "timed out", "timeout", "cannot connect",
    "connection reset", "connection closed", "no route"
]

# Account error patterns for session check
ACCOUNT_ERROR_PATTERNS = {
    "frozen": "frozen",
    "deleted": "banned",
    "deactivated": "banned", 
    "banned": "banned",
    "auth_key_unregistered": "disconnected",
    "session_revoked": "disconnected",
    "user_deactivated": "banned",
    "access_token_expired": "disconnected",
    "restricted": "restricted",
    "phone_number_banned": "banned",
    "input_user_deactivated": "banned"
}

# ========== SHARED HTTP CLIENT POOL ==========
_http_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    """Get shared HTTP client with connection pooling - no default timeout (set per-request)"""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT_DEFAULT,
            limits=httpx.Limits(max_connections=500, max_keepalive_connections=100)
        )
    return _http_client


# ========== PROXY ERROR RETRY FUNCTIONS ==========
# Track retry counts per account (in-memory, resets on restart)
_proxy_retry_counts: Dict[str, int] = {}


def add_to_proxy_retry_queue(account_id: str, account_data: dict, proxy_data: dict = None):
    """Track proxy error for retry counting."""
    retry_count = _proxy_retry_counts.get(account_id, 0) + 1
    _proxy_retry_counts[account_id] = retry_count
    
    if retry_count > PROXY_MAX_RETRIES:
        print(f"  [PROXY RETRY] {account_id[:8]} - Max retries ({PROXY_MAX_RETRIES}) exceeded this session")
    else:
        print(f"  [PROXY RETRY] {account_id[:8]} - Error recorded (attempt {retry_count}/{PROXY_MAX_RETRIES})")


def remove_from_proxy_retry_queue(account_id: str):
    """Clear retry count on successful connection."""
    if account_id in _proxy_retry_counts:
        del _proxy_retry_counts[account_id]


async def retry_proxy_error_accounts():
    """
    Fetch accounts with proxy errors from DATABASE and retry them.
    Only retries accounts that:
    1. Have disabled_reason containing 'Proxy error'
    2. Have last_active older than PROXY_RETRY_DELAY seconds
    3. Haven't exceeded max retries this session
    """
    http = get_http_client()
    
    try:
        # Fetch accounts with proxy errors from Supabase
        resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/telegram_accounts",
            params={
                "select": "id,phone_number,session_data,device_model,system_version,app_version,lang_code,system_lang_code,proxy_id,api_id,api_hash,status,disabled_reason,last_active",
                "disabled_reason": "ilike.*Proxy error*",
                "status": "eq.active",
                "limit": "10"  # Process max 10 at a time
            },
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}"
            },
            timeout=10
        )
        
        if resp.status_code != 200:
            return 0
        
        accounts = resp.json()
        
        if not accounts:
            return 0
        
        # Filter accounts that are old enough for retry (>30s since last_active)
        import time
        from datetime import datetime
        
        ready_accounts = []
        for acc in accounts:
            account_id = acc.get("id")
            
            # Skip if max retries exceeded this session
            if _proxy_retry_counts.get(account_id, 0) >= PROXY_MAX_RETRIES:
                continue
            
            # Check if last_active is old enough
            last_active = acc.get("last_active")
            if last_active:
                try:
                    # Parse ISO timestamp
                    last_ts = datetime.fromisoformat(last_active.replace("Z", "+00:00"))
                    now = datetime.now(last_ts.tzinfo)
                    age_seconds = (now - last_ts).total_seconds()
                    
                    if age_seconds >= PROXY_RETRY_DELAY:
                        ready_accounts.append(acc)
                except Exception:
                    ready_accounts.append(acc)  # If can't parse, try anyway
            else:
                ready_accounts.append(acc)
        
        if not ready_accounts:
            return 0
        
        print(f"\\n  [PROXY RETRY] Found {len(ready_accounts)} accounts ready for retry...")
        
        # Fetch proxies for these accounts
        proxy_ids = [acc.get("proxy_id") for acc in ready_accounts if acc.get("proxy_id")]
        proxies_map = {}
        
        if proxy_ids:
            proxy_resp = await http.get(
                f"{SUPABASE_URL}/rest/v1/proxies",
                params={
                    "select": "*",
                    "id": f"in.({','.join(proxy_ids)})"
                },
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}"
                },
                timeout=10
            )
            if proxy_resp.status_code == 200:
                for p in proxy_resp.json():
                    proxies_map[p["id"]] = p
        
        # Try to reconnect each account
        reconnected = 0
        for acc in ready_accounts:
            account_id = acc["id"]
            phone = acc.get("phone_number", account_id[:8])[-4:]
            proxy = proxies_map.get(acc.get("proxy_id"))
            
            retry_count = _proxy_retry_counts.get(account_id, 0) + 1
            _proxy_retry_counts[account_id] = retry_count
            
            print(f"    [{phone}] Retry attempt {retry_count}/{PROXY_MAX_RETRIES}...")
            
            try:
                # Add proxy data to account for connection
                acc["proxy"] = proxy
                
                client = await get_or_create_client(
                    acc, 
                    task_proxy=proxy, 
                    skip_avatar=True,
                    no_cache=True
                )
                
                if client:
                    remove_from_proxy_retry_queue(account_id)
                    reconnected += 1
                    
                    # CRITICAL: Update database to clear disabled_reason so UI updates
                    try:
                        update_resp = await http.patch(
                            f"{SUPABASE_URL}/rest/v1/telegram_accounts?id=eq.{account_id}",
                            json={
                                "disabled_reason": None,
                                "auto_disabled": False,
                                "last_active": datetime.now().isoformat()
                            },
                            headers={
                                "apikey": SUPABASE_KEY,
                                "Authorization": f"Bearer {SUPABASE_KEY}",
                                "Content-Type": "application/json",
                                "Prefer": "return=minimal"
                            },
                            timeout=10
                        )
                        if update_resp.status_code in [200, 204]:
                            print(f"    [{phone}] ✓ Reconnected and updated in database!")
                        else:
                            print(f"    [{phone}] ✓ Reconnected (db update failed: {update_resp.status_code})")
                    except Exception as db_err:
                        print(f"    [{phone}] ✓ Reconnected (db update error: {db_err})")
                else:
                    print(f"    [{phone}] ✗ Still failing")
                    
            except Exception as e:
                print(f"    [{phone}] ✗ Error: {str(e)[:40]}")
        
        if reconnected > 0:
            print(f"  [PROXY RETRY] Reconnected {reconnected}/{len(ready_accounts)} accounts")
        
        return reconnected
        
    except Exception as e:
        print(f"  [PROXY RETRY] Error fetching accounts: {e}")
        return 0
    
    if reconnected > 0:
        print(f"  [PROXY RETRY] Reconnected {reconnected}/{len(ready)} accounts")
    
    return reconnected


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


def detect_account_status(error_str: str) -> str:
    """Detect account status from error message using official patterns"""
    error_lower = error_str.lower()
    for pattern, status in ACCOUNT_ERROR_PATTERNS.items():
        if pattern in error_lower:
            return status
    return "disconnected"


async def connect_with_retry(client: TelegramClient, max_retries: int = 3) -> bool:
    """
    Connect with automatic retry on proxy/network errors.
    Retries up to max_retries times before giving up.
    Returns True if connection succeeded (even after retries).
    """
    last_error = None
    for attempt in range(max_retries):
        try:
            await asyncio.wait_for(client.connect(), timeout=CONNECTION_TIMEOUT)
            if attempt > 0:
                print(f"    [RETRY SUCCESS] Connected on attempt {attempt + 1}/{max_retries}")
            return True
        except asyncio.TimeoutError:
            last_error = "Connection timeout"
            print(f"    [TIMEOUT] Attempt {attempt + 1}/{max_retries}: Connection timeout")
        except Exception as e:
            last_error = str(e)
            err_str = str(e).lower()
            if any(p in err_str for p in PROXY_ERROR_PATTERNS):
                print(f"    [PROXY RETRY] Attempt {attempt + 1}/{max_retries}: {e}")
            else:
                print(f"    [ERROR] Attempt {attempt + 1}/{max_retries}: {e}")
        
        # Wait before retry (exponential backoff: 1s, 2s, 4s)
        if attempt < max_retries - 1:
            wait_time = min(2 ** attempt, 4)
            print(f"    [RETRY] Waiting {wait_time}s before retry...")
            await asyncio.sleep(wait_time)
    
    print(f"    [FAIL] All {max_retries} connection attempts failed: {last_error}")
    return False


async def get_or_create_client(account: dict, setup_handler=None, task_proxy: dict = None,
                                skip_avatar: bool = False, no_cache: bool = False, 
                                long_lived: bool = False) -> Optional[TelegramClient]:
    """
    Get or create a Telegram client for an account.
    
    ORDER OF OPERATIONS (CRITICAL):
    1. Check existing client cache
    2. Check session data exists
    3. PROXY FIRST - check assigned proxy is valid (MANDATORY - no accounts run without proxy)
    4. FINGERPRINT - generate if missing, save to DB SYNCHRONOUSLY
    5. CONNECT - using both proxy and fingerprint
    6. PERFORM ACTION - after successful connection
    
    STRICT 1:1 PROXY POLICY:
    - Each account uses its assigned proxy ONLY
    - NO automatic proxy switching
    - If proxy fails, report error and return None
    - Admin must fix proxy assignment in dashboard
    
    FINGERPRINT POLICY:
    - Fingerprint generated ONCE on first connection
    - Saved to database SYNCHRONOUSLY before any connection attempt
    - Never changed after initial generation
    
    SQLITE LOCK PREVENTION:
    - Per-account asyncio.Lock prevents concurrent connection attempts
    - Proper disconnect before reconnect releases SQLite file
    - Retry logic for "database is locked" errors
    
    Args:
        account: Account data with session, fingerprint, proxy info
        setup_handler: Optional handler to setup after connection
        task_proxy: Proxy from task (overrides account.proxy)
        skip_avatar: If True, skip profile sync
        no_cache: If True, skip client caching
        long_lived: If True, use settings optimized for long-lived connections
    """
    account_id = account["id"]
    phone = account.get("phone_number", account_id[:8])
    
    # ========== ACQUIRE PER-ACCOUNT LOCK (prevents SQLite "database is locked") ==========
    lock = get_account_lock(account_id)
    
    async with lock:
        return await _get_or_create_client_internal(
            account, setup_handler, task_proxy, skip_avatar, no_cache, long_lived
        )


async def _get_or_create_client_internal(account: dict, setup_handler=None, task_proxy: dict = None,
                                          skip_avatar: bool = False, no_cache: bool = False, 
                                          long_lived: bool = False) -> Optional[TelegramClient]:
    """Internal implementation of get_or_create_client (called within lock)."""
    account_id = account["id"]
    phone = account.get("phone_number", account_id[:8])
    
    # ========== STEP 1: CHECK / CLEAR EXISTING CLIENT ==========
    if no_cache and account_id in active_clients:
        try:
            old_client = active_clients.pop(account_id)
            try:
                if old_client.is_connected():
                    print(f"  [NO_CACHE] Disconnecting cached client for {phone}")
                    await asyncio.wait_for(old_client.disconnect(), timeout=5)
                # Small delay to ensure SQLite file is fully released
                await asyncio.sleep(0.2)
            except Exception:
                pass
        except Exception:
            active_clients.pop(account_id, None)

    # Normal behavior: reuse an already-connected client
    if (not no_cache) and account_id in active_clients:
        client = active_clients[account_id]
        try:
            if client.is_connected():
                print(f"  [CACHED] Reusing existing connection for {phone}")
                if setup_handler and not getattr(client, "_handler", False):
                    await setup_handler(client, account_id)
                    setattr(client, "_handler", True)
                return client
            else:
                # Client exists but disconnected - clean it up FULLY before reconnecting
                print(f"  [CLEANUP] Removing disconnected client for {phone}")
                old_client = active_clients.pop(account_id)
                try:
                    await asyncio.wait_for(old_client.disconnect(), timeout=3)
                except Exception:
                    pass
                # Delay to release SQLite file
                await asyncio.sleep(0.2)
        except Exception:
            del active_clients[account_id]

    # ========== STEP 2: CHECK SESSION DATA ==========
    session_data = account.get("session_data")
    if not session_data:
        print(f"  [SKIP] {phone} - No session data")
        return None
    
    # ========== STEP 3: CHECK PROXY FIRST (MANDATORY) ==========
    # CRITICAL: Check proxy BEFORE fingerprint generation to avoid wasting fingerprints
    proxy = get_proxy_settings(account, task_proxy=task_proxy)
    proxy_id = task_proxy.get("id") if task_proxy else account.get("proxy_id")
    
    if not proxy:
        print(f"  ⛔ [SKIP] {phone} - NO PROXY ASSIGNED (MANDATORY)")
        print(f"          → Assign a proxy in the Admin Dashboard before running")
        return None
    
    print(f"  ✓ [PROXY] Active: {proxy[1]}:{proxy[2]}")
    
    # ========== STEP 4: USE OR GENERATE FINGERPRINT (after proxy check) ==========
    # Fingerprint is generated/retrieved and saved to DB SYNCHRONOUSLY before connect
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    app_version = account.get("app_version") or "10.14.2"
    lang_code = account.get("lang_code") or "en"
    system_lang_code = account.get("system_lang_code") or "en-US"
    
    # If fingerprint is missing, generate ONCE and save to DB SYNCHRONOUSLY before proceeding
    if not device_model or not system_version:
        fp = generate_fingerprint()
        device_model = fp["device_model"]
        system_version = fp["system_version"]
        app_version = fp["app_version"]
        lang_code = fp["lang_code"]
        system_lang_code = fp["system_lang_code"]
        print(f"  [FP] Generated NEW fingerprint (saving to DB): {device_model} ({system_version})")
        # Save fingerprint to database SYNCHRONOUSLY - wait for confirmation before proceeding
        try:
            await report_result("fingerprint_generated", {
                "account_id": account_id,
                "device_model": device_model,
                "system_version": system_version,
                "app_version": app_version,
                "lang_code": lang_code,
                "system_lang_code": system_lang_code
            })
            print(f"  [FP] Fingerprint saved to database for {phone}")
        except Exception as fp_err:
            print(f"  [FP WARN] Could not save fingerprint to DB: {fp_err}")
    else:
        print(f"  [FP] Using existing: {device_model} ({system_version})")
    
    # ========== STEP 5: DECODE SESSION FILE ==========
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    try:
        api_id = account.get("api_id") or TELEGRAM_API_ID
        api_hash = account.get("api_hash") or TELEGRAM_API_HASH
        
        # ========== CREATE CLIENT WITH SQLITE LOCK RETRY ==========
        client = None
        max_db_retries = 3
        last_db_error = None
        
        for db_attempt in range(max_db_retries):
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
                    connection_retries=3 if long_lived else 0,
                    retry_delay=2 if long_lived else 0,
                    auto_reconnect=long_lived,
                    request_retries=3 if long_lived else 1
                )
                break  # Success - exit retry loop
            except Exception as db_err:
                last_db_error = db_err
                err_str = str(db_err).lower()
                if "database is locked" in err_str and db_attempt < max_db_retries - 1:
                    wait_time = 0.5 * (db_attempt + 1)  # 0.5s, 1s, 1.5s
                    print(f"  [DB LOCK] Session file locked for {phone}, retry {db_attempt + 1}/{max_db_retries} in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                else:
                    raise  # Re-raise non-lock errors or final attempt
        
        if client is None:
            print(f"  [DB ERROR] Could not create client for {phone}: {last_db_error}")
            return None
        
        print(f"  [CONNECT] {account['phone_number']} (with 3 retries)...")
        if not await connect_with_retry(client, max_retries=3):
            # PROXY FAILED after all retries - Report proxy error and add to retry queue
            # We can't know session status if we can't connect via proxy
            print(f"  [PROXY ERROR] Connection failed for {phone} after 3 attempts - will retry in {PROXY_RETRY_DELAY}s")
            asyncio.create_task(report_result("proxy_error", {
                "account_id": account_id,
                "proxy_id": proxy_id,
                "reason": "Connection failed after 3 retries - proxy may be dead or blocked"
            }))
            # Track retry count for this session
            add_to_proxy_retry_queue(account_id, None, None)
            return None
        
        # Connected via proxy - NOW we can check session status
        try:
            is_authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=10)
        except Exception as auth_err:
            # Authorization check failed - could be proxy or session issue
            err_str = str(auth_err).lower()
            if any(p in err_str for p in PROXY_ERROR_PATTERNS):
                print(f"  [PROXY ERROR] Auth check failed for {phone}: {auth_err}")
                asyncio.create_task(report_result("proxy_error", {
                    "account_id": account_id,
                    "proxy_id": proxy_id,
                    "reason": f"Auth check failed: {str(auth_err)[:100]}"
                }))
                # Track retry count
                add_to_proxy_retry_queue(account_id, None, None)
            else:
                print(f"  [SESSION ERROR] Auth check failed for {phone}: {auth_err}")
                asyncio.create_task(report_result("account_disconnected", {"account_id": account_id, "reason": str(auth_err)}))
            return None
        
        if not is_authorized:
            asyncio.create_task(report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"}))
            return None
        
        # ========== GET ME & REPORT STATUS ==========
        me = None
        if not skip_avatar:
            try:
                me = await asyncio.wait_for(client.get_me(), timeout=5)
                if not me:
                    print(f"  [BANNED] Account deleted: {account['phone_number']}")
                    asyncio.create_task(report_session_check(account_id, success=False, error="Account deleted - get_me returned None"))
                    return None
                
                # SUCCESS - Report active status with telegram data
                asyncio.create_task(report_session_check(account_id, success=True, telegram_data={
                    "id": me.id,
                    "first_name": me.first_name,
                    "last_name": me.last_name,
                    "username": me.username
                }))
                
            except AuthKeyUnregisteredError:
                print(f"  [EXPIRED] {account['phone_number']}: Auth key unregistered")
                asyncio.create_task(report_session_check(account_id, success=False, error="Auth key unregistered"))
                return None
            except SessionRevokedError:
                print(f"  [EXPIRED] {account['phone_number']}: Session revoked")
                asyncio.create_task(report_session_check(account_id, success=False, error="Session revoked"))
                return None
            except UserDeactivatedBanError:
                print(f"  [BANNED] {account['phone_number']}: User deactivated/banned")
                asyncio.create_task(report_session_check(account_id, success=False, error="User deactivated or banned"))
                return None
            except PhoneNumberBannedError:
                print(f"  [BANNED] {account['phone_number']}: Phone number banned")
                asyncio.create_task(report_session_check(account_id, success=False, error="Phone number banned"))
                return None
            except InputUserDeactivatedError:
                print(f"  [BANNED] {account['phone_number']}: Input user deactivated")
                asyncio.create_task(report_session_check(account_id, success=False, error="User deactivated"))
                return None
            except Exception as me_err:
                err_str = str(me_err).lower()
                status = detect_account_status(err_str)
                print(f"  [{status.upper()}] {account['phone_number']}: {me_err}")
                asyncio.create_task(report_session_check(account_id, success=False, error=str(me_err)))
                return None
        
        if setup_handler:
            await setup_handler(client, account_id)
            setattr(client, "_handler", True)
        
        # Only cache if caching is enabled
        if not no_cache:
            active_clients[account_id] = client
        
        # ========== REPORT PROXY SUCCESS ==========
        # Connection succeeded - mark proxy as active and remove from retry queue
        remove_from_proxy_retry_queue(account_id)
        
        if proxy_id:
            asyncio.create_task(report_result("proxy_success", {
                "account_id": account_id,
                "proxy_id": proxy_id
            }))
        
        print(f"  ✓ [OK] Connected: {account['phone_number']}")
        return client
    except AuthKeyUnregisteredError:
        print(f"  [EXPIRED] {account['phone_number']}: Auth key unregistered")
        asyncio.create_task(report_session_check(account_id, success=False, error="Auth key unregistered"))
        return None
    except SessionRevokedError:
        print(f"  [EXPIRED] {account['phone_number']}: Session revoked")
        asyncio.create_task(report_session_check(account_id, success=False, error="Session revoked"))
        return None
    except UserDeactivatedBanError:
        print(f"  [BANNED] {account['phone_number']}: User deactivated")
        asyncio.create_task(report_session_check(account_id, success=False, error="User deactivated"))
        return None
    except Exception as e:
        err_str = str(e).lower()
        status = detect_account_status(err_str)
        print(f"  [{status.upper()}] {account['phone_number']}: {e}")
        asyncio.create_task(report_session_check(account_id, success=False, error=str(e)))
        return None


async def get_next_task(runner: str = None) -> dict:
    """Fetch single task using shared HTTP client with proper timeout and error handling"""
    global _consecutive_http_errors
    try:
        body = {"runner": runner} if runner else {}
        http = get_http_client()
        resp = await asyncio.wait_for(
            http.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json=body,
                timeout=HTTP_TIMEOUT_DISPATCH
            ),
            timeout=HTTP_TIMEOUT_DISPATCH + 1
        )
        
        if resp.status_code != 200:
            print(f"  [HTTP ERROR] get_next_task: status={resp.status_code}, body={resp.text[:200]}")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
            return {"task": "wait", "seconds": backoff}
        
        try:
            data = resp.json()
            _consecutive_http_errors = 0  # Reset on success
            return data
        except Exception as json_err:
            print(f"  [HTTP ERROR] get_next_task: JSON decode failed: {json_err}, body={resp.text[:200]}")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
            return {"task": "wait", "seconds": backoff}
            
    except asyncio.TimeoutError:
        print(f"  [HTTP ERROR] get_next_task: Timeout after {HTTP_TIMEOUT_DISPATCH}s")
        _consecutive_http_errors += 1
        backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
        return {"task": "wait", "seconds": backoff}
    except Exception as e:
        print(f"  [HTTP ERROR] get_next_task: {type(e).__name__}: {repr(e)}")
        _consecutive_http_errors += 1
        backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
        return {"task": "wait", "seconds": backoff}


async def get_batch_tasks(runner: str = None, batch_size: int = 50, max_retries: int = 2) -> dict:
    """Fetch batch of tasks with automatic retry on timeout"""
    global _consecutive_http_errors
    
    for attempt in range(max_retries + 1):
        try:
            body = {"runner": runner, "batch_size": batch_size}
            http = get_http_client()
            resp = await asyncio.wait_for(
                http.post(
                    f"{BACKEND_URL}/get-batch-tasks",
                    headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                    json=body,
                    timeout=HTTP_TIMEOUT_DISPATCH
                ),
                timeout=HTTP_TIMEOUT_DISPATCH + 2
            )
            
            if resp.status_code != 200:
                print(f"  [HTTP ERROR] get_batch_tasks: status={resp.status_code}, body={resp.text[:200]}")
                _consecutive_http_errors += 1
                backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
                return {"tasks": [], "delay_after": backoff}
            
            try:
                data = resp.json()
                _consecutive_http_errors = 0  # Reset on success
                return data
            except Exception as json_err:
                print(f"  [HTTP ERROR] get_batch_tasks: JSON decode failed: {json_err}, body={resp.text[:200]}")
                _consecutive_http_errors += 1
                backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
                return {"tasks": [], "delay_after": backoff}
                
        except (asyncio.TimeoutError, httpx.ReadTimeout) as e:
            if attempt < max_retries:
                print(f"  [HTTP RETRY] get_batch_tasks: Timeout (attempt {attempt + 1}/{max_retries + 1}), retrying...")
                await asyncio.sleep(1)  # Brief pause before retry
                continue
            print(f"  [HTTP ERROR] get_batch_tasks: Timeout after {max_retries + 1} attempts")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 3 + _consecutive_http_errors * 2)
            return {"tasks": [], "delay_after": backoff}
        except Exception as e:
            print(f"  [HTTP ERROR] get_batch_tasks: {type(e).__name__}: {repr(e)}")
            _consecutive_http_errors += 1
            backoff = min(MAX_HTTP_BACKOFF, 1 + _consecutive_http_errors * 2)
            return {"tasks": [], "delay_after": backoff}
    
    return {"tasks": [], "delay_after": 5}


async def report_result(task_type: str, result: dict):
    """Report task result (never block the runner; log failures)."""
    try:
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"task_type": task_type, "result": result},
            timeout=HTTP_TIMEOUT_REPORT,
        )
        if resp.status_code >= 300:
            print(f"  [REPORT ERROR] {task_type}: status={resp.status_code}, body={resp.text[:200]}")
    except Exception as e:
        print(f"  [REPORT EXC] {task_type}: {type(e).__name__}: {repr(e)}")


async def report_session_check(account_id: str, success: bool, error: str = None, telegram_data: dict = None):
    """
    Report session connection result - handles FROZEN, BANNED, DISCONNECTED detection.
    
    Args:
        account_id: The account UUID
        success: True if get_me() succeeded
        error: Error message if failed (for auto-detection of frozen/banned/etc)
        telegram_data: Dict with id, first_name, last_name, username from get_me()
    """
    try:
        http = get_http_client()
        payload = {
            "account_id": account_id,
            "success": success,
        }
        if error:
            payload["error"] = error
        if telegram_data:
            payload["telegram_data"] = telegram_data
            
        resp = await http.post(
            f"{BACKEND_URL}/report-session-check",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json=payload,
            timeout=HTTP_TIMEOUT_REPORT,
        )
        if resp.status_code >= 300:
            print(f"  [SESSION CHECK ERROR] {account_id}: status={resp.status_code}, body={resp.text[:200]}")
        else:
            result = resp.json()
            print(f"  [SESSION CHECK] {account_id} -> {result.get('new_status', 'unknown')}")
    except Exception as e:
        print(f"  [SESSION CHECK EXC] {account_id}: {type(e).__name__}: {repr(e)}")


async def report_batch_results(results: list) -> bool:
    """Report many send results in one request for speed."""
    try:
        http = get_http_client()
        resp = await http.post(
            f"{BACKEND_URL}/report-batch-results",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"results": results},
            timeout=HTTP_TIMEOUT_REPORT,
        )
        if 200 <= resp.status_code < 300:
            return True
        print(f"  [BATCH REPORT] {resp.status_code}: {resp.text[:200]}")
        return False
    except Exception as e:
        print(f"  [BATCH REPORT ERROR] {type(e).__name__}: {repr(e)}")
        return False


async def send_message(client: TelegramClient, recipient, content: str, media_url: str = None):
    """
    Send message using official Telegram API best practices.
    Uses get_input_entity() for efficiency (avoids extra API calls).
    Follows Telegram's official rate limits and error handling.
    
    recipient can be: int (telegram_id), str ("@username"), str ("+phone"), str ("telegram_id as string")
    """
    try:
        entity = None
        
        # Normalize recipient to string for consistent handling
        recipient_str = str(recipient) if recipient is not None else ""
        
        # ========== RESOLVE RECIPIENT ==========
        # Priority 1: Numeric Telegram ID (fastest - direct lookup)
        # IMPORTANT: get_input_entity(int_id) may fail if the entity is not cached.
        # We therefore fall back to get_entity(int_id) which performs a server fetch.
        if recipient_str and recipient_str.lstrip('-').isdigit():
            try:
                entity = await asyncio.wait_for(client.get_input_entity(int(recipient_str)), timeout=10)
            except (ValueError, KeyError):
                try:
                    entity = await asyncio.wait_for(client.get_entity(int(recipient_str)), timeout=10)
                except Exception:
                    pass
            except Exception as e:
                print(f"    [WARN] Direct ID lookup failed for {recipient_str}: {e}")
        
        # Priority 2: Username starting with @
        if not entity and recipient_str and recipient_str.startswith("@"):
            try:
                entity = await asyncio.wait_for(client.get_input_entity(recipient_str), timeout=10)
            except UsernameNotOccupiedError:
                return False, "Username does not exist"
            except UsernameInvalidError:
                return False, "Invalid username format"
            except Exception as e:
                print(f"    [WARN] Username lookup failed for {recipient_str}: {e}")
        
        # Priority 3: Phone number (requires contact import)
        if not entity and recipient_str:
            from telethon.tl.functions.contacts import ImportContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            
            # Only treat as phone if it starts with + or looks like a phone number
            phone = recipient_str if recipient_str.startswith("+") else ("+" + recipient_str if len(recipient_str) > 6 else None)
            
            if phone:
                # Strategy 1: Try cached entity first (fastest - no API call)
                try:
                    entity = await asyncio.wait_for(client.get_input_entity(phone), timeout=5)
                except (ValueError, KeyError):
                    pass  # Not in cache, need to import
                except Exception:
                    pass
                
                # Strategy 2: Import contact if not cached
                if not entity:
                    # Use smaller client_id range (official Telegram recommendation: 32-bit signed int)
                    contact = InputPhoneContact(
                        client_id=random.randint(0, 2**31 - 1),
                        phone=phone, 
                        first_name="User",  # Neutral name
                        last_name=""
                    )
                    try:
                        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
                        if result.users:
                            entity = result.users[0]
                        elif result.retry_contacts:
                            return False, "Privacy restricted - cannot add contact"
                    except PhoneNumberInvalidError:
                        return False, "Invalid phone number format"
                    except PhoneNumberBannedError:
                        return False, "Phone number is banned"
        
        if not entity:
            return False, "User not found on Telegram"
        
        # ========== FORMAT CONTENT ==========
        formatted_content = content
        parse_mode = None
        
        # Auto-detect URLs and format as clickable links
        try:
            import re
            url_re = re.compile(r'(https?://[^\\s<>"\\']+)')
            if content and url_re.search(content):
                parse_mode = 'md'
                def _to_md_link(m):
                    url = m.group(1)
                    return f"[{url}]({url})"
                formatted_content = url_re.sub(_to_md_link, content)
        except Exception:
            formatted_content = content
            parse_mode = None

        # ========== SEND MESSAGE ==========
        if media_url:
            try:
                import io
                http = get_http_client()
                resp = await http.get(media_url, timeout=HTTP_TIMEOUT_UPLOAD)
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
                        timeout=SEND_FILE_TIMEOUT
                    )
                else:
                    await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=SEND_MESSAGE_TIMEOUT)
            except MediaEmptyError:
                # Media download failed, send text only
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=SEND_MESSAGE_TIMEOUT)
            except Exception as media_err:
                print(f"  [MEDIA ERROR] {media_err}")
                await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=SEND_MESSAGE_TIMEOUT)
        else:
            await asyncio.wait_for(client.send_message(entity, formatted_content, link_preview=True, parse_mode=parse_mode), timeout=SEND_MESSAGE_TIMEOUT)
        
        return True, None
        
    # ========== SPECIFIC ERROR HANDLING (Official Telethon exceptions) ==========
    except asyncio.TimeoutError:
        return False, "Request timeout"
    except FloodWaitError as e:
        # Official rate limit - must wait exactly this many seconds
        return False, f"FloodWait:{e.seconds}s"
    except UserPrivacyRestrictedError:
        return False, "Privacy restricted"
    except PeerFloodError:
        # Too many messages to new users - temporary restriction
        return False, "PeerFlood - too many messages to new users"
    except ChatWriteForbiddenError:
        return False, "Cannot write to this chat"
    except UserBlockedError:
        return False, "User blocked you"
    except UserBannedInChannelError:
        return False, "Banned in channel"
    except UserNotMutualContactError:
        return False, "Not mutual contact"
    except SlowModeWaitError as e:
        return False, f"SlowMode:{e.seconds}s"
    except AuthKeyUnregisteredError:
        return False, "Session expired"
    except SessionRevokedError:
        return False, "Session revoked"
    except UserDeactivatedBanError:
        return False, "User deactivated"
    except InputUserDeactivatedError:
        return False, "User deactivated"
    except ChannelPrivateError:
        return False, "Channel is private"
    except RPCError as e:
        return False, f"RPC:{e.message}"
    except Exception as e:
        return False, str(e)


async def validate_contact(client: TelegramClient, phone: str):
    """Validate contact using safer API calls"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        import random
        # Use smaller client_id range (official recommendation)
        contact = InputPhoneContact(
            client_id=random.randint(0, 2**31 - 1),
            phone=phone, 
            first_name="V", 
            last_name=""
        )
        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=15)
        if result.users:
            user = result.users[0]
            return True, f"{user.first_name or ''} {user.last_name or ''}".strip(), user.id
        return False, None, None
    except FloodWaitError as e:
        return False, None, None
    except PeerFloodError:
        return False, None, None
    except Exception:
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


async def save_session_to_db(account_id: str, phone_number: str):
    """
    Save updated session file back to database to preserve entity cache.
    
    CRITICAL: This must be called BEFORE disconnecting to ensure:
    1. Entity cache (access_hash values) is preserved across runs
    2. Reduced API calls on next connection (entities already cached)
    3. Consistent identity - Telegram sees same session history
    
    The session file contains SQLite database with:
    - Authentication state
    - Entity cache (access_hash for contacts/users)
    - Update state (pts, qts, date)
    """
    session_path = os.path.join(SESSION_FOLDER, phone_number.replace("+", ""))
    session_file = session_path + ".session"
    
    try:
        if not os.path.exists(session_file):
            print(f"  [SESSION] No session file to save for {phone_number[-4:]}")
            return False
        
        with open(session_file, "rb") as f:
            session_bytes = f.read()
        
        # Validate SQLite header (must be valid session)
        if len(session_bytes) < 16 or session_bytes[:16] != b'SQLite format 3\\x00':
            print(f"  [SESSION] Invalid session format for {phone_number[-4:]}")
            return False
        
        session_base64 = base64.b64encode(session_bytes).decode('utf-8')
        
        # Report updated session to backend
        await report_result("session_updated", {
            "account_id": account_id,
            "session_data": session_base64
        })
        
        print(f"  [SESSION] Saved session cache for {phone_number[-4:]} ({len(session_bytes)} bytes)")
        return True
        
    except Exception as e:
        print(f"  [SESSION WARN] Failed to save session for {phone_number[-4:]}: {e}")
        return False


async def disconnect_client(account_id: str, phone: str = None, save_session: bool = True):
    """
    Disconnect and remove client from cache.
    
    IMPORTANT: By default, saves session to DB before disconnecting to preserve entity cache.
    Set save_session=False for quick disconnects (e.g., error cases where session is invalid).
    """
    if account_id in active_clients:
        try:
            client = active_clients[account_id]
            
            # SAVE SESSION FIRST - preserve entity cache before disconnecting
            if save_session and phone:
                await save_session_to_db(account_id, phone)
            
            await client.disconnect()
            del active_clients[account_id]
            if phone:
                print(f"  [DISCONNECT] Released {phone}")
        except Exception as e:
            # Still remove from cache even if disconnect fails
            active_clients.pop(account_id, None)


def reset_http_client():
    """Reset HTTP client - call after event loop restart to avoid 'Event loop is closed' error"""
    global _http_client
    _http_client = None


async def shutdown_all(save_sessions: bool = True):
    """
    Graceful shutdown - saves session cache for ALL connected clients before disconnecting.
    
    CRITICAL: Always call this before exiting to preserve entity cache.
    Set save_sessions=False only for emergency shutdowns.
    """
    print("\\n[SHUTDOWN] Saving sessions and disconnecting...")
    
    # First, save all sessions (preserve entity cache)
    if save_sessions:
        for account_id, client in list(active_clients.items()):
            try:
                # Get phone number from client if possible
                phone = getattr(client.session, 'filename', account_id)
                if phone:
                    phone = os.path.basename(phone).replace('.session', '')
                    await save_session_to_db(account_id, phone)
            except Exception as e:
                print(f"  [WARN] Could not save session for {account_id[:8]}: {e}")
    
    # Then disconnect all clients
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
    
    print("[OK] Sessions saved and clients disconnected.")
`;

  // ========== 3. FINGERPRINT_GENERATOR.PY ==========
  const fingerprintGeneratorPy = `"""Device Fingerprint Generator"""
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
    device = random.choice(ANDROID_DEVICES if use_android else IOS_DEVICES)
    lang = random.choice(LANGUAGES)
    return {
        "device_model": device["model"],
        "system_version": random.choice(device["versions"]),
        "app_version": random.choice(VERSIONS),
        "lang_code": lang["code"],
        "system_lang_code": random.choice(lang["systems"])
    }
`;

  // ========== 4. CAMPAIGN_RUNNER.PY ==========
  const campaignRunnerPy = String.raw`#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Admin-Controlled Speed)
=======================================================
BUILD: 2026-01-16-sqlite-lock-fix

ORDER OF OPERATIONS (CRITICAL):
1. PROXY FIRST - check assigned proxy is valid and active (MANDATORY)
2. FINGERPRINT - generate if missing, save to DB SYNCHRONOUSLY
3. CONNECT - using both proxy and fingerprint
4. PERFORM ACTION - send campaign messages

NO ACCOUNT RUNS WITHOUT PROXY AND FINGERPRINT!

SQLITE LOCK FIX (2026-01-16):
- Retry logic for "database is locked" errors during connection
- Per-account locks with thread-safe mutex protection
- Increased delay (0.5s) after disconnect to fully release SQLite file
- Proper cleanup of cached clients across event loop restarts

SPEED CONTROL via Admin Dashboard:
- staggerMin/staggerMax: delay between messages (0 = instant ultra-fast)
- batchSize: messages per batch (0 = unlimited)
- pollingInterval: wait between batches

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

BUILD_VERSION = "2026-01-16-sqlite-lock-fix"

import asyncio
import signal
import time
import random
import traceback

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, disconnect_batch, report_batch_results,
    active_clients, reset_http_client, save_session_to_db
)

# ========== GLOBAL STATE ==========
RUNNING = True
DEFAULT_POLL_INTERVAL = 5  # Fallback if server doesn't specify
REPORT_CONCURRENCY = None  # Unlimited parallel reports

# ========== SENT CACHE (Prevents Double-Sends) ==========
# Tracks recipient_ids that were sent but not yet confirmed reported
# If runner crashes after send but before report, this prevents re-sending
import json
import os

SENT_CACHE_FILE = "sent_cache.json"

def load_sent_cache() -> set:
    """Load recipient IDs that were sent but not yet confirmed reported"""
    if os.path.exists(SENT_CACHE_FILE):
        try:
            with open(SENT_CACHE_FILE, 'r') as f:
                data = json.load(f)
                return set(data) if isinstance(data, list) else set()
        except Exception:
            pass
    return set()

def save_sent_cache(cache: set):
    """Save cache to disk atomically"""
    try:
        with open(SENT_CACHE_FILE, 'w') as f:
            json.dump(list(cache), f)
    except Exception as e:
        print(f"  ⚠ Failed to save sent cache: {e}")

def add_to_sent_cache(recipient_id: str, cache: set):
    """Add immediately after Telegram send succeeds"""
    cache.add(recipient_id)
    save_sent_cache(cache)

def remove_from_sent_cache(recipient_id: str, cache: set):
    """Remove after successful report"""
    cache.discard(recipient_id)
    # Don't save here - batch save after all reports



def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# NOTE: pre_connect_batch was REMOVED - it caused "asyncio event loop must not change" errors
# because Telethon clients bind to the event loop where they were connected.
# We now reuse per-account cached clients within the SAME loop to avoid SQLite locks,
# and the client_manager enforces a per-account connection lock for safety.


async def process_account_tasks(account_id: str, tasks: list, stagger_min: float, stagger_max: float) -> list:
    """Process ALL tasks for a single account using ONE connection.
    
    This prevents SQLite session locks when same account has multiple messages.
    Tasks for this account run sequentially (same connection).
    Different accounts run in parallel.
    
    SQLITE LOCK FIX (2026-01-16):
    - Retry logic for "database is locked" errors during connection
    - Increased delay after disconnect to ensure SQLite file is released
    - All operations for same account are strictly sequential
    
    stagger_min/stagger_max = 0: Ultra-fast mode (no delay between messages)
    stagger_min/stagger_max > 0: Controlled speed from admin dashboard
    """
    results = []
    if not tasks:
        return results
    
    # Use first task's account/proxy info (all tasks for same account)
    account = tasks[0].get("account", {})
    proxy = tasks[0].get("proxy")
    account_phone = account.get("phone_number", "????")[-4:]
    
    client = None
    max_connection_retries = 3
    last_connection_error = None
    
    # ========== RETRY LOOP FOR SQLITE LOCK ERRORS ==========
    for attempt in range(max_connection_retries):
        try:
            # Open session ONCE for all tasks for this account
            # IMPORTANT: Use no_cache=True because this runner restarts via asyncio.run(...)
            # and cached Telethon clients cannot be reused across event loops.
            client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True, no_cache=True)
            
            if client:
                break  # Success - exit retry loop
            else:
                last_connection_error = "Could not connect client"
                
        except Exception as conn_err:
            last_connection_error = str(conn_err)
            err_lower = last_connection_error.lower()
            
            # Check for SQLite lock errors - retry with delay
            if "database is locked" in err_lower and attempt < max_connection_retries - 1:
                wait_time = 1.0 * (attempt + 1)  # 1s, 2s, 3s
                print(f"    ⚠ [{account_phone}] SQLite lock, retry {attempt + 1}/{max_connection_retries} in {wait_time}s...")
                await asyncio.sleep(wait_time)
                continue
            
            # Non-lock error or final attempt - don't retry
            print(f"    ✗ [{account_phone}] Connection error: {last_connection_error[:60]}")
            break
    
    # If no client after all retries, return errors for all tasks
    if not client:
        print(f"    ✗ [{account_phone}] No client (for {len(tasks)} tasks) - {last_connection_error}")
        for task in tasks:
            msg = task.get("message", {})
            results.append({
                "success": False,
                "error": last_connection_error or "Could not connect client",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account_id,
            })
        return results
    
    try:
        # Send ALL messages for this account using the same connection
        for idx, task in enumerate(tasks):
            msg = task.get("message", {})
            recipient = task.get("recipient")
            recipient_name = task.get("recipient_name")
            content = msg.get("content", "")
            
            # Get campaign metadata
            campaign_seat_id = task.get("campaign_seat_id")
            campaign_id = task.get("campaign_id")
            campaign_name = task.get("campaign_name")
            
            # ADMIN-CONTROLLED STAGGER: if stagger_max > 0, add delay (skip for first message)
            if stagger_max > 0 and idx > 0:
                stagger_delay = random.uniform(stagger_min, stagger_max)
                if stagger_delay > 0:
                    await asyncio.sleep(stagger_delay)
            
            try:
                send_res = await send_message(client, recipient, content, msg.get("media_url"))
                
                # Parse result
                if isinstance(send_res, tuple) and len(send_res) == 3:
                    success, error, meta = send_res
                elif isinstance(send_res, tuple) and len(send_res) == 2:
                    success, error = send_res
                    meta = None
                else:
                    success, error, meta = False, f"Unexpected return: {type(send_res)}", None
                
                # Check if this is a sender-side issue (should retry with different account)
                # PeerFlood = too many messages to new users, sender needs 12h cooldown but can chat with existing contacts
                is_sender_error = error and any(x in error.lower() for x in [
                    "privacyrestricted", "privacy restricted", "userprivacyrestricted",
                    "too many requests", "sendmessagerequest", "peerflood"
                ])
                
                # Get API credential ID
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
                    "campaign_seat_id": campaign_seat_id,
                    "campaign_id": campaign_id,
                    "campaign_name": campaign_name,
                }
                
                if is_sender_error:
                    result["skip_account"] = True
                    result["retry_with_different_account"] = True
                    print(f"    ⚠ [{account_phone}] → {recipient}: {error} (will retry with diff account)")
                elif success:
                    print(f"    ✓ [{account_phone}] → {recipient}")
                else:
                    print(f"    ✗ [{account_phone}] → {recipient}: {error}")
                
                if meta:
                    result.update(meta)
                
                results.append(result)
                
            except Exception as e:
                error_str = str(e)
                print(f"    ✗ [{account_phone}] → {recipient}: {error_str[:60]}")
                results.append({
                    "success": False,
                    "error": error_str,
                    "campaign_recipient_id": msg.get("campaign_recipient_id"),
                    "message_id": msg.get("id"),
                    "account_id": account_id,
                })
        
        return results
        
    except Exception as e:
        # Connection failed during send - return error for remaining tasks
        error_str = str(e)
        print(f"    ✗ [{account_phone}] Send error: {error_str[:60]}")
        # Return results already collected plus error for remaining
        return results
        
    finally:
        # CRITICAL: Save session and disconnect after ALL messages for this account are done
        # This preserves entity cache (access_hash values) for faster future sends
        if client:
            try:
                if client.is_connected():
                    # SAVE SESSION FIRST - preserve entity cache before disconnecting
                    account_phone_full = account.get("phone_number", account_id)
                    await save_session_to_db(account_id, account_phone_full)
                    await asyncio.wait_for(client.disconnect(), timeout=10)
                # CRITICAL: Give SQLite more time to release the session file
                # This prevents "database is locked" for subsequent connection attempts
                await asyncio.sleep(0.5)
            except Exception:
                pass  # Ignore disconnect errors


async def report_results_parallel(results: list, sent_cache: set = None) -> tuple:
    """Report all results - bounded concurrency, 5s timeout.
    
    IMPROVED:
    - 5 second timeout (up from 1s) for reliable reporting
    - Bounded concurrency (max 15) to avoid overwhelming backend
    - Removes from sent_cache on successful report
    """
    start_time = time.time()
    valid_results = [r for r in results if not isinstance(r, Exception)]

    if not valid_results:
        return 0, 0, 0

    # Try batch reporting first (5s timeout - up from 1s)
    REPORT_TIMEOUT = 5.0
    try:
        batch_success = await asyncio.wait_for(report_batch_results(valid_results), timeout=REPORT_TIMEOUT)
        if batch_success:
            elapsed = time.time() - start_time
            success_count = sum(1 for r in valid_results if r.get("success"))
            # Clear sent cache on successful batch report
            if sent_cache is not None:
                for r in valid_results:
                    rid = r.get("campaign_recipient_id")
                    if rid:
                        sent_cache.discard(rid)
                save_sent_cache(sent_cache)
            return success_count, len(valid_results) - success_count, elapsed
    except asyncio.TimeoutError:
        print(f"  ⚠ Batch report timeout ({REPORT_TIMEOUT}s)")
    except Exception as e:
        print(f"  ⚠ Batch report failed: {e}")

    # Fallback: BOUNDED parallel reports with 5s timeout each
    sem = asyncio.Semaphore(15)  # Max 15 concurrent reports
    
    async def report_one(result: dict) -> bool:
        async with sem:
            try:
                await asyncio.wait_for(report_result("send", result), timeout=REPORT_TIMEOUT)
                # Remove from sent cache on success
                if sent_cache is not None:
                    rid = result.get("campaign_recipient_id")
                    if rid:
                        sent_cache.discard(rid)
                return result.get("success", False)
            except asyncio.TimeoutError:
                return False
            except:
                return False

    report_results = await asyncio.gather(
        *[report_one(r) for r in valid_results],
        return_exceptions=True
    )
    
    # Save sent cache after all reports
    if sent_cache is not None:
        save_sent_cache(sent_cache)

    elapsed = time.time() - start_time
    success_count = sum(1 for r in report_results if r is True)
    return success_count, len(valid_results) - success_count, elapsed


async def disconnect_batch_clients():
    """Disconnect ALL active clients after batch - CRITICAL for livechat isolation."""
    global active_clients
    if not active_clients:
        return 0
    
    count = len(active_clients)
    print(f"  🔌 Disconnecting {count} clients after batch...")
    
    async def disconnect_one(account_id: str, client) -> bool:
        try:
            # SAVE SESSION BEFORE DISCONNECT - preserves entity cache
            if client.is_connected():
                try:
                    phone = getattr(client, '_phone', account_id[:8])
                    await save_session_to_db(account_id, phone)
                except Exception:
                    pass  # Non-critical
                await asyncio.wait_for(client.disconnect(), timeout=5)
            return True
        except Exception as e:
            print(f"    ⚠ Disconnect error [{account_id[:8]}]: {e}")
            return False
    
    # Disconnect all in parallel with timeout
    disconnect_tasks = [disconnect_one(acc_id, client) for acc_id, client in active_clients.items()]
    await asyncio.gather(*disconnect_tasks, return_exceptions=True)
    
    # Clear the cache completely
    active_clients.clear()
    print(f"  ✓ Disconnected {count} clients")
    return count


async def main_loop():
    """Main campaign loop - Admin-controlled speed via dashboard settings
    
    CRITICAL: Disconnects ALL clients after EACH batch to avoid conflicts with livechat.
    Server sends disconnect_after_batch=true to signal batch isolation.
    """
    global RUNNING

    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Admin-Controlled Speed)")
    print(f"  BUILD: {BUILD_VERSION}")
    print("=" * 60)
    print("  📊 Speed controlled via Admin Dashboard:")
    print("     - staggerMin/staggerMax = 0 → Ultra-fast (instant)")
    print("     - staggerMin/staggerMax > 0 → Controlled delay")
    print("     - batchSize = 0 → Unlimited batch size")
    print("  🔄 Proxy auto-switch on timeout")
    print("  🔌 BATCH ISOLATION: Disconnects after each batch")
    print("  🛡️  DOUBLE-SEND PREVENTION: Local sent cache")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("=" * 60)
    print("\n✓ Starting campaign runner...\n")

    consecutive_empty = 0
    
    # Load sent cache on startup (prevents double-sends after crash)
    sent_cache = load_sent_cache()
    if sent_cache:
        print(f"  📋 Loaded {len(sent_cache)} pending reports from cache")
    while RUNNING:
        try:
            batch_start = time.time()
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            fetch_time = time.time() - batch_start

            # Get speed settings from server (admin dashboard controls these)
            delay_after = batch_result.get("delay_after", DEFAULT_POLL_INTERVAL)
            stagger_min = batch_result.get("stagger_min", 0)
            stagger_max = batch_result.get("stagger_max", 0)
            more_pending = batch_result.get("more_pending", False)
            
            # Server tells us to disconnect after batch (default: true for campaigns)
            disconnect_after_batch = batch_result.get("disconnect_after_batch", True)
            batch_id = batch_result.get("batch_id", "unknown")

            if batch_result.get("stop_signal"):
                reason = batch_result.get("reason", "Campaign paused")
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print(f"  ⏸️  {reason} — waiting...")
                elif consecutive_empty % 20 == 0:
                    print("  ⏸️  Still waiting...")
                # Disconnect any lingering clients when stopped
                if disconnect_after_batch:
                    await disconnect_batch_clients()
                await asyncio.sleep(delay_after if delay_after > 0 else DEFAULT_POLL_INTERVAL)
                continue

            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print(f"  ⏳ {batch_result.get('reason', 'No tasks')}")
                elif consecutive_empty % 10 == 0:
                    print("  ⏳ Still waiting...")
                await asyncio.sleep(delay_after if delay_after > 0 else DEFAULT_POLL_INTERVAL)
                continue

            consecutive_empty = 0
            
            # Show current speed mode
            if stagger_max == 0:
                speed_mode = "ULTRA-FAST (zero stagger)"
            else:
                speed_mode = f"stagger {stagger_min:.1f}-{stagger_max:.1f}s"
            
            print(f"\n  📦 Batch {batch_id[:8]} - Processing {len(tasks)} messages [{speed_mode}]...")
            print(f"     [fetch: {fetch_time:.2f}s]")

            try:
                # GROUP tasks by account_id to prevent SQLite session locks
                # Each account opens ONE connection and sends ALL its messages
                from collections import defaultdict
                account_groups = defaultdict(list)
                for task in tasks:
                    acc_id = task.get("account", {}).get("id")
                    if acc_id:
                        account_groups[acc_id].append(task)
                
                print(f"     [{len(tasks)} tasks across {len(account_groups)} accounts]")
                
                # Process each account group in parallel (sequential within each account)
                send_start = time.time()
                group_results = await asyncio.gather(
                    *[process_account_tasks(acc_id, acc_tasks, stagger_min, stagger_max) 
                      for acc_id, acc_tasks in account_groups.items()],
                    return_exceptions=True
                )
                
                # Flatten results from all groups
                results = []
                for group_result in group_results:
                    if isinstance(group_result, list):
                        results.extend(group_result)
                    elif isinstance(group_result, Exception):
                        print(f"  ⚠ Group error: {group_result}")
                
                send_time = time.time() - send_start
                print(f"     [send: {send_time:.2f}s]")

                # Report ALL results in parallel (bounded concurrency, 5s timeout)
                # Pass sent_cache to remove reported items
                success_count, fail_count, report_time = await report_results_parallel(results, sent_cache)

                total_time = time.time() - batch_start
                msgs_per_min = (len(tasks) / total_time * 60) if total_time > 0 else 0

                print(f"  📊 Batch: {success_count}✓ {fail_count}✗ | {total_time:.1f}s total ({msgs_per_min:.0f}/min)")
                print(f"     [report: {report_time:.2f}s]")

            finally:
                # === BATCH END: ALWAYS disconnect all clients after batch ===
                if disconnect_after_batch:
                    await disconnect_batch_clients()

            # Use server-controlled delay (can be 0 for immediate repoll if more pending)
            if RUNNING and delay_after > 0:
                print(f"  ⏳ Next batch in {delay_after}s...")
                await asyncio.sleep(delay_after)
            elif RUNNING and more_pending:
                print("  🚀 More pending, immediate repoll...")

        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            # Disconnect on error too to clean up
            await disconnect_batch_clients()
            await asyncio.sleep(DEFAULT_POLL_INTERVAL)

    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Campaign Runner - Admin-Controlled Speed")
    print("  Speed & batch settings from admin dashboard")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print("Required: pip install telethon httpx pysocks")

    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\n⏹ Keyboard interrupt - stopping...")
            break
        except Exception as e:
            print(f"\n⚠ Runner crashed: {e}")
            print("  Restarting in 5 seconds...")
            
            # CRITICAL: Clear cached clients before a new asyncio event loop starts.
            # Otherwise Telethon throws: "The asyncio event loop must not change after connection".
            try:
                active_clients.clear()
            except Exception:
                pass
            
            # Reset HTTP client to avoid "Event loop is closed" error on restart
            reset_http_client()
            import time
            time.sleep(5)

    print("Goodbye!")
`;

  // ========== 5. LIVECHAT_RUNNER.PY ==========
  const livechatRunnerPy = `#!/usr/bin/env python3
"""
LiveChat Runner - Handles incoming messages and live chat replies
RUNS FOREVER with crash recovery, memory cleanup, and heartbeat logging

BUILD: 2026-01-16-sqlite-lock-fix

ORDER OF OPERATIONS (CRITICAL):
1. PROXY FIRST - check assigned proxy is valid and active (MANDATORY)
2. FINGERPRINT - generate if missing, save to DB SYNCHRONOUSLY
3. CONNECT - using both proxy and fingerprint
4. PERFORM ACTION - after successful connection

NO ACCOUNT RUNS WITHOUT PROXY AND FINGERPRINT!

SQLITE LOCK FIX (2026-01-16):
- Retry logic for "database is locked" errors during batch processing
- Increased delay after disconnect to ensure SQLite file is released
- Pauses keep_clients_alive during batch processing to prevent conflicts

STRICT 1:1 PROXY POLICY:
- Each account uses EXACTLY ONE proxy (assigned by admin)
- NO automatic proxy switching - ever
- If proxy fails, report error and SKIP account
- Admin must manually reassign proxy in dashboard

Features:
- MISSED MESSAGE RECOVERY: Syncs messages received while offline on startup
- EARLY FILTERING: Only processes messages from contacts
- Detects network/wifi disconnect and skips account updates
"""
import asyncio
import signal
import base64
import time
import gc

import httpx
from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client,
    retry_proxy_error_accounts,
    HTTP_TIMEOUT_UPLOAD
)
from fingerprint_generator import generate_fingerprint
from config import SUPABASE_URL, SUPABASE_KEY
from urllib.parse import urlparse

# Ensure we always get the *origin* (e.g. https://xxxx.supabase.co)
_u = urlparse(SUPABASE_URL)
SUPABASE_URL_BASE = f"{_u.scheme}://{_u.netloc}" if _u.scheme and _u.netloc else SUPABASE_URL.rstrip("/")

RUNNING = True
CLEANUP_INTERVAL = 180  # 3 minutes - faster cleanup
HEARTBEAT_INTERVAL = 30  # 30 seconds - more frequent status
CONNECT_TIMEOUT_SECONDS = 30  # Timeout for stable connections
RECIPIENT_REFRESH_INTERVAL = 60  # Refresh known recipients every 60 seconds

# HTTP Timeouts - used by fetch_active_accounts and other REST calls
HTTP_TIMEOUT_DEFAULT = 30    # Default for REST API calls
HTTP_TIMEOUT_DISPATCH = 60   # Task fetching
HTTP_TIMEOUT_REPORT = 45     # Reporting results

# ========== NETWORK ERROR HANDLING ==========
_network_error_count = 0
_last_network_error_time = 0
MAX_NETWORK_BACKOFF = 60

# Network error detection - these indicate LOCAL network issues
NETWORK_ERROR_PATTERNS = [
    "temporary failure in name resolution",
    "network is unreachable", 
    "no route to host",
    "connection refused",
    "connection reset by peer",
    "name or service not known",
    "could not connect",
    "timed out",
    "timeout",
    "cannot connect",
    "connection timed out",
    "connecterror",
    "network error",
    "socket error",
    "dns lookup failed",
    "errno 11001",
    "errno 110",
    "errno 111",
    "errno 113",
    "oserror",
    "gaierror",
    "winerror 64",
    "winerror 121",
    "network name",
    "server closed the connection",
    "connection closed",
]

# Telegram server error patterns
TELEGRAM_SERVER_ERROR_PATTERNS = [
    "internal issues",
    "rpccallfail",
    "rpc_call_fail",
    "flood wait",
    "server closed",
    "service unavailable",
]

# Sync retry settings
SYNC_RETRY_INTERVAL = 60


def is_network_error(error_str: str) -> bool:
    """Check if error is a LOCAL network/wifi issue"""
    if not error_str:
        return False
    error_lower = error_str.lower()
    return any(p in error_lower for p in NETWORK_ERROR_PATTERNS)


def is_telegram_server_error(error_str: str) -> bool:
    """Check if error is a Telegram server issue"""
    if not error_str:
        return False
    error_lower = error_str.lower()
    return any(p in error_lower for p in TELEGRAM_SERVER_ERROR_PATTERNS)


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def connect_account_with_fingerprint(account: dict, setup_handler=None, task_proxy: dict = None) -> tuple:
    """
    Connect account using CORRECT ORDER: Proxy FIRST → Fingerprint → Connect
    
    ORDER OF OPERATIONS (CRITICAL):
    1. PROXY FIRST - check assigned proxy is valid and active (MANDATORY)
    2. FINGERPRINT - generate if missing, save to DB SYNCHRONOUSLY
    3. CONNECT - using both proxy and fingerprint
    4. PERFORM ACTION - after successful connection
    
    NO ACCOUNT RUNS WITHOUT PROXY AND FINGERPRINT!
    
    RULES:
    - Proxy is checked FIRST - no connection attempt without valid proxy
    - Fingerprint is only generated AFTER proxy is validated
    - Fingerprint is saved to DB SYNCHRONOUSLY before any connection
    - Use assigned proxy ONLY - no switching
    - If proxy fails, report error and return None
    - Admin must fix proxy in dashboard
    
    Args:
        account: Account data with session, fingerprint, proxy info
        setup_handler: Optional handler to setup after connection
        task_proxy: Proxy from task (overrides account.proxy)
    
    Returns: (client, error_str or None)
    """
    account_id = account.get("id")
    phone_full = account.get("phone_number", "???")
    phone = phone_full[-4:]
    
    # ===== STEP 1: CHECK PROXY FIRST (MANDATORY) =====
    # Check proxy BEFORE fingerprint generation to avoid wasting fingerprints
    proxy = task_proxy or account.get("proxy")
    if not proxy:
        print(f"  ⛔ [{phone}] SKIP - No proxy assigned")
        return None, "No proxy assigned"
    
    # Validate proxy has required fields
    if not proxy.get("host") or not proxy.get("port"):
        print(f"  ⛔ [{phone}] SKIP - Invalid proxy (missing host/port)")
        return None, "Invalid proxy configuration"
    
    # Check proxy status if available
    proxy_status = proxy.get("status")
    if proxy_status and proxy_status != "active":
        print(f"  ⛔ [{phone}] SKIP - Proxy not active (status: {proxy_status})")
        return None, f"Proxy not active (status: {proxy_status})"
    
    # Store proxy in account for get_or_create_client
    account["proxy"] = proxy
    proxy_id = proxy.get("id")
    print(f"  ✓ [PROXY] Active: {proxy.get('host')}:{proxy.get('port')}")
    
    # ===== STEP 2: FINGERPRINT - Generate/retrieve and save to DB SYNCHRONOUSLY =====
    device_model = account.get("device_model")
    system_version = account.get("system_version")
    fingerprint_exists = bool(device_model and system_version)
    
    # If no fingerprint in DB, generate ONCE and save SYNCHRONOUSLY before proceeding
    if not fingerprint_exists:
        fp = generate_fingerprint()
        account["device_model"] = fp["device_model"]
        account["system_version"] = fp["system_version"]
        account["app_version"] = fp["app_version"]
        account["lang_code"] = fp["lang_code"]
        account["system_lang_code"] = fp["system_lang_code"]
        
        # Save fingerprint to database SYNCHRONOUSLY - wait for confirmation before proceeding
        try:
            await report_result("fingerprint_generated", {
                "account_id": account_id,
                "device_model": fp["device_model"],
                "system_version": fp["system_version"],
                "app_version": fp["app_version"],
                "lang_code": fp["lang_code"],
                "system_lang_code": fp["system_lang_code"]
            })
            print(f"  ✓ [FP] Generated: {fp['device_model']} ({fp['system_version']})")
        except Exception as fp_err:
            print(f"  ⚠ [FP] Save failed: {fp_err}")
    else:
        print(f"  ✓ [FP] Using: {device_model} ({system_version})")
    
    # ===== STEP 3: CONNECT - Using proxy + fingerprint =====
    print(f"  [CONNECT] {phone_full} (with 3 retries)...")
    try:
        client = await get_or_create_client(
            account, 
            setup_handler=setup_handler, 
            task_proxy=proxy,
            long_lived=True  # Stable settings for live chat
        )
        if client:
            return client, None
        else:
            # Connection failed - report proxy error
            print(f"  ⛔ [{phone}] PROXY FAILED")
            await report_result("proxy_error", {
                "account_id": account_id,
                "proxy_id": proxy_id,
                "reason": "Connection failed"
            })
            return None, "Proxy connection failed"
    except Exception as e:
        error_str = str(e).lower()
        
        # Check if this is a LOCAL network error
        if is_network_error(error_str) or "winerror 64" in error_str:
            print(f"  ⚠ [{phone}] NETWORK ERROR: {str(e)[:40]}")
            return None, f"NETWORK_ERROR:{e}"
        
        # Proxy failed - report to admin
        print(f"  ⛔ [{phone}] PROXY ERROR: {str(e)[:40]}")
        await report_result("proxy_error", {
            "account_id": account_id,
            "proxy_id": proxy_id,
            "reason": str(e)[:200]
        })
        return None, f"Proxy error: {e}"


async def sync_missed_messages(client, account_id: str, phone: str, last_synced_msg_ids: dict = None) -> tuple:
    """
    Sync missed messages after connection using TWO strategies:
    1. catch_up() - syncs updates since last connection (may fail if session is stale)
    2. fetch_dialogs() - explicitly fetches unread messages from all dialogs (always works)
    
    Uses last_synced_msg_ids to skip messages that were already processed in previous runs.
    
    Returns: (success: bool, needs_retry: bool)
    """
    if last_synced_msg_ids is None:
        last_synced_msg_ids = {}
    
    fetched_count = 0
    skipped_count = 0
    
    # Strategy 1: Try catch_up for recent updates (quick sync)
    try:
        print(f"  [{phone}] Quick sync via catch_up()...")
        await asyncio.wait_for(client.catch_up(), timeout=15)
    except asyncio.TimeoutError:
        print(f"  [{phone}] catch_up timeout - will fetch dialogs instead")
    except Exception as e:
        error_str = str(e).lower()
        if is_telegram_server_error(error_str):
            print(f"  [{phone}] Telegram servers busy during catch_up")
        else:
            print(f"  [{phone}] catch_up error: {str(e)[:40]}")
    
    # Strategy 2: ALWAYS fetch unread messages from dialogs (this is the reliable method)
    try:
        print(f"  [{phone}] Fetching unread messages from dialogs...")
        dialogs = await asyncio.wait_for(client.get_dialogs(limit=50), timeout=30)
        
        for dialog in dialogs:
            try:
                # Only process private chats with unread messages
                if not dialog.is_user or dialog.unread_count == 0:
                    continue
                
                # Check if this is a contact (matches our early filter)
                entity = dialog.entity
                is_contact = getattr(entity, 'contact', False)
                if not is_contact:
                    continue
                
                sender = entity
                sender_id = sender.id
                sender_username = getattr(sender, 'username', None)
                sender_phone_raw = getattr(sender, 'phone', None)
                sender_phone = f"+{sender_phone_raw}" if sender_phone_raw and not sender_phone_raw.startswith('+') else sender_phone_raw
                sender_name = f"{getattr(sender, 'first_name', '') or ''} {getattr(sender, 'last_name', '') or ''}".strip() or str(sender_id)
                
                # Get the last synced message ID for this sender
                sender_key = f"{account_id}_{sender_id}"
                last_synced_id = last_synced_msg_ids.get(sender_key, 0)
                
                # Fetch unread messages from this dialog (limit to last 48 hours)
                messages = await client.get_messages(dialog.entity, limit=min(dialog.unread_count, 100))
                
                # Calculate 48 hours ago cutoff
                from datetime import datetime, timezone, timedelta
                cutoff_time = datetime.now(timezone.utc) - timedelta(hours=48)
                
                max_msg_id = last_synced_id
                for msg in reversed(messages):  # Process oldest first
                    if msg.out:  # Skip outgoing
                        continue
                    if not msg.text and not msg.photo and not msg.video and not msg.document:
                        continue
                    
                    # SKIP if we've already processed this message ID (check first for efficiency)
                    if msg.id <= last_synced_id:
                        skipped_count += 1
                        continue
                    
                    # SKIP if message is older than 48 hours
                    if msg.date and msg.date < cutoff_time:
                        skipped_count += 1
                        continue
                    
                    # Track the highest message ID we've seen
                    if msg.id > max_msg_id:
                        max_msg_id = msg.id
                    
                    content = msg.text or ""
                    media_url = None
                    media_type = None
                    
                    if msg.photo:
                        content = "[Photo] " + (msg.text or "")
                        media_type = "image"
                        # Download and upload photo to storage
                        try:
                            photo_bytes = await client.download_media(msg.photo, bytes)
                            if photo_bytes:
                                file_name = f"incoming_{account_id}_{msg.id}_{int(time.time() * 1000)}.jpg"
                                file_path = f"{account_id}/{file_name}"
                                
                                mime_type = "image/jpeg"
                                if hasattr(msg, 'file') and msg.file:
                                    mime_type = getattr(msg.file, 'mime_type', None) or "image/jpeg"
                                
                                http = get_http_client()
                                upload_response = await http.put(
                                    f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{file_path}",
                                    headers={
                                        "apikey": SUPABASE_KEY,
                                        "Authorization": f"Bearer {SUPABASE_KEY}",
                                        "Content-Type": mime_type,
                                        "x-upsert": "true"
                                    },
                                    content=photo_bytes,
                                    timeout=HTTP_TIMEOUT_UPLOAD
                                )
                                if upload_response.status_code in (200, 201):
                                    media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{file_path}"
                                    print(f"      [OK] Synced photo uploaded: {file_name}")
                                else:
                                    print(f"      [WARN] Sync photo upload failed: {upload_response.status_code}")
                        except Exception as e:
                            if not is_network_error(str(e)):
                                print(f"      [WARN] Could not upload synced photo: {str(e)[:50]}")
                    elif msg.video:
                        content = "[Video] " + (msg.text or "")
                        media_type = "video"
                    elif msg.document:
                        content = "[File] " + (msg.text or "")
                        media_type = "document"
                    
                    if not content:
                        content = "[Media]"
                    
                    # Report the missed message with telegram_message_id for deduplication
                    await report_result("incoming_message", {
                        "account_id": account_id,
                        "sender_id": sender_id,
                        "sender_name": sender_name,
                        "sender_username": sender_username,
                        "sender_phone": sender_phone,
                        "sender_avatar": None,
                        "content": content,
                        "media_url": media_url,
                        "media_type": media_type,
                        "telegram_message_id": msg.id  # For deduplication on restart
                    })
                    fetched_count += 1
                
                # Update the last synced ID for this sender
                if max_msg_id > last_synced_id:
                    last_synced_msg_ids[sender_key] = max_msg_id
                    
            except Exception as e:
                if not is_network_error(str(e)) and not is_telegram_server_error(str(e)):
                    print(f"    [WARN] Error processing dialog: {str(e)[:40]}")
                continue
        
        if fetched_count > 0:
            print(f"  [{phone}] ✓ Recovered {fetched_count} missed messages (skipped {skipped_count} already synced)")
        elif skipped_count > 0:
            print(f"  [{phone}] ✓ Skipped {skipped_count} already synced messages")
        else:
            print(f"  [{phone}] ✓ No unread messages from contacts")
        return True, False
        
    except asyncio.TimeoutError:
        print(f"  [{phone}] Dialog fetch timeout - will retry later")
        return False, True
    except Exception as e:
        error_str = str(e).lower()
        if is_telegram_server_error(error_str):
            print(f"  [{phone}] Telegram servers busy - will retry sync later")
            return False, True
        if is_network_error(error_str):
            print(f"  [{phone}] Network error during sync - will retry")
            return False, True
        print(f"  [{phone}] Sync error: {e}")
        return False, False


async def fetch_recent_dialog_messages(client, account_id: str, phone: str, max_dialogs: int = 30, last_synced_msg_ids: dict = None):
    """
    Fallback: Fetch recent unread messages from dialogs if catch_up fails.
    This manually retrieves messages that were received while offline.
    Uses last_synced_msg_ids to skip already-processed messages.
    """
    if last_synced_msg_ids is None:
        last_synced_msg_ids = {}
    
    try:
        print(f"  [{phone}] Fetching recent dialog messages as fallback...")
        fetched_count = 0
        skipped_count = 0
        
        dialogs = await asyncio.wait_for(client.get_dialogs(limit=max_dialogs), timeout=DIALOG_FETCH_TIMEOUT)
        
        for dialog in dialogs:
            try:
                # Only process private chats with unread messages
                if not dialog.is_user or dialog.unread_count == 0:
                    continue
                
                # Check if this is a contact (matches our early filter)
                entity = dialog.entity
                is_contact = getattr(entity, 'contact', False)
                if not is_contact:
                    continue
                
                sender_id = entity.id
                sender_key = f"{account_id}_{sender_id}"
                last_synced_id = last_synced_msg_ids.get(sender_key, 0)
                
                # Fetch unread messages (limit to last 48 hours)
                messages = await client.get_messages(dialog.entity, limit=min(dialog.unread_count, 50))
                
                # Calculate 48 hours ago cutoff (was 1 hour)
                from datetime import datetime, timezone, timedelta
                cutoff_time = datetime.now(timezone.utc) - timedelta(hours=48)
                
                max_msg_id = last_synced_id
                for msg in reversed(messages):  # Process oldest first
                    if msg.out:  # Skip outgoing
                        continue
                    if not msg.text and not msg.photo:  # Skip non-text/photo
                        continue
                    
                    # SKIP if we've already processed this message ID (check first for efficiency)
                    if msg.id <= last_synced_id:
                        skipped_count += 1
                        continue
                    
                    # SKIP if message is older than 48 hours
                    if msg.date and msg.date < cutoff_time:
                        skipped_count += 1
                        continue
                    
                    # Track the highest message ID
                    if msg.id > max_msg_id:
                        max_msg_id = msg.id
                    
                    sender = await msg.get_sender()
                    if not sender or not hasattr(sender, 'id'):
                        continue
                    
                    # Get sender info
                    sender_username = getattr(sender, 'username', None)
                    sender_phone = None
                    if hasattr(sender, 'phone') and sender.phone:
                        sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
                    sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
                    
                    content = msg.text or "[Media]"
                    media_url = None
                    media_type = None
                    
                    if msg.photo:
                        content = "[Photo] " + (msg.text or "")
                        media_type = "image"
                        # Download and upload photo to storage
                        try:
                            photo_bytes = await client.download_media(msg.photo, bytes)
                            if photo_bytes:
                                file_name = f"incoming_{account_id}_{msg.id}_{int(time.time() * 1000)}.jpg"
                                file_path = f"{account_id}/{file_name}"
                                
                                mime_type = "image/jpeg"
                                if hasattr(msg, 'file') and msg.file:
                                    mime_type = getattr(msg.file, 'mime_type', None) or "image/jpeg"
                                
                                http = get_http_client()
                                upload_response = await http.put(
                                    f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{file_path}",
                                    headers={
                                        "apikey": SUPABASE_KEY,
                                        "Authorization": f"Bearer {SUPABASE_KEY}",
                                        "Content-Type": mime_type,
                                        "x-upsert": "true"
                                    },
                                    content=photo_bytes,
                                    timeout=HTTP_TIMEOUT_UPLOAD
                                )
                                if upload_response.status_code in (200, 201):
                                    media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{file_path}"
                                    print(f"      [OK] Fallback photo uploaded: {file_name}")
                                else:
                                    print(f"      [WARN] Fallback photo upload failed: {upload_response.status_code}")
                        except Exception as e:
                            if not is_network_error(str(e)):
                                print(f"      [WARN] Could not upload fallback photo: {str(e)[:50]}")
                    
                    # Report the missed message with telegram_message_id for deduplication
                    await report_result("incoming_message", {
                        "account_id": account_id,
                        "sender_id": sender.id,
                        "sender_name": sender_name,
                        "sender_username": sender_username,
                        "sender_phone": sender_phone,
                        "sender_avatar": None,
                        "content": content,
                        "media_url": media_url,
                        "media_type": media_type,
                        "telegram_message_id": msg.id  # For deduplication on restart
                    })
                    fetched_count += 1
                
                # Update last synced ID
                if max_msg_id > last_synced_id:
                    last_synced_msg_ids[sender_key] = max_msg_id
                    
            except Exception as e:
                if not is_network_error(str(e)):
                    print(f"    [WARN] Error fetching dialog: {e}")
                continue
        
        if fetched_count > 0:
            print(f"  [{phone}] Fetched {fetched_count} missed messages (skipped {skipped_count} already synced)")
        elif skipped_count > 0:
            print(f"  [{phone}] Skipped {skipped_count} already synced messages")
        else:
            print(f"  [{phone}] No new messages from dialogs")
        return True
    except asyncio.TimeoutError:
        print(f"  [{phone}] Dialog fetch timeout")
        return False
    except Exception as e:
        if is_telegram_server_error(str(e)):
            print(f"  [{phone}] Telegram servers busy during dialog fetch")
        elif not is_network_error(str(e)):
            print(f"  [{phone}] Dialog fetch error: {e}")
        return False


async def check_conversation_exists(account_id: str, sender_id: int, sender_username: str = None, sender_phone: str = None) -> bool:
    """Multi-strategy matching: telegram_id -> username -> phone"""
    import re
    try:
        http = get_http_client()
        
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
            digits = re.sub(r'\\D', '', sender_phone)
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
        # Check if this is a network error
        if is_network_error(str(e)):
            print(f"    [WARN] Network error checking conversation (wifi issue?)")
            return False
        print(f"    [WARN] Check conversation error: {e}")
        return False


async def setup_message_handler(client, account_id: str):
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
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
            
            # ========== EARLY FILTER: Contacts only ==========
            # Only accept messages from users in account's contact list
            is_contact = getattr(sender, 'contact', False)
            if not is_contact:
                return
            
            content = event.message.text or "[Media]"
            media_url = None
            media_type = None
            
            if event.message.photo:
                print(f"    [PHOTO] Receiving...")
                content = "[Photo] " + (event.message.text or "")
                media_type = "image"
                try:
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        print(f"    [PHOTO] Downloaded {len(photo_bytes)} bytes, uploading...")
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        
                        mime_type = "image/jpeg"
                        if hasattr(event.message, 'file') and event.message.file:
                            mime_type = getattr(event.message.file, 'mime_type', None) or "image/jpeg"
                        
                        http = get_http_client()
                        upload_response = await http.put(
                            f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{file_path}",
                            headers={
                                "apikey": SUPABASE_KEY,
                                "Authorization": f"Bearer {SUPABASE_KEY}",
                                "Content-Type": mime_type,
                                "x-upsert": "true"
                            },
                            content=photo_bytes,
                            timeout=HTTP_TIMEOUT_UPLOAD
                        )
                        if upload_response.status_code in (200, 201):
                            media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{file_path}"
                            print(f"    [OK] Photo uploaded: {file_name}")
                        else:
                            error_text = upload_response.text[:300] if upload_response.text else "No details"
                            print(f"    [WARN] Photo upload failed: {upload_response.status_code} - {error_text}")
                    else:
                        print(f"    [WARN] Photo download returned empty bytes")
                except Exception as e:
                    print(f"    [WARN] Photo error: {str(e)[:100]}")
            
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
            except:
                pass
            
            print(f"  [IN] From {sender_name}: {content[:40]}...")
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": sender_name,
                "sender_username": sender_username,
                "sender_phone": sender_phone,
                "sender_avatar": avatar_base64,
                "content": content,
                "media_url": media_url,
                "media_type": media_type,
                "telegram_message_id": event.message.id  # For deduplication on restart
            })
        except Exception as e:
            if not is_network_error(str(e)):
                print(f"  [WARN] Handler error: {e}")


# ========== FLAG TO PAUSE keep_clients_alive DURING BATCH PROCESSING ==========
_processing_batch = False


async def keep_clients_alive():
    """
    Background task that keeps all clients receiving updates - with network error handling.
    
    PAUSES during batch processing to prevent SQLite lock conflicts.
    """
    consecutive_errors = 0
    MAX_CONSECUTIVE_ERRORS = 10
    
    while RUNNING:
        # ========== PAUSE DURING BATCH PROCESSING ==========
        if _processing_batch:
            await asyncio.sleep(0.5)
            continue
        
        try:
            # Balanced loop - fast but not aggressive
            await asyncio.sleep(0.1)  # 10 checks per second (less aggressive)
            
            # Process updates for all connected clients
            disconnected_ids = []
            for acc_id, client in list(active_clients.items()):
                try:
                    if client.is_connected():
                        # This processes pending updates without blocking
                        await asyncio.wait_for(client.catch_up(), timeout=5)
                    else:
                        # Client disconnected - mark for removal
                        disconnected_ids.append(acc_id)
                except asyncio.TimeoutError:
                    print(f"  [TIMEOUT] catch_up timeout for {acc_id[:8]}")
                except Exception as e:
                    error_str = str(e).lower()
                    # Check for Telegram server errors (RpcCallFailError) - don't disconnect, just skip
                    if is_telegram_server_error(error_str):
                        print(f"  [TELEGRAM] Server busy, skipping iteration: {str(e)[:40]}")
                        await asyncio.sleep(5)
                        continue
                    # Check for network errors
                    if is_network_error(error_str) or "winerror 64" in error_str or "network name" in error_str:
                        consecutive_errors += 1
                        if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                            print(f"  [NETWORK] Multiple network errors - waiting 10s for recovery...")
                            await asyncio.sleep(10)
                            consecutive_errors = 0
                    else:
                        disconnected_ids.append(acc_id)
            
            # Clean up disconnected clients
            for acc_id in disconnected_ids:
                if acc_id in active_clients:
                    try:
                        del active_clients[acc_id]
                        print(f"  [CLEANUP] Removed disconnected client {acc_id[:8]}")
                    except:
                        pass
            
            # Reset error counter on successful iteration
            if not disconnected_ids:
                consecutive_errors = max(0, consecutive_errors - 1)
                
        except Exception as e:
            error_str = str(e).lower()
            # Handle Telegram server errors gracefully
            if is_telegram_server_error(error_str):
                print(f"  [TELEGRAM] Server issue in keep_alive: {str(e)[:40]}")
                await asyncio.sleep(10)
            elif is_network_error(error_str) or "winerror 64" in error_str:
                print(f"  [NETWORK] keep_clients_alive network error - waiting 5s...")
                await asyncio.sleep(5)
            else:
                await asyncio.sleep(0.5)


async def get_pooled_client(account: dict, setup_handler=None):
    """Get client from active pool or connect with fingerprint/proxy."""
    acc_id = account.get("id")
    if not acc_id:
        return None
    
    # Check if already in pool and connected
    client = active_clients.get(acc_id)
    if client and client.is_connected():
        return client
    
    # Connect with fingerprint and proxy
    client, error = await connect_account_with_fingerprint(
        account, setup_handler=setup_handler, task_proxy=account.get("proxy")
    )
    return client


async def process_incoming_messages():
    """Process updates for all connected clients - triggers message handlers."""
    for acc_id, client in list(active_clients.items()):
        try:
            if client and client.is_connected():
                await asyncio.wait_for(client.catch_up(), timeout=5)
        except asyncio.TimeoutError:
            pass
        except Exception:
            pass


async def fetch_active_accounts():
    """Fetch all active accounts with assigned proxy for upfront connection."""
    try:
        http = get_http_client()
        response = await http.get(
            f"{SUPABASE_URL_BASE}/rest/v1/telegram_accounts",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            params={
                "status": "eq.active",
                "proxy_id": "not.is.null",
                "session_data": "not.is.null",
                "select": "*,proxy:proxies(*)"
            },
            timeout=HTTP_TIMEOUT_DEFAULT
        )
        if response.status_code == 200:
            return response.json()
        return []
    except Exception as e:
        print(f"[ERROR] Failed to fetch accounts: {e}")
        return []


async def main_loop():
    print("=" * 50)
    print("  LiveChat Runner (48-HOUR SYNC + PARALLEL SEND)")
    print("  BUILD: 2026-01-18-parallel-batch")
    print("  [Upfront Connection + Parallel Batch Processing]")
    print("  ⚡ Connects ALL accounts FIRST before processing")
    print("  📨 48-hour sync window, skips already fetched")
    print("  🚀 Parallel message sending (no stagger)")
    print("=" * 50)
    
    connected_ids = set()
    failed_proxy_accounts = {}
    pending_sync_accounts = {}
    last_synced_msg_ids = {}
    last_cleanup = time.time()
    last_heartbeat = time.time()
    last_sync_retry = time.time()
    last_proxy_retry = time.time()
    iteration_count = 0
    
    # ========== PHASE 1: CONNECT ALL ACCOUNTS IN PARALLEL ==========
    print("[STARTUP] Fetching all active accounts with proxy...")
    accounts = await fetch_active_accounts()
    
    if accounts:
        # ===== QUICK VALIDATION (silent unless issues) =====
        valid_accounts = []
        skipped = 0
        for acc in accounts:
            proxy_data = acc.get("proxy")
            if not proxy_data or not proxy_data.get("host"):
                phone = acc.get("phone_number", "???")[-4:]
                print(f"  ⛔ [{phone}] SKIP - No proxy assigned")
                skipped += 1
                continue
            valid_accounts.append(acc)
        
        if skipped > 0:
            print(f"[STARTUP] ⚠ Skipped {skipped} accounts without proxy")
        
        # Use only validated accounts
        accounts = valid_accounts
        
        if not accounts:
            print("[STARTUP] ⚠ No valid accounts to connect!")
        else:
            print(f"[STARTUP] Connecting {len(accounts)} accounts in PARALLEL...")
            start_time = time.time()
            
            # Create all connection tasks at once - NO AWAIT inside loop
            connection_tasks = []
            for acc in accounts:
                acc_id = acc.get("id")
                phone = acc.get("phone_number", "???")[-4:]
                
                async def connect_one(a_id, a_phone, a_acc):
                    try:
                        client, error = await asyncio.wait_for(
                            connect_account_with_fingerprint(a_acc, setup_handler=setup_message_handler, task_proxy=a_acc.get("proxy")),
                            timeout=CONNECT_TIMEOUT_SECONDS
                        )
                        return a_id, client, error, a_phone
                    except asyncio.TimeoutError:
                        return a_id, None, "TIMEOUT", a_phone
                    except Exception as e:
                        return a_id, None, str(e), a_phone
                
                # Add task to list (not awaited yet)
                connection_tasks.append(connect_one(acc_id, phone, acc))
            
            # Execute ALL connections in parallel at the same time
            results = await asyncio.gather(*connection_tasks, return_exceptions=True)
            
            elapsed = time.time() - start_time
            success_count = 0
            fail_count = 0
            for result in results:
                if isinstance(result, Exception):
                    fail_count += 1
                    continue
                acc_id, client, error, phone = result
                if client:
                    connected_ids.add(acc_id)
                    success_count += 1
                else:
                    fail_count += 1
            
            print(f"[STARTUP] ✓ Connected {success_count}/{len(accounts)} in {elapsed:.1f}s")
    
    # ========== PHASE 2: SYNC MESSAGES IN PARALLEL ==========
    if connected_ids:
        # Build account lookup
        account_map = {acc.get("id"): acc for acc in accounts}
        
        # Create sync tasks for all connected accounts
        sync_tasks = []
        for acc_id in list(connected_ids):
            client = active_clients.get(acc_id)
            if client:
                acc = account_map.get(acc_id, {})
                phone = acc.get("phone_number", "????")[-4:]
                sync_tasks.append(sync_missed_messages(client, acc_id, phone, last_synced_msg_ids))
        
        # Execute ALL syncs in parallel
        if sync_tasks:
            await asyncio.gather(*sync_tasks, return_exceptions=True)
    
    # ========== PHASE 3: START BACKGROUND TASK ==========
    asyncio.create_task(keep_clients_alive())
    print("[STARTUP] Ready! Entering main loop...")
    
    # ========== MAIN LOOP ==========
    while RUNNING:
        try:
            iteration_count += 1
            
            # ========== PROCESS INCOMING MESSAGES ==========
            await process_incoming_messages()
            
            # ========== RETRY PROXY ERROR ACCOUNTS (every 30s) ==========
            if time.time() - last_proxy_retry >= 30:
                await retry_proxy_error_accounts()
                last_proxy_retry = time.time()
            
            # Heartbeat logging
            if time.time() - last_heartbeat > HEARTBEAT_INTERVAL:
                print(f"  [HEARTBEAT] Iteration {iteration_count}, Connected: {len(connected_ids)}, Active: {len(active_clients)}")
                last_heartbeat = time.time()
            
            # Periodic cleanup
            if time.time() - last_cleanup > CLEANUP_INTERVAL:
                stale_ids = [acc_id for acc_id in connected_ids if acc_id not in active_clients]
                for acc_id in stale_ids:
                    connected_ids.discard(acc_id)
                if stale_ids:
                    print(f"  [CLEANUP] Removed {len(stale_ids)} stale IDs")
                
                now = time.time()
                expired_failures = [acc_id for acc_id, retry_time in failed_proxy_accounts.items() if now > retry_time]
                for acc_id in expired_failures:
                    del failed_proxy_accounts[acc_id]
                    connected_ids.discard(acc_id)
                
                await cleanup_stale_clients()
                gc.collect()
                last_cleanup = time.time()
            
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                # Handle any NEW accounts that were added after startup
                new_accounts = [
                    acc for acc in task.get("accounts", [])
                    if acc.get("id") not in connected_ids
                    and acc.get("id") not in failed_proxy_accounts
                ]
                
                for acc in new_accounts:
                    client = await get_pooled_client(acc, setup_handler=setup_message_handler)
                    if client:
                        connected_ids.add(acc.get("id"))
                        phone = acc.get("phone_number", "?")[-4:]
                        await sync_missed_messages(client, acc.get("id"), phone, last_synced_msg_ids)
                
                wait_seconds = task.get("seconds", 0.5)
                if wait_seconds > 0:
                    for _ in range(int(wait_seconds * 10)):
                        if not RUNNING:
                            break
                        await asyncio.sleep(0.1)
                else:
                    await asyncio.sleep(0.05)
            
            # ========== RETRY PENDING SYNCS ==========
            if time.time() - last_sync_retry > 10:
                now = time.time()
                sync_due = [(acc_id, phone) for acc_id, (retry_time, phone) in pending_sync_accounts.items()
                            if now > retry_time and acc_id in active_clients]
                
                for acc_id, phone in sync_due:
                    client = active_clients.get(acc_id)
                    if client and client.is_connected():
                        try:
                            sync_success, needs_retry = await sync_missed_messages(client, acc_id, phone, last_synced_msg_ids)
                            if sync_success:
                                del pending_sync_accounts[acc_id]
                            elif needs_retry:
                                pending_sync_accounts[acc_id] = (now + SYNC_RETRY_INTERVAL, phone)
                            else:
                                await fetch_recent_dialog_messages(client, acc_id, phone, 30, last_synced_msg_ids)
                                del pending_sync_accounts[acc_id]
                        except Exception as e:
                            if is_telegram_server_error(str(e)):
                                pending_sync_accounts[acc_id] = (now + SYNC_RETRY_INTERVAL, phone)
                            else:
                                del pending_sync_accounts[acc_id]
                
                last_sync_retry = time.time()
            
            elif task_type == "send_parallel":
                # ========== PARALLEL BATCH PROCESSING (NO STAGGER) ==========
                batches = task.get("batches", [])
                
                if batches:
                    print(f"  [PARALLEL] Processing {len(batches)} batches ({sum(len(b.get('messages', [])) for b in batches)} messages)...")
                    
                    async def process_batch(batch):
                        account = batch.get("account", {})
                        messages = batch.get("messages", [])
                        acc_id = account.get("id")
                        phone = account.get("phone_number", acc_id[:8] if acc_id else "?")[-4:]
                        
                        client = await get_pooled_client(account, setup_handler=setup_message_handler)
                        if not client:
                            return [{"success": False, "error": "Connection failed", "message_id": msg.get("id"), "account_id": acc_id} for msg in messages]
                        
                        async def send_single(msg):
                            recipient = msg.get("recipient_telegram_id") or msg.get("recipient_username") or msg.get("recipient_phone") or msg.get("recipient")
                            content = msg.get("content", "")
                            try:
                                send_result = await send_message(client, recipient, content, msg.get("media_url"))
                                success = send_result[0] if isinstance(send_result, tuple) else False
                                error = send_result[1] if isinstance(send_result, tuple) else str(send_result)
                                return {"success": success, "error": error, "message_id": msg.get("id"), "account_id": acc_id}
                            except Exception as e:
                                return {"success": False, "error": str(e), "message_id": msg.get("id"), "account_id": acc_id}
                        
                        # Send ALL messages in parallel - no stagger
                        results = await asyncio.gather(*[send_single(msg) for msg in messages], return_exceptions=True)
                        print(f"    [{phone}] Sent {len(messages)} messages (parallel)")
                        return results
                    
                    # Process ALL batches in parallel
                    global _processing_batch
                    _processing_batch = True
                    try:
                        all_results = await asyncio.gather(*[process_batch(b) for b in batches], return_exceptions=True)
                    finally:
                        _processing_batch = False
                    
                    # Report results
                    flat_results = []
                    for r in all_results:
                        if isinstance(r, list):
                            for item in r:
                                if isinstance(item, dict):
                                    flat_results.append(item)
                        elif isinstance(r, dict):
                            flat_results.append(r)
                    
                    for result in flat_results:
                        if isinstance(result, dict) and not is_network_error(str(result.get("error", ""))):
                            await report_result("send", result)
                    
                    print(f"  [DONE] Parallel batch: {len(flat_results)} messages processed")
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                proxy = task.get("proxy")
                
                client, error = await connect_account_with_fingerprint(account, setup_handler=setup_message_handler, task_proxy=proxy)
                
                if client and recipient:
                    print(f"  [REPLY] To {recipient}...")
                    success, send_error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    
                    # Only report if not a network error
                    if not is_network_error(str(send_error)):
                        await report_result("send", {
                            "message_id": msg.get("id"),
                            "success": success,
                            "error": send_error,
                            "account_id": account.get("id")
                        })
                    else:
                        print(f"  [SKIP REPORT] Network error, not updating status")
                elif error and not error.startswith("NETWORK_ERROR:"):
                    # Only report failure if not a network error
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": False,
                        "error": error,
                        "account_id": account.get("id")
                    })
        
        except Exception as e:
            global _network_error_count, _last_network_error_time
            error_str = str(e).lower()
            
            # Check if this is a network error (including WinError 64)
            if is_network_error(error_str) or "winerror 64" in error_str or "network name" in error_str:
                _network_error_count += 1
                _last_network_error_time = time.time()
                
                # Exponential backoff: 2^n seconds, capped at MAX_NETWORK_BACKOFF
                backoff = min(2 ** _network_error_count, MAX_NETWORK_BACKOFF)
                print(f"  [NETWORK] Connection issue ({_network_error_count}x): {str(e)[:40]}")
                print(f"  [BACKOFF] Waiting {backoff}s for network recovery...")
                await asyncio.sleep(backoff)
            else:
                # Reset error count on non-network errors
                _network_error_count = 0
                print(f"  [ERROR] {e}")
                await asyncio.sleep(0.5)
    
    await shutdown_all()


def save_all_sessions_sync():
    """
    Synchronous wrapper to save all sessions - for use in signal handlers.
    Creates a new event loop to run the async save operation.
    """
    import asyncio
    from client_manager import active_clients, save_session_to_db
    
    if not active_clients:
        return
    
    print("\\n  [SHUTDOWN] Saving sessions before exit...")
    
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        async def save_all():
            for account_id, client in list(active_clients.items()):
                try:
                    phone = getattr(client.session, 'filename', account_id)
                    if phone:
                        phone = os.path.basename(phone).replace('.session', '')
                        await save_session_to_db(account_id, phone)
                except Exception as e:
                    print(f"    [WARN] Could not save session for {account_id[:8]}: {e}")
        
        loop.run_until_complete(save_all())
        loop.close()
        print("  [OK] Sessions saved.")
    except Exception as e:
        print(f"  [WARN] Session save on exit failed: {e}")


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx\\n")
    
    # Import for HTTP client reset
    from client_manager import reset_http_client
    
    while True:  # FOREVER LOOP WITH CRASH RECOVERY
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Stopping...")
            # Save sessions on graceful shutdown
            save_all_sessions_sync()
            break
        except Exception as e:
            error_str = str(e).lower()
            # Check if network error (including WinError 64)
            if is_network_error(error_str) or "winerror 64" in error_str or "network name" in error_str:
                print(f"\\n📶 Network error (connection dropped): {e}")
                print("  Clearing stale connections and waiting 20 seconds...")
                # Save sessions before network recovery restart
                save_all_sessions_sync()
                # Reset HTTP client to clear stale connections
                reset_http_client()
                time.sleep(20)
            else:
                print(f"\\n⚠ LiveChat crashed: {e}")
                print("  Saving sessions before restart...")
                # Save sessions before crash recovery restart
                save_all_sessions_sync()
                reset_http_client()
                print("  Restarting in 5 seconds...")
                time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== 6. ACCOUNT_RUNNER.PY ==========
  const accountRunnerPy = `#!/usr/bin/env python3
"""
Account Runner - Handles SpamBot, name, photo, privacy, password, contact import

BUILD: 2026-01-14-proxy-fingerprint-sync

ORDER OF OPERATIONS (CRITICAL):
1. PROXY FIRST - check assigned proxy is valid and active (MANDATORY)
2. FINGERPRINT - generate if missing, save to DB SYNCHRONOUSLY
3. CONNECT - using both proxy and fingerprint
4. PERFORM ACTION - execute account management task

NO ACCOUNT RUNS WITHOUT PROXY AND FINGERPRINT!
"""
import asyncio
import signal
import os
import base64
import httpx

from client_manager import (
    get_or_create_client, report_result, shutdown_all, disconnect_client,
    validate_contact, SESSION_FOLDER, SUPABASE_KEY, BACKEND_URL, active_clients,
    save_session_to_db
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_spambot(client):
    """
    Check SpamBot - detects banned, restricted, frozen using official API.
    Uses proper exception handling for safe operation.
    """
    from telethon.errors import (
        RPCError, FloodWaitError, UserDeactivatedBanError, 
        AuthKeyUnregisteredError, SessionRevokedError
    )
    
    try:
        # Use get_input_entity for efficiency
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)  # Wait for SpamBot response (required)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        response_lower = response.lower()
        
        # BANNED state  
        if "banned" in response_lower or "deleted" in response_lower or "заблокирован" in response_lower:
            return "banned", response[:200], response
        # FROZEN state
        if "frozen" in response_lower or "заморожен" in response_lower:
            return "frozen", "Account frozen", response
        # LIMITED/RESTRICTED state
        if "limited" in response_lower or "restricted" in response_lower or "ограничен" in response_lower:
            return "restricted", "Limited", response
        # CLEAN state
        if "no limits" in response_lower or "good news" in response_lower or "нет ограничений" in response_lower:
            return "active", None, response
        return "active", None, response
    except FloodWaitError as e:
        return "restricted", f"FloodWait:{e.seconds}s", f"FloodWait error: {e.seconds}s"
    except UserDeactivatedBanError:
        return "banned", "User deactivated", "User deactivated or banned"
    except AuthKeyUnregisteredError:
        return "disconnected", "Auth key unregistered", "Session expired"
    except SessionRevokedError:
        return "disconnected", "Session revoked", "Session revoked"
    except RPCError as e:
        error_str = str(e).lower()
        if "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), f"Error: {e}"
        if "frozen" in error_str:
            return "frozen", str(e), f"Error: {e}"
        if "auth" in error_str or "session" in error_str:
            return "disconnected", str(e), f"Error: {e}"
        return "active", None, f"Error: {e}"
    except Exception as e:
        error_str = str(e).lower()
        if "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), f"Error: {e}"
        if "frozen" in error_str:
            return "frozen", str(e), f"Error: {e}"
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
    import uuid
    temp_path = None
    try:
        from telethon.tl.functions.photos import UploadProfilePhotoRequest
        import aiohttp
        
        # Use unique temp file per task to avoid race conditions in parallel execution
        unique_id = str(uuid.uuid4())[:8]
        temp_path = os.path.join(SESSION_FOLDER, f"temp_photo_{unique_id}.jpg")
        
        # Check if it's a URL or base64
        if photo_source.startswith("http://") or photo_source.startswith("https://"):
            # Download from URL
            async with aiohttp.ClientSession() as session:
                async with session.get(photo_source) as resp:
                    if resp.status == 200:
                        photo_bytes = await resp.read()
                        with open(temp_path, "wb") as f:
                            f.write(photo_bytes)
                    else:
                        return False, f"Failed to download image: HTTP {resp.status}"
        else:
            # Assume base64
            photo_bytes = base64.b64decode(photo_source)
            with open(temp_path, "wb") as f:
                f.write(photo_bytes)
        
        file = await client.upload_file(temp_path)
        await client(UploadProfilePhotoRequest(file=file))
        return True, None
    except Exception as e:
        return False, str(e)
    finally:
        # Always clean up temp file
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except:
                pass


async def update_privacy(client, hide_phone, hide_last_seen, disable_calls, hide_profile_photo=False):
    """
    Update account privacy settings using official Telegram API.
    Uses SetPrivacyRequest with proper InputPrivacyKey types for safe operation.
    
    Args:
        client: TelegramClient instance
        hide_phone: Hide phone number from everyone
        hide_last_seen: Hide last seen status from everyone
        disable_calls: Disable voice/video calls from everyone
        hide_profile_photo: Hide profile photo from everyone
    """
    from telethon.tl.functions.account import SetPrivacyRequest
    from telethon.tl.types import (
        InputPrivacyKeyPhoneNumber, 
        InputPrivacyKeyStatusTimestamp, 
        InputPrivacyKeyPhoneCall, 
        InputPrivacyKeyProfilePhoto,
        InputPrivacyValueDisallowAll
    )
    from telethon.errors import RPCError, FloodWaitError
    
    results = []
    errors = []
    
    try:
        if hide_phone:
            try:
                await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneNumber(), rules=[InputPrivacyValueDisallowAll()]))
                results.append("phone hidden")
            except RPCError as e:
                errors.append(f"phone:{e.message}")
        
        if hide_last_seen:
            try:
                await client(SetPrivacyRequest(key=InputPrivacyKeyStatusTimestamp(), rules=[InputPrivacyValueDisallowAll()]))
                results.append("last seen hidden")
            except RPCError as e:
                errors.append(f"lastseen:{e.message}")
        
        if disable_calls:
            try:
                await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneCall(), rules=[InputPrivacyValueDisallowAll()]))
                results.append("calls disabled")
            except RPCError as e:
                errors.append(f"calls:{e.message}")
        
        if hide_profile_photo:
            try:
                await client(SetPrivacyRequest(key=InputPrivacyKeyProfilePhoto(), rules=[InputPrivacyValueDisallowAll()]))
                results.append("profile photo hidden")
            except RPCError as e:
                errors.append(f"photo:{e.message}")
        
        if errors:
            return len(results) > 0, f"Applied: {', '.join(results)}. Errors: {', '.join(errors)}"
        return True, f"Updated: {', '.join(results)}" if results else "No changes"
    except FloodWaitError as e:
        return False, f"FloodWait:{e.seconds}s"
    except Exception as e:
        return False, str(e)


async def change_password(client, existing_pwd, new_pwd):
    """
    Set or change 2FA cloud password.
    
    Args:
        client: TelegramClient instance
        existing_pwd: Current password (empty string if no password set)
        new_pwd: New password to set (min 6 characters)
    """
    try:
        from telethon.tl.functions.account import UpdatePasswordSettingsRequest, GetPasswordRequest
        from telethon.password import compute_check, compute_hash
        from telethon.tl.types.account import PasswordInputSettings
        
        # Get current password state
        pwd = await client(GetPasswordRequest())
        
        # Compute check for existing password (if account has 2FA enabled)
        if pwd.has_password:
            if not existing_pwd:
                return False, "Account has 2FA enabled - existing password required"
            check = compute_check(pwd, existing_pwd)
        else:
            check = None
        
        # Compute new password hash using the account's algorithm
        new_password_hash = compute_hash(pwd.new_algo, new_pwd)
        
        # Create new settings
        new_settings = PasswordInputSettings(
            new_algo=pwd.new_algo,
            new_password_hash=new_password_hash,
            hint=""  # Optional hint
        )
        
        await client(UpdatePasswordSettingsRequest(password=check, new_settings=new_settings))
        return True, "Password updated successfully"
    except Exception as e:
        error_str = str(e).lower()
        if "password" in error_str and "invalid" in error_str:
            return False, "Invalid existing password"
        elif "password" in error_str and "required" in error_str:
            return False, "Existing password required"
        return False, str(e)


async def logout_other_sessions(client):
    try:
        from telethon.tl.functions.auth import ResetAuthorizationsRequest
        await client(ResetAuthorizationsRequest())
        return True, None
    except Exception as e:
        return False, str(e)


async def verify_session(client, account_id):
    """Verify if session is active by checking get_me()"""
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if me:
            return "active", None, {
                "telegram_id": me.id,
                "username": me.username,
                "first_name": me.first_name,
                "last_name": me.last_name
            }
        return "disconnected", "Could not get user info", None
    except asyncio.TimeoutError:
        return "disconnected", "Connection timeout", None
    except Exception as e:
        error_str = str(e).lower()
        if "auth" in error_str or "session" in error_str or "revoked" in error_str:
            return "disconnected", str(e), None
        elif "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), None
        return "disconnected", str(e), None


async def process_single_task(task):
    """Process a single account task - runs in parallel with others.
    IMPORTANT: Disconnects client after each task to free session file for LiveChat runner.
    """
    task_type = task.get("task")
    account = task.get("account", {})
    task_id = task.get("task_id")
    task_data = task.get("task_data", {})
    task_proxy = task.get("proxy")  # Get proxy from task (sent by get-batch-tasks)
    account_id = account.get("id")
    phone = account.get("phone_number", "")
    
    try:
        if task_type == "spambot_check":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [SPAM] Checking {phone}...")
                status, ban_reason, response = await check_spambot(client)
                await report_result("spambot_check", {"task_id": task_id, "account_id": account_id, "status": status, "ban_reason": ban_reason, "response": response})
                print(f"    Result: {status}")
        
        elif task_type == "change_name":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [NAME] Changing for {phone}...")
                success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                await report_result("change_name", {"task_id": task_id, "account_id": account_id, "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
        
        elif task_type == "change_photo":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [PHOTO] Changing for {phone}...")
                photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
                success, error = await change_profile_photo(client, photo_source)
                await report_result("change_photo", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "privacy_settings":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [PRIVACY] Updating for {phone}...")
                success, error = await update_privacy(
                    client, 
                    task_data.get("hidePhone", False), 
                    task_data.get("hideLastSeen", False), 
                    task_data.get("disableCalls", False),
                    task_data.get("hideProfilePhoto", False)
                )
                await report_result("privacy_settings", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "change_password":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [PASS] Changing for {phone}...")
                success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                await report_result("change_password", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "logout_sessions":
            client = await get_or_create_client(account, task_proxy=task_proxy)
            if client:
                print(f"  [LOGOUT] Logging out other sessions for {phone}...")
                success, error = await logout_other_sessions(client)
                await report_result("logout_sessions", {"task_id": task_id, "account_id": account_id, "success": success, "error": error})
        
        elif task_type == "verify_session":
            print(f"  [VERIFY] Checking {phone}...")
            try:
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
                    status, error, user_data = await verify_session(client, account_id)
                    await report_result("verify_session", {"task_id": task_id, "account_id": account_id, "status": status, "error": error, "user_data": user_data})
                    print(f"    Status: {status}" + (f" ({error})" if error else ""))
                else:
                    await report_result("verify_session", {"task_id": task_id, "account_id": account_id, "status": "disconnected", "error": "Could not connect"})
            except Exception as e:
                await report_result("verify_session", {"task_id": task_id, "account_id": account_id, "status": "disconnected", "error": str(e)})
        
        elif task_type == "sync_profile":
            print(f"  [SYNC] Syncing profile for {phone}...")
            try:
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if client:
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
                        
                        await report_result("sync_profile", {
                            "task_id": task_id,
                            "account_id": account_id,
                            "success": True,
                            "first_name": me.first_name,
                            "last_name": me.last_name or "",
                            "username": me.username,
                            "telegram_id": me.id,
                            "avatar_url": avatar_url
                        })
                        print(f"    Synced: {me.first_name} {me.last_name or ''}")
                    else:
                        await report_result("sync_profile", {"task_id": task_id, "account_id": account_id, "success": False, "error": "Could not get user info"})
                else:
                    await report_result("sync_profile", {"task_id": task_id, "account_id": account_id, "success": False, "error": "Could not connect"})
            except Exception as e:
                await report_result("sync_profile", {"task_id": task_id, "account_id": account_id, "success": False, "error": str(e)})
                print(f"    Error: {e}")
    
    except Exception as e:
        # CRITICAL: Report failure to backend so task doesn't stay stuck in "in_progress"
        print(f"  [ERROR] Task {task_type} failed: {e}")
        await report_task_failure(task_type, task_id, account_id, str(e))
    
    finally:
        # ALWAYS save session and disconnect after task to free session file for LiveChat runner
        # save_session=True preserves entity cache for future connections
        if account_id:
            await disconnect_client(account_id, phone, save_session=True)


TASK_TIMEOUT_SECONDS = 120


async def report_task_failure(task_type: str, task_id: str, account_id: str, error_message: str):
    """Report a failure in a shape that the backend understands for each task type."""
    try:
        if task_type == "spambot_check":
            await report_result("spambot_check", {
                "task_id": task_id,
                "account_id": account_id,
                "status": "disconnected",
                "ban_reason": error_message,
                "response": f"Error: {error_message}",
            })
        elif task_type == "verify_session":
            await report_result("verify_session", {
                "task_id": task_id,
                "account_id": account_id,
                "status": "disconnected",
                "error": error_message,
                "user_data": None,
            })
        else:
            await report_result(task_type, {
                "task_id": task_id,
                "account_id": account_id,
                "success": False,
                "error": error_message,
            })
    except Exception as e:
        print(f"  [ERROR] Failed to report task failure: {type(e).__name__}: {repr(e)}")


async def run_task_with_timeout(task: dict):
    """Prevent one hanging Telegram call from stopping polling forever."""
    task_type = task.get("task")
    task_id = task.get("task_id")
    account = task.get("account", {})
    account_id = account.get("id")
    phone = account.get("phone_number")

    try:
        await asyncio.wait_for(process_single_task(task), timeout=TASK_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        msg = f"Timeout after {TASK_TIMEOUT_SECONDS}s"
        print(f"  [TIMEOUT] {task_type} for {phone}: {msg}")
        await report_task_failure(task_type, task_id, account_id, msg)
    except Exception as e:
        # process_single_task already reports most errors; this is a safety net.
        await report_task_failure(task_type, task_id, account_id, str(e))


_http_client = None

async def get_http_client():
    """Reuse a single HTTP client to avoid socket/resource leaks on some systems."""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=120.0)
    return _http_client


async def get_batch_tasks(runner="account", batch_size=20):
    """Get a batch of tasks for parallel processing"""
    try:
        client = await get_http_client()
        resp = await client.post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"runner": runner, "batch_size": batch_size},
            timeout=120.0,
        )

        if resp.status_code != 200:
            print(f"[HTTP ERROR] get_batch_tasks: status={resp.status_code} body={resp.text[:200]}")
            return {"tasks": [], "delay_after": 5}

        return resp.json()
    except Exception as e:
        print(f"[HTTP ERROR] get_batch_tasks: {type(e).__name__}: {repr(e)}")
        return {"tasks": [], "delay_after": 5}


async def send_heartbeat():
    """Send heartbeat to register this runner.
    Note: get-batch-tasks already records a heartbeat, so this is a backup 
    for when we're idle. Use a longer timeout to reduce noise.
    """
    try:
        client = await get_http_client()
        await client.post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={"runner": "account", "batch_size": 0},  # batch_size=0 = heartbeat only
            timeout=15.0,
        )
    except Exception:
        pass  # Heartbeat failure is not critical - suppress to reduce log noise


async def main_loop():
    print("=" * 50)
    print("  Account Runner (PARALLEL MODE)")
    print("  [SpamBot, Name, Photo, Privacy, Sync Profile]")
    print("  Polling every 15 seconds for new tasks...")
    print("=" * 50)
    
    last_heartbeat = 0
    last_proxy_retry = 0
    poll_count = 0
    
    while RUNNING:
        try:
            poll_count += 1
            
            # Send heartbeat every 10 seconds
            now = asyncio.get_event_loop().time()
            if now - last_heartbeat > 10:
                asyncio.create_task(send_heartbeat())
                last_heartbeat = now
            
            # Get batch of tasks from edge function
            print(f"\\n[POLL #{poll_count}] Checking for account tasks...")
            batch = await get_batch_tasks(runner="account", batch_size=20)
            tasks = batch.get("tasks", [])
            delay_after = batch.get("delay_after", 15)  # Default 15s for account runner
            reason = batch.get("reason", "")
            
            if tasks:
                print(f"[BATCH] Found {len(tasks)} tasks! Processing in parallel...")
                
                # Process all tasks in parallel (with timeout safety)
                await asyncio.gather(*[run_task_with_timeout(task) for task in tasks], return_exceptions=True)
                
                print(f"[DONE] Completed {len(tasks)} tasks")
                # Quick re-poll to check for more tasks
                await asyncio.sleep(1)
            else:
                # No tasks - wait and poll again
                print(f"[WAIT] No tasks found. Waiting {delay_after} seconds..." + (f" ({reason})" if reason else ""))
                await asyncio.sleep(delay_after)
        
        except Exception as e:
            print(f"[ERROR] {e}")
            await asyncio.sleep(5)
    
    # Close shared HTTP client (prevents hangs after many polls on some systems)
    global _http_client
    try:
        if _http_client is not None:
            await _http_client.aclose()
            _http_client = None
    except:
        pass

    await shutdown_all()


if __name__ == "__main__":
    print("\\nInstall: pip install telethon httpx aiohttp\\n")
    
    while True:  # FOREVER LOOP WITH CRASH RECOVERY
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Stopping...")
            break
        except Exception as e:
            print(f"\\n⚠ Account Manager crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== 7. WARMUP_RUNNER.PY (BATCH MODE) ==========
  const warmupRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner (PARALLEL BATCH MODE)
===================================================
BUILD: 2026-01-14-proxy-fingerprint-sync

ORDER OF OPERATIONS (CRITICAL):
1. PROXY FIRST - check assigned proxy is valid and active (MANDATORY)
2. FINGERPRINT - generate if missing, save to DB SYNCHRONOUSLY
3. CONNECT - using both proxy and fingerprint
4. PERFORM ACTION - execute warmup task

NO ACCOUNT RUNS WITHOUT PROXY AND FINGERPRINT!

Handles warmup tasks with PARALLEL execution.
Polls server every 7 seconds. RUNS FOREVER with auto-restart.

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import random
import time

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result, shutdown_all, save_session_to_db
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 7  # Poll server every 7 seconds
WARMUP_CHANNELS = ["telegram", "durov", "tginfo", "techcrunch"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😂", "🎉", "💯", "⭐"]


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def add_contact(client, phone, first_name, last_name=""):
    """Add contact using official Telegram API with proper error handling."""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        from telethon.errors import FloodWaitError, PhoneNumberInvalidError
        import random
        
        # Use official client_id range (32-bit signed int)
        contact = InputPhoneContact(
            client_id=random.randint(0, 2**31 - 1),
            phone=phone if phone.startswith("+") else f"+{phone}",
            first_name=first_name,
            last_name=last_name
        )
        result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
        if result.imported:
            return True, phone, None
        if result.users:
            return True, phone, None  # Contact exists
        return True, phone, "Contact exists or invalid"
        
    except FloodWaitError as e:
        return False, phone, f"FloodWait:{e.seconds}s"
    except PhoneNumberInvalidError:
        return False, phone, "Invalid phone number"
    except asyncio.TimeoutError:
        return False, phone, "Request timeout"
    except Exception as e:
        return False, phone, str(e)


async def send_warmup_chat(client, recipient_phone, message, recipient_telegram_id=None, recipient_username=None, recipient_first_name=None):
    """
    Send warmup chat message using official Telegram API.
    Uses get_input_entity for efficiency (cached lookups).
    NO DELAYS - admin controls speed via dashboard.
    """
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        from telethon.errors import (
            FloodWaitError, UserPrivacyRestrictedError, PeerFloodError,
            UserBlockedError, AuthKeyUnregisteredError
        )
        
        user = None
        
        # Strategy 1: Use telegram_id (fastest - direct lookup)
        if recipient_telegram_id:
            try:
                user = await asyncio.wait_for(client.get_input_entity(int(recipient_telegram_id)), timeout=5)
            except (ValueError, KeyError):
                pass
            except Exception:
                pass
        
        # Strategy 2: Use username (cached lookup)
        if not user and recipient_username:
            try:
                username = recipient_username if recipient_username.startswith("@") else f"@{recipient_username}"
                user = await asyncio.wait_for(client.get_input_entity(username), timeout=5)
            except Exception:
                pass
        
        # Strategy 3: Import contact by phone (last resort)
        if not user and recipient_phone:
            phone = recipient_phone if recipient_phone.startswith("+") else f"+{recipient_phone}"
            contact = InputPhoneContact(
                client_id=random.randint(0, 2**31 - 1),  # Official range
                phone=phone,
                first_name=recipient_first_name or "Friend",
                last_name=""
            )
            try:
                result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
                if result.users:
                    user = result.users[0]
            except Exception:
                pass
        
        if not user:
            return False, "Could not find user"
        
        # Send message directly - NO DELAYS (admin controls timing)
        await asyncio.wait_for(client.send_message(user, message), timeout=10)
        
        return True, None
        
    except FloodWaitError as e:
        return False, f"FloodWait:{e.seconds}s"
    except UserPrivacyRestrictedError:
        return False, "Privacy restricted"
    except PeerFloodError:
        return False, "PeerFlood - too many messages"
    except UserBlockedError:
        return False, "User blocked you"
    except AuthKeyUnregisteredError:
        return False, "Session expired"
    except asyncio.TimeoutError:
        return False, "Request timeout"
    except Exception as e:
        return False, str(e)


async def join_channel(client, channel_username=None):
    """Join a channel using official Telegram API with proper error handling."""
    try:
        from telethon.tl.functions.channels import JoinChannelRequest
        from telethon.errors import (
            FloodWaitError, ChannelPrivateError, ChannelInvalidError,
            InviteHashExpiredError, UserAlreadyParticipantError
        )
        
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        
        # Use get_input_entity for efficiency
        try:
            entity = await asyncio.wait_for(client.get_input_entity(channel_username), timeout=10)
        except Exception:
            entity = await asyncio.wait_for(client.get_entity(channel_username), timeout=10)
        
        await asyncio.wait_for(client(JoinChannelRequest(entity)), timeout=10)
        return True, channel_username, None
        
    except UserAlreadyParticipantError:
        return True, channel_username, None  # Already joined = success
    except FloodWaitError as e:
        return False, channel_username, f"FloodWait:{e.seconds}s"
    except ChannelPrivateError:
        return False, channel_username, "Channel is private"
    except Exception as e:
        return False, channel_username, str(e)


async def view_channel_messages(client, channel_username=None):
    try:
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel_username)
        messages = await client.get_messages(entity, limit=10)
        if messages:
            await client.send_read_acknowledge(entity, messages[-1])
        return True, len(messages), None
    except Exception as e:
        return False, 0, str(e)


async def send_reaction(client, channel_username=None):
    """Send reaction to channel message using official Telegram API."""
    try:
        from telethon.tl.functions.messages import SendReactionRequest
        from telethon.tl.types import ReactionEmoji
        from telethon.errors import (
            FloodWaitError, ReactionInvalidError, MessageIdInvalidError,
            ChannelPrivateError
        )
        
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        
        try:
            entity = await asyncio.wait_for(client.get_input_entity(channel_username), timeout=10)
        except Exception:
            entity = await asyncio.wait_for(client.get_entity(channel_username), timeout=10)
        
        messages = await asyncio.wait_for(client.get_messages(entity, limit=5), timeout=10)
        if messages:
            msg = random.choice(messages)
            reaction = random.choice(REACTIONS)
            await asyncio.wait_for(
                client(SendReactionRequest(peer=entity, msg_id=msg.id, reaction=[ReactionEmoji(emoticon=reaction)])),
                timeout=10
            )
            return True, reaction, None
        return False, None, "No messages in channel"
        
    except FloodWaitError as e:
        return False, None, f"FloodWait:{e.seconds}s"
    except ReactionInvalidError:
        return False, None, "Reaction not allowed"
    except MessageIdInvalidError:
        return False, None, "Message not found"
    except ChannelPrivateError:
        return False, None, "Channel is private"
    except asyncio.TimeoutError:
        return False, None, "Request timeout"
    except Exception as e:
        return False, None, str(e)


async def update_profile_bio(client, bio=None):
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        if not bio:
            bios = ["🚀", "✨", "💫", "🌟", "⚡", "🔥", "💪", "🎯"]
            bio = random.choice(bios)
        await client(UpdateProfileRequest(about=bio))
        return True, None
    except Exception as e:
        return False, str(e)


async def exchange_contacts_if_needed(client_a, client_b, account_a: dict, account_b: dict, pair_id: str) -> tuple:
    """
    Exchange contacts between paired accounts if not already done.
    
    Returns: (success: bool, error: str or None)
    """
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest, GetContactsRequest
        from telethon.tl.types import InputPhoneContact
        import random
        
        phone_a = account_a.get("phone_number", "")
        phone_b = account_b.get("phone_number", "")
        name_a = account_a.get("first_name") or "Friend"
        name_b = account_b.get("first_name") or "Friend"
        
        if not phone_a or not phone_b:
            return False, "Missing phone numbers"
        
        # Normalize phone numbers
        phone_a = phone_a if phone_a.startswith("+") else f"+{phone_a}"
        phone_b = phone_b if phone_b.startswith("+") else f"+{phone_b}"
        
        # Check if A already has B as contact
        a_has_b = False
        try:
            contacts_a = await asyncio.wait_for(client_a(GetContactsRequest(hash=0)), timeout=10)
            for user in getattr(contacts_a, 'users', []):
                user_phone = getattr(user, 'phone', '')
                if user_phone:
                    user_phone_norm = user_phone if user_phone.startswith("+") else f"+{user_phone}"
                    if user_phone_norm == phone_b:
                        a_has_b = True
                        break
        except Exception as e:
            print(f"      [CONTACT CHECK] Could not check A's contacts: {str(e)[:30]}")
        
        # Check if B already has A as contact
        b_has_a = False
        try:
            contacts_b = await asyncio.wait_for(client_b(GetContactsRequest(hash=0)), timeout=10)
            for user in getattr(contacts_b, 'users', []):
                user_phone = getattr(user, 'phone', '')
                if user_phone:
                    user_phone_norm = user_phone if user_phone.startswith("+") else f"+{user_phone}"
                    if user_phone_norm == phone_a:
                        b_has_a = True
                        break
        except Exception as e:
            print(f"      [CONTACT CHECK] Could not check B's contacts: {str(e)[:30]}")
        
        # Add B to A's contacts if not already
        if not a_has_b:
            contact_b = InputPhoneContact(
                client_id=random.randint(0, 2**31 - 1),
                phone=phone_b,
                first_name=name_b,
                last_name=""
            )
            try:
                await asyncio.wait_for(client_a(ImportContactsRequest([contact_b])), timeout=10)
                print(f"      [CONTACT] A added B ({phone_b[-4:]}) to contacts")
            except Exception as e:
                print(f"      [CONTACT WARN] A failed to add B: {str(e)[:30]}")
        else:
            print(f"      [CONTACT] A already has B ({phone_b[-4:]}) as contact")
        
        # Add A to B's contacts if not already
        if not b_has_a:
            contact_a = InputPhoneContact(
                client_id=random.randint(0, 2**31 - 1),
                phone=phone_a,
                first_name=name_a,
                last_name=""
            )
            try:
                await asyncio.wait_for(client_b(ImportContactsRequest([contact_a])), timeout=10)
                print(f"      [CONTACT] B added A ({phone_a[-4:]}) to contacts")
            except Exception as e:
                print(f"      [CONTACT WARN] B failed to add A: {str(e)[:30]}")
        else:
            print(f"      [CONTACT] B already has A ({phone_a[-4:]}) as contact")
        
        # Report success to mark contacts_exchanged = true
        await report_result("warmup_contacts_exchanged", {"pair_id": pair_id})
        return True, None
        
    except Exception as e:
        return False, str(e)


# Track pairs that have already exchanged contacts in this session
_contacts_exchanged_pairs = set()


async def process_single_warmup_task(task: dict) -> dict:
    """Process a single warmup task - fully isolated"""
    global _contacts_exchanged_pairs
    
    task_type = task.get("task_type") or task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    proxy = task.get("proxy")
    
    # Check if this pair needs contact exchange
    contacts_exchanged = task.get("contacts_exchanged", False)
    partner_account = task.get("partner_account")  # Partner account data for contact exchange
    partner_proxy = task.get("partner_proxy")
    
    account_id = account.get("id")
    phone = account.get("phone_number", "????")[-4:]
    
    if not account_id:
        return {"success": False, "error": "No account", "task_id": task_id}
    
    try:
        client = await get_or_create_client(account, task_proxy=proxy)
        if not client:
            return {
                "success": False, "error": "Could not connect client",
                "task_id": task_id, "account_id": account_id, "pair_id": pair_id
            }
        
        # ========== CONTACT EXCHANGE (if needed and first task for this pair) ==========
        if pair_id and not contacts_exchanged and pair_id not in _contacts_exchanged_pairs and partner_account:
            partner_phone = partner_account.get("phone_number", "????")[-4:]
            
            # CRITICAL: Validate partner has proxy before attempting connection
            if not partner_proxy or not partner_proxy.get("host"):
                print(f"  ⚠ [CONTACT EXCHANGE] Partner {partner_phone} has NO PROXY - skipping exchange")
            else:
                print(f"  [CONTACT EXCHANGE] Pair {pair_id[:8]}: {phone} <-> {partner_phone}")
                
                # Connect partner account (will fail safely if no proxy/fingerprint)
                partner_client = await get_or_create_client(partner_account, task_proxy=partner_proxy)
                if partner_client:
                    success, error = await exchange_contacts_if_needed(client, partner_client, account, partner_account, pair_id)
                    if success:
                        _contacts_exchanged_pairs.add(pair_id)
                        print(f"    ✓ Contacts exchanged for pair {pair_id[:8]}")
                    else:
                        print(f"    ⚠ Contact exchange failed: {error}")
                else:
                    print(f"    ⚠ Could not connect partner {partner_phone} (check proxy/fingerprint)")
        
        # NO DELAY - Admin controls speed via dashboard
        
        if task_type == "warmup_add_contact":
            target_phone = task_data.get("phone") or task_data.get("recipient_phone")
            first_name = task_data.get("first_name", "Friend")
            print(f"  [CONTACT] [{phone}] Adding contact...")
            success, added_phone, error = await add_contact(client, target_phone, first_name)
            return {"task_id": task_id, "pair_id": pair_id, "account_id": account_id, "success": success, "error": error, "task_subtype": "add_contact"}
        
        elif task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            recipient_telegram_id = task_data.get("recipient_telegram_id")
            recipient_username = task_data.get("recipient_username")
            recipient_first_name = task_data.get("first_name")
            message = task_data.get("message", "Hey! 👋")
            print(f"  [CHAT] [{phone}] Sending warmup message...")
            success, error = await send_warmup_chat(client, recipient_phone, message, recipient_telegram_id, recipient_username, recipient_first_name)
            return {"task_id": task_id, "pair_id": pair_id, "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_join_channel":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [JOIN] [{phone}] Joining channel...")
            success, channel_name, error = await join_channel(client, channel)
            return {"task_id": task_id, "task_type": "join_channel", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_view_content":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [VIEW] [{phone}] Viewing content...")
            success, count, error = await view_channel_messages(client, channel)
            return {"task_id": task_id, "task_type": "view_content", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_send_reaction":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [REACT] [{phone}] Sending reaction...")
            success, reaction, error = await send_reaction(client, channel)
            return {"task_id": task_id, "task_type": "send_reaction", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_profile_update":
            bio = task_data.get("bio")
            print(f"  [BIO] [{phone}] Updating bio...")
            success, error = await update_profile_bio(client, bio)
            return {"task_id": task_id, "task_type": "profile_update", "account_id": account_id, "success": success, "error": error}
        
        else:
            print(f"  [?] [{phone}] Unknown task type: {task_type}")
            return {"success": False, "error": f"Unknown task type: {task_type}", "task_id": task_id}
    
    except Exception as e:
        print(f"  [ERROR] [{phone}] {str(e)[:50]}")
        return {"success": False, "error": str(e), "task_id": task_id, "account_id": account_id, "pair_id": pair_id}
    
    finally:
        # SAVE SESSION CACHE after warmup task - preserves entity cache for future tasks
        if client and account_id:
            try:
                account_phone = account.get("phone_number", account_id)
                await save_session_to_db(account_id, account_phone)
            except Exception:
                pass  # Non-critical - don't fail the task if session save fails


async def main_loop():
    """Main warmup loop - RUNS FOREVER with 7s polling"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Warmup Runner (Server-Controlled)")
    print("=" * 60)
    print(f"  🔥 Polling server every {POLL_INTERVAL} seconds")
    print("  🔧 All settings controlled by admin dashboard")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\\n✓ Starting warmup runner...\\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            batch_result = await get_batch_tasks(runner="warmup_chat", batch_size=100)
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", POLL_INTERVAL)
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    reason = batch_result.get("reason", "")
                    print(f"  [WAIT] {reason or 'No pending warmup tasks, waiting...'}")
                elif consecutive_empty % 8 == 0:  # Every ~56 seconds at 7s interval
                    print("  [WAIT] Still waiting for warmup tasks...")
                await asyncio.sleep(delay_after if delay_after > 0 else POLL_INTERVAL)
                continue
            
            consecutive_empty = 0
            
            # ========== GROUP TASKS BY ACCOUNT ID ==========
            # Each account processes its tasks sequentially (one connection)
            # Different accounts run in parallel
            from collections import defaultdict
            tasks_by_account = defaultdict(list)
            for task in tasks:
                account_id = task.get("account", {}).get("id")
                if account_id:
                    tasks_by_account[account_id].append(task)
            
            print(f"\\n  [BATCH] Processing {len(tasks)} warmup tasks across {len(tasks_by_account)} accounts in PARALLEL...")
            
            async def process_account_tasks(account_id: str, account_tasks: list) -> list:
                """Process all tasks for a single account SEQUENTIALLY"""
                results = []
                phone = account_tasks[0].get("account", {}).get("phone_number", "????")[-4:] if account_tasks else "????"
                try:
                    for task in account_tasks:
                        try:
                            result = await process_single_warmup_task(task)
                            results.append(result)
                        except Exception as e:
                            results.append({"success": False, "error": str(e), "task_id": task.get("task_id")})
                finally:
                    # DISCONNECT + SAVE SESSION after all tasks for this account
                    await disconnect_client(account_id, phone, save_session=True)
                return results
            
            # Run all accounts in parallel, each account processes its tasks sequentially
            all_results = await asyncio.gather(
                *[process_account_tasks(acc_id, acc_tasks) for acc_id, acc_tasks in tasks_by_account.items()],
                return_exceptions=True
            )
            
            # Flatten results and report
            success_count = 0
            for account_results in all_results:
                if isinstance(account_results, Exception):
                    print(f"  ⚠ Account exception: {account_results}")
                    continue
                for result in account_results:
                    if isinstance(result, Exception):
                        print(f"  ⚠ Task exception: {result}")
                        continue
                    if result.get("success"):
                        success_count += 1
                    if result.get("task_subtype") == "add_contact" or result.get("pair_id"):
                        await report_result("warmup_chat", result)
                    else:
                        await report_result("warmup", result)
            
            total_processed = sum(len(r) for r in all_results if not isinstance(r, Exception))
            fail_count = total_processed - success_count
            print(f"  [RESULT] Batch complete: {success_count} success, {fail_count} failed ({len(tasks_by_account)} accounts)")
            
            if RUNNING and delay_after > 0:
                print(f"  [WAIT] Waiting {delay_after}s before next batch...")
                await asyncio.sleep(delay_after)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
    
    print("\\n[STOP] Warmup loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Warmup Runner - RUNS FOREVER")
    print("  Polls server every 7 seconds for tasks")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print("Required: pip install telethon httpx pysocks")
    
    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\\n⏹ Keyboard interrupt - stopping...")
            break
        except Exception as e:
            print(f"\\n⚠ Runner crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)
    
    print("Goodbye!")
`;

  // ========== RUN.BAT (Single file to run ALL runners) ==========
  const runBat = `@echo off
title TelegramCRM - All Runners
color 0A

echo.
echo  ================================================
echo       TelegramCRM - Starting All Runners
echo  ================================================
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx pysocks aiohttp --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks aiohttp --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting 4 runners in parallel...
echo.

:: Start each runner in a new window
start "Campaign Runner" cmd /k "title Campaign Runner && color 0B && py campaign_runner.py"
timeout /t 1 /nobreak >nul

start "LiveChat Listener" cmd /k "title LiveChat Listener && color 0D && py live_chat_listener.py"
timeout /t 1 /nobreak >nul

start "Account Manager" cmd /k "title Account Manager && color 0E && py account_manager.py"
timeout /t 1 /nobreak >nul

start "Warmup Runner" cmd /k "title Warmup Runner && color 0A && py warmup_runner.py"

echo.
echo  ================================================
echo     All 4 runners started!
echo  ================================================
echo.
echo     Blue   = Campaign Runner
echo     Purple = LiveChat Listener  
echo     Yellow = Account Manager
echo     Green  = Warmup Runner
echo.
echo     To STOP: Close all windows or press Ctrl+C
echo  ================================================
echo.
pause
`;

  // ========== REQUIREMENTS.TXT ==========
  const requirementsTxt = `telethon>=1.34.0
httpx>=0.27.0
pysocks>=1.7.1
aiohttp>=3.9.0
`;


  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    // Core files
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("fingerprint_generator.py", fingerprintGeneratorPy);
    folder?.file("requirements.txt", requirementsTxt);
    
    // Individual runners - using correct filenames matching /python folder
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("live_chat_listener.py", livechatRunnerPy);
    folder?.file("account_manager.py", accountRunnerPy);
    folder?.file("warmup_runner.py", warmupRunnerPy);
    
    // Single BAT to run all
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("ZIP downloaded! 9 files included.");
  };


  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python files to run on your PC"
          icon={BookOpen}
        />

        <Card>
          <CardContent className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Download for PC</h2>
              <p className="text-muted-foreground">
                5 separate runners + 1 BAT file to run them all
              </p>
            </div>

            <Button size="lg" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
              <Download className="h-6 w-6" />
              Download ZIP
            </Button>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">📁 Files included (9 total):</p>
              <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                <li><code className="text-green-600 dark:text-green-400">RUN.bat</code> - <strong>Double-click to START all 4 runners</strong></li>
                <li><code className="text-blue-500">campaign_runner.py</code> - Send messages + batch reporting</li>
                <li><code className="text-purple-500">live_chat_listener.py</code> - Incoming messages + replies</li>
                <li><code className="text-yellow-500">account_manager.py</code> - SpamBot, name, photo, privacy</li>
                <li><code className="text-orange-500">warmup_runner.py</code> - Warmup chat (pairs) + join/view/react/bio</li>
                <li><code>config.py</code> - Backend settings</li>
                <li><code>client_manager.py</code> - Shared Telegram logic + batch reporting</li>
                <li><code>fingerprint_generator.py</code> - Device fingerprints</li>
                <li><code>requirements.txt</code> - Dependencies</li>
              </ul>
            </div>

            <div className="text-left bg-green-500/10 border border-green-500/30 rounded-lg p-4 space-y-2">
              <p className="font-medium text-green-700 dark:text-green-400">🛡️ Safety Features (Official Telegram API):</p>
              <ul className="list-disc list-inside text-sm text-green-600 dark:text-green-500 space-y-1">
                <li><strong>get_input_entity()</strong> - Reduces API calls, uses cached lookups</li>
                <li><strong>Official Telethon exceptions</strong> - FloodWait, PeerFlood, UserPrivacyRestricted, etc.</li>
                <li><strong>Proper client_id range</strong> - Uses 32-bit signed int (0 to 2³¹-1) for contacts</li>
                <li><strong>Auto-detection</strong> - Frozen, banned, deactivated, session expired states</li>
                <li><strong>Privacy API</strong> - Uses InputPrivacyKey* with SetPrivacyRequest</li>
                <li><strong>No Python delays</strong> - Speed controlled by admin dashboard</li>
              </ul>
            </div>

            <div className="text-left bg-muted rounded-lg p-4 space-y-3">
              <p className="font-medium">🚀 How to use:</p>
              <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                <li>Extract ZIP folder</li>
                <li>Double-click <code className="bg-green-100 dark:bg-green-900 px-2 py-0.5 rounded">RUN.bat</code></li>
                <li>4 colored windows will open (one for each runner)</li>
                <li>To stop: Close all windows or press <kbd className="bg-background px-2 py-0.5 rounded border">Ctrl+C</kbd></li>
              </ol>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
