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

  // ========== ULTRA-SIMPLIFIED RUNNER ==========
  // Campaign = send message, Conversation = send message, Warmup = send message
  // They're ALL the same: send_message(account, recipient, content)
  const unifiedRunnerPy = `#!/usr/bin/env python3
"""
TelegramCRM - ULTRA-SIMPLIFIED RUNNER
=====================================
BUILD: 2026-01-29-ultra-v1

TRUTH: Campaign, Conversations, Warmup are ALL the same thing.
       They all just SEND MESSAGES from an account to a recipient.

ONLY 2 CORE FUNCTIONS:
  1. send_message(client, recipient, content) - ALL sending operations
  2. account_action(client, action, params) - Non-message actions

Install: pip install telethon httpx pysocks
Usage: python unified_runner.py
"""

import os
import sys
import base64
import tempfile
import asyncio
import httpx
import socks
import threading
import random
import time
import signal
from typing import Dict, Optional, List, Any, Tuple
from collections import defaultdict

# ========== CONFIG ==========
BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
BUILD_VERSION = "2026-01-29-ultra-v1"

# ========== STATE ==========
SESSION_FOLDER = tempfile.mkdtemp(prefix="tg_")
clients: Dict[str, Any] = {}      # account_id -> TelegramClient
accounts: Dict[str, dict] = {}    # account_id -> account info
RUNNING = True

_locks: Dict[str, asyncio.Lock] = {}
_locks_mutex = threading.Lock()
_http: Optional[httpx.AsyncClient] = None


def signal_handler(sig, frame):
    global RUNNING
    print("\\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== TELETHON ==========
try:
    from telethon import TelegramClient, events
    from telethon.errors import (
        FloodWaitError, UserPrivacyRestrictedError, PeerFloodError,
        UserBlockedError, ChatWriteForbiddenError, AuthKeyUnregisteredError,
        SessionRevokedError, UserDeactivatedBanError, PhoneNumberBannedError
    )
    from telethon.tl.functions.contacts import ResolvePhoneRequest, ImportContactsRequest
    from telethon.tl.functions.messages import SendMessageRequest, SendReactionRequest
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.tl.functions.account import UpdateProfileRequest
    from telethon.tl.types import InputPhoneContact, InputPeerUser, ReactionEmoji, User
except ImportError:
    print("ERROR: pip install telethon httpx pysocks")
    sys.exit(1)


# ==============================================================================
# HELPERS
# ==============================================================================

def get_lock(aid: str) -> asyncio.Lock:
    with _locks_mutex:
        if aid not in _locks:
            _locks[aid] = asyncio.Lock()
        return _locks[aid]


def get_http() -> httpx.AsyncClient:
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(timeout=45, limits=httpx.Limits(max_connections=500))
    return _http


def decode_session(phone: str, b64: str) -> Optional[str]:
    path = os.path.join(SESSION_FOLDER, phone.replace("+", ""))
    try:
        with open(path + ".session", "wb") as f:
            f.write(base64.b64decode(b64))
        return path
    except:
        return None


def get_proxy(acc: dict) -> Optional[tuple]:
    p = acc.get("proxies") or acc.get("proxy")
    if not p or not p.get("host"):
        return None
    ptype = socks.SOCKS5 if (p.get("proxy_type") or "socks5").lower() == "socks5" else socks.HTTP
    if p.get("username"):
        return (ptype, p["host"], int(p["port"]), True, p["username"], p["password"])
    return (ptype, p["host"], int(p["port"]))


def variate(text: str) -> str:
    """Add invisible char to make message unique."""
    pos = random.randint(0, len(text))
    return text[:pos] + random.choice(['\\u200b', '\\u200c', '\\u200d']) + text[pos:]


# ==============================================================================
# API
# ==============================================================================

async def report(task_type: str, data: dict):
    try:
        await get_http().post(
            f"{BACKEND_URL}/report-task-result",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"task_type": task_type, **data}, timeout=30
        )
    except:
        pass


async def fetch_accounts() -> List[dict]:
    try:
        r = await get_http().get(
            f"{SUPABASE_URL}/rest/v1/telegram_accounts?status=eq.active&session_data=not.is.null&select=*,proxies(*)",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}, timeout=60
        )
        return r.json() if r.status_code == 200 else []
    except:
        return []


async def get_tasks(batch_size: int = 100) -> dict:
    try:
        r = await get_http().post(
            f"{BACKEND_URL}/get-batch-tasks",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"runner": "unified", "batch_size": batch_size}, timeout=60
        )
        return r.json() if r.status_code == 200 else {"tasks": []}
    except:
        return {"tasks": []}


# ==============================================================================
# CORE FUNCTION 1: SEND MESSAGE
# ==============================================================================
# Campaign sends message. Conversation sends message. Warmup sends message.
# They're ALL the same. One function handles everything.

async def send_message(client, recipient: str, content: str, media_url: str = None) -> Tuple[bool, Optional[str], dict]:
    """
    THE ONLY SEND FUNCTION.
    Campaign? This function. Conversation reply? This function. Warmup? This function.
    """
    if not recipient:
        return False, "No recipient", {}
    
    try:
        entity = None
        
        # Try to get entity
        try:
            entity = await asyncio.wait_for(client.get_input_entity(recipient), timeout=5)
        except:
            pass
        
        # Phone resolution
        if not entity and (recipient.startswith("+") or recipient.isdigit()):
            phone = recipient if recipient.startswith("+") else f"+{recipient}"
            try:
                result = await asyncio.wait_for(client(ResolvePhoneRequest(phone=phone)), timeout=10)
                if result.users:
                    u = result.users[0]
                    entity = InputPeerUser(user_id=u.id, access_hash=u.access_hash)
            except Exception as e:
                if "PHONE_NOT_OCCUPIED" in str(e):
                    return False, "Not on Telegram", {}
                # Import contact
                contact = InputPhoneContact(client_id=random.randint(0,2**31-1), phone=phone, first_name=phone.replace("+",""), last_name="")
                try:
                    result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
                    if result.users:
                        u = result.users[0]
                        entity = InputPeerUser(user_id=u.id, access_hash=u.access_hash)
                except:
                    pass
        
        if not entity:
            return False, "Recipient not found", {}
        
        text = variate(content) if content else ""
        
        # Send with media
        if media_url and text:
            try:
                r = await get_http().get(media_url, timeout=60)
                if r.status_code == 200:
                    import io
                    f = io.BytesIO(r.content)
                    f.name = "file.jpg"
                    await asyncio.wait_for(client.send_file(entity, f, caption=text), timeout=30)
                    return True, None, {"recipient_telegram_id": entity.user_id if isinstance(entity, InputPeerUser) else None}
            except:
                pass
        
        # Text only
        if isinstance(entity, InputPeerUser):
            await asyncio.wait_for(client(SendMessageRequest(peer=entity, message=text, no_webpage=False, random_id=random.randint(0,2**63-1))), timeout=10)
        else:
            await asyncio.wait_for(client.send_message(entity, text), timeout=10)
        
        return True, None, {"recipient_telegram_id": entity.user_id if isinstance(entity, InputPeerUser) else None}
        
    except FloodWaitError as e:
        return False, f"FloodWait:{e.seconds}s", {"skip_account": True}
    except PeerFloodError:
        return False, "PeerFlood", {"skip_account": True}
    except UserPrivacyRestrictedError:
        return False, "Privacy restricted", {}
    except UserBlockedError:
        return False, "Blocked", {}
    except Exception as e:
        return False, str(e)[:80], {}


# ==============================================================================
# CORE FUNCTION 2: ACCOUNT ACTION
# ==============================================================================
# Non-message operations: spambot check, name change, join channel, etc.

async def account_action(client, action: str, task: dict) -> Tuple[bool, Optional[str]]:
    """Handle non-message account actions."""
    task_id = task.get("task_id") or task.get("id")
    acc_id = task.get("account", {}).get("id") or task.get("account_id")
    td = task.get("task_data", {})
    
    try:
        if action == "spambot_check":
            bot = await client.get_entity("@SpamBot")
            await client.send_message(bot, "/start")
            await asyncio.sleep(2)
            msgs = await client.get_messages(bot, limit=1)
            resp = msgs[0].text.lower() if msgs else ""
            status = "banned" if "banned" in resp or "deleted" in resp else "frozen" if "frozen" in resp else "restricted" if "restricted" in resp else "active"
            await report("spambot_check", {"task_id": task_id, "account_id": acc_id, "status": status, "success": True})
            return True, None
        
        elif action == "change_name":
            fn = task.get("first_name") or td.get("first_name", "")
            ln = task.get("last_name") or td.get("last_name", "")
            await client(UpdateProfileRequest(first_name=fn, last_name=ln))
            await report("change_name", {"task_id": task_id, "account_id": acc_id, "success": True})
            return True, None
        
        elif "add_contact" in action:
            phone = td.get("recipient_phone") or td.get("target_phone")
            if phone:
                contact = InputPhoneContact(client_id=random.randint(0,2**31-1), phone=phone if phone.startswith("+") else f"+{phone}", first_name=td.get("first_name", phone), last_name="")
                result = await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=10)
                await report("warmup_add_contact", {"task_id": task_id, "pair_id": td.get("pair_id"), "success": bool(result.users)})
                return bool(result.users), None
            return False, "No phone"
        
        elif "join" in action:
            channel = td.get("channel_username") or td.get("channel")
            if channel:
                await asyncio.wait_for(client(JoinChannelRequest(channel)), timeout=15)
                await report("warmup", {"task_id": task_id, "success": True})
                return True, None
            return False, "No channel"
        
        elif "react" in action:
            channel = td.get("channel_username")
            if channel:
                entity = await client.get_entity(channel)
                msgs = await client.get_messages(entity, limit=10)
                if msgs:
                    await client(SendReactionRequest(peer=entity, msg_id=random.choice(msgs).id, reaction=[ReactionEmoji(emoticon=random.choice(["👍","❤️","🔥"]))]))
                await report("warmup", {"task_id": task_id, "success": True})
                return True, None
            return False, "No channel"
        
        else:
            return False, f"Unknown action: {action}"
            
    except Exception as e:
        await report(action, {"task_id": task_id, "account_id": acc_id, "success": False, "error": str(e)[:80]})
        return False, str(e)


# ==============================================================================
# INCOMING MESSAGE HANDLER
# ==============================================================================

async def on_message(event, acc_id: str):
    """Handle incoming messages - registered on all clients."""
    try:
        sender = await event.get_sender()
        if not sender or not isinstance(sender, User) or getattr(sender, 'bot', False):
            return
        if not getattr(sender, 'contact', False):
            return
        
        phone = None
        if hasattr(sender, 'phone') and sender.phone:
            phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
        
        name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
        content = event.message.text or "[Media]"
        
        acc = accounts.get(acc_id, {})
        print(f"  📩 [{acc.get('phone_number','?')[-4:]}] ← {name[:12]}: {content[:25]}...")
        
        await report("incoming_message", {
            "account_id": acc_id,
            "sender_id": sender.id,
            "sender_name": name,
            "sender_username": getattr(sender, 'username', None),
            "sender_phone": phone,
            "content": content,
            "telegram_message_id": event.message.id
        })
    except:
        pass


# ==============================================================================
# CLIENT MANAGEMENT
# ==============================================================================

async def connect(acc: dict) -> Tuple[Optional[Any], Optional[str]]:
    """Connect a single account."""
    aid = acc.get("id")
    phone = acc.get("phone_number", "????")
    
    if not aid:
        return None, "No ID"
    
    async with get_lock(aid):
        if aid in clients and clients[aid].is_connected():
            return clients[aid], None
        
        if not acc.get("session_data"):
            return None, "No session"
        if not get_proxy(acc):
            return None, "No proxy"
        if not acc.get("device_model") or not acc.get("api_id"):
            return None, "No fingerprint/API"
        
        path = decode_session(phone, acc["session_data"])
        if not path:
            return None, "Session decode failed"
        
        try:
            client = TelegramClient(
                path, int(acc["api_id"]), acc["api_hash"],
                device_model=acc["device_model"],
                system_version=acc.get("system_version", "Android 12"),
                app_version=acc.get("app_version", "10.14.2"),
                proxy=get_proxy(acc),
                timeout=60, connection_retries=0, auto_reconnect=False
            )
            
            await asyncio.wait_for(client.connect(), timeout=60)
            
            if not await asyncio.wait_for(client.is_user_authorized(), timeout=10):
                return None, "Not authorized"
            
            clients[aid] = client
            accounts[aid] = acc
            print(f"  ✓ [{phone[-4:]}] Connected")
            return client, None
            
        except Exception as e:
            print(f"  ✗ [{phone[-4:]}] {str(e)[:30]}")
            return None, str(e)


async def connect_all():
    """Connect ALL accounts in parallel."""
    print("\\n" + "="*50)
    print("  CONNECTING ALL ACCOUNTS")
    print("="*50)
    
    accs = await fetch_accounts()
    if not accs:
        print("  No accounts found")
        return 0
    
    print(f"  Found {len(accs)} accounts...\\n")
    results = await asyncio.gather(*[connect(a) for a in accs], return_exceptions=True)
    ok = sum(1 for r in results if isinstance(r, tuple) and r[0])
    print(f"\\n  Connected: {ok}/{len(accs)}")
    return ok


async def setup_handlers():
    """Set up incoming message handlers."""
    for aid, client in clients.items():
        if getattr(client, "_h", False):
            continue
        
        @client.on(events.NewMessage(incoming=True))
        async def handler(event, a=aid):
            await on_message(event, a)
        
        setattr(client, "_h", True)


# ==============================================================================
# UNIFIED TASK PROCESSOR
# ==============================================================================

async def process(task: dict):
    """
    ULTRA-SIMPLE TASK PROCESSOR
    
    If task needs to send a message → send_message()
    If task is an account action → account_action()
    
    That's it. Campaign, Conversation, Warmup - all the same.
    """
    tt = task.get("task_type") or task.get("type") or ""
    acc = task.get("account", {})
    aid = acc.get("id") or task.get("account_id") or task.get("task_data", {}).get("sender_account_id")
    
    if not aid:
        return
    
    # Get client
    client = clients.get(aid)
    if not client:
        client, err = await connect(acc) if acc.get("id") else (None, "No account data")
        if not client:
            return
    
    phone = accounts.get(aid, {}).get("phone_number", "????")[-4:]
    
    # ========== MESSAGE SENDING ==========
    # Campaign, Conversation, Warmup - they ALL just send messages
    if tt in ("send", "campaign_send", "livechat_reply", "warmup_chat") or ("send" in tt and "warmup" in tt):
        # Extract data - works for ANY task type
        msg = task.get("message", {})
        td = task.get("task_data", {})
        
        recipient = (
            task.get("recipient") or 
            td.get("recipient_phone") or 
            td.get("recipient_telegram_id") or 
            msg.get("recipient") or 
            msg.get("recipient_phone")
        )
        content = msg.get("content") or td.get("message") or td.get("message_content") or task.get("content") or ""
        media = msg.get("media_url") or task.get("media_url")
        
        # SEND THE MESSAGE - same function for everything
        success, error, meta = await send_message(client, str(recipient) if recipient else "", content, media)
        
        if success:
            print(f"  ✓ [{phone}] → {str(recipient)[:15]}")
        else:
            print(f"  ✗ [{phone}] → {str(recipient)[:15]}: {error}")
        
        # Report based on task type
        if "warmup" in tt:
            await report("warmup_chat", {
                "task_id": task.get("task_id"),
                "pair_id": td.get("pair_id"),
                "warmup_message_id": td.get("warmup_message_id"),
                "success": success,
                "error": error
            })
        else:
            await report("send", {
                "message_id": msg.get("id"),
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "campaign_id": task.get("campaign_id"),
                "campaign_seat_id": task.get("campaign_seat_id"),
                "account_id": aid,
                "api_credential_id": acc.get("api_credential_id"),
                "recipient_phone": recipient,
                "content": content,
                "success": success,
                "error": error,
                **meta
            })
    
    # ========== ACCOUNT ACTIONS ==========
    elif tt in ("spambot_check", "change_name", "change_photo"):
        await account_action(client, tt, task)
    
    elif "add_contact" in tt:
        await account_action(client, "add_contact", task)
    
    elif "join" in tt:
        await account_action(client, "join", task)
    
    elif "react" in tt:
        await account_action(client, "react", task)
    
    elif tt.startswith("warmup") and "chat" not in tt and "send" not in tt:
        await account_action(client, tt, task)
    
    else:
        print(f"  [?] Unknown: {tt}")


# ==============================================================================
# MAIN LOOP
# ==============================================================================

async def main():
    global RUNNING
    
    print("="*50)
    print("  TelegramCRM - ULTRA-SIMPLIFIED RUNNER")
    print(f"  BUILD: {BUILD_VERSION}")
    print("="*50)
    print("  TRUTH: Campaign = Conversation = Warmup")
    print("         They ALL just send messages!")
    print("="*50)
    print("  2 CORE FUNCTIONS:")
    print("    • send_message() - ALL sending")
    print("    • account_action() - Non-message ops")
    print("="*50 + "\\n")
    
    # Connect all accounts
    await connect_all()
    await setup_handlers()
    
    print("\\n" + "="*50)
    print("  PROCESSING TASKS")
    print("="*50 + "\\n")
    
    empty = 0
    last_refresh = time.time()
    
    while RUNNING:
        try:
            # Refresh accounts every 60s
            if time.time() - last_refresh > 60:
                old = len(clients)
                await connect_all()
                if len(clients) > old:
                    await setup_handlers()
                last_refresh = time.time()
            
            # Get tasks
            batch = await get_tasks(100)
            tasks = batch.get("tasks", [])
            
            if not tasks:
                empty += 1
                if empty == 1 or empty % 12 == 0:
                    print(f"  [WAIT] No tasks ({len(clients)} clients)")
                await asyncio.sleep(batch.get("delay_after", 5))
                continue
            
            empty = 0
            
            # Log
            by_type = defaultdict(int)
            for t in tasks:
                by_type[t.get("task_type") or "?"] += 1
            print(f"\\n  [BATCH] {len(tasks)} tasks: {dict(by_type)}")
            
            # Process ALL in parallel
            await asyncio.gather(*[process(t) for t in tasks], return_exceptions=True)
            print("  [DONE]")
            
            await asyncio.sleep(batch.get("delay_after", 2))
            
        except Exception as e:
            print(f"  [ERROR] {str(e)[:40]}")
            await asyncio.sleep(5)
    
    # Shutdown
    print("\\n  [SHUTDOWN]...")
    for c in clients.values():
        try:
            await asyncio.wait_for(c.disconnect(), timeout=5)
        except:
            pass
    print("  Done!")


if __name__ == "__main__":
    print("\\n" + "="*50)
    print("  pip install telethon httpx pysocks")
    print("="*50 + "\\n")
    
    while True:
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            print("\\n⏹ Stopped")
            break
        except Exception as e:
            print(f"\\n⚠ Crashed: {e}\\n  Restarting...")
            time.sleep(5)
`;

  // ========== RUN.BAT ==========
  const runBat = `@echo off
title TelegramCRM - Ultra-Simplified Runner
color 0A

echo.
echo  ================================================
echo    TelegramCRM - ULTRA-SIMPLIFIED RUNNER
echo  ================================================
echo.
echo  TRUTH: Campaign = Conversation = Warmup
echo         They ALL just send messages!
echo.
echo  2 Core Functions:
echo    * send_message()    - ALL sending
echo    * account_action()  - Non-message ops
echo.

cd /d "%~dp0"

echo  Installing requirements...
py -m pip install telethon httpx pysocks --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks --quiet 2>nul
)
echo  Done!
echo.

py unified_runner.py
if errorlevel 1 (
    python unified_runner.py
)

pause
`;

  // ========== REQUIREMENTS.TXT ==========
  const requirementsTxt = `telethon>=1.34.0
httpx>=0.27.0
pysocks>=1.7.1
`;

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    folder?.file("unified_runner.py", unifiedRunnerPy);
    folder?.file("requirements.txt", requirementsTxt);
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm_ultra.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("Ultra-simplified runner downloaded!");
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python runner"
          icon={BookOpen}
        />

        <Card>
          <CardContent className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">Ultra-Simplified Runner</h2>
              <p className="text-muted-foreground text-sm">
                Campaign = Conversation = Warmup — they ALL just send messages
              </p>
            </div>
            
            <div className="bg-muted/50 rounded-lg p-4 text-left text-sm space-y-3">
              <p className="font-semibold text-primary">THE TRUTH:</p>
              <p className="text-muted-foreground">
                No matter where you send from — Campaign, Conversation chat, or Warmup — 
                it's the <span className="text-primary font-medium">same operation</span>: 
                send a message from an account to a recipient.
              </p>
              <div className="border-t border-border pt-3 mt-3 space-y-2">
                <p className="font-medium">2 Core Functions:</p>
                <ul className="space-y-1 ml-2">
                  <li className="flex items-center gap-2">
                    <code className="text-primary text-xs bg-primary/10 px-2 py-0.5 rounded">send_message()</code>
                    <span className="text-muted-foreground text-xs">— ALL sending operations</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <code className="text-primary text-xs bg-primary/10 px-2 py-0.5 rounded">account_action()</code>
                    <span className="text-muted-foreground text-xs">— Spambot, name change, etc.</span>
                  </li>
                </ul>
              </div>
            </div>

            <Button onClick={downloadZip} size="lg" className="gap-2">
              <Download className="w-5 h-5" />
              Download Runner
            </Button>
            
            <p className="text-xs text-muted-foreground">
              Handles 2000+ accounts • Parallel task processing • ~400 lines
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">How It Works</h3>
            
            <div className="space-y-3 text-sm">
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">1</div>
                <div>
                  <p className="font-medium">Connect All Accounts</p>
                  <p className="text-muted-foreground">Parallel connection with proxy + fingerprint validation</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">2</div>
                <div>
                  <p className="font-medium">Setup Incoming Handlers</p>
                  <p className="text-muted-foreground">Event handlers capture incoming messages automatically</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">3</div>
                <div>
                  <p className="font-medium">Process Tasks</p>
                  <p className="text-muted-foreground">All tasks route to <code className="text-xs bg-muted px-1 rounded">send_message()</code> or <code className="text-xs bg-muted px-1 rounded">account_action()</code></p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">Task → Function Mapping</h3>
            
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-muted/30 p-3 rounded">
                <p className="font-medium text-primary mb-2">send_message()</p>
                <ul className="text-muted-foreground text-xs space-y-1">
                  <li>• Campaign send</li>
                  <li>• Conversation reply</li>
                  <li>• Warmup chat</li>
                </ul>
              </div>
              <div className="bg-muted/30 p-3 rounded">
                <p className="font-medium text-primary mb-2">account_action()</p>
                <ul className="text-muted-foreground text-xs space-y-1">
                  <li>• Spambot check</li>
                  <li>• Name change</li>
                  <li>• Join channel</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
