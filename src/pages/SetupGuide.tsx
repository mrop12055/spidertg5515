import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Download, Terminal, CheckCircle, Copy, ExternalLink, Play, Settings2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const SetupGuide: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(null), 2000);
  };

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const pythonScript = `#!/usr/bin/env python3
"""
TelegramCRM - Simplified Backend-Driven Runner
===============================================
A thin Python client that executes tasks from the backend.
All logic (message queuing, filtering, scheduling) is handled server-side.

Run: python telegram_sender.py
"""

import asyncio
import os
import base64
import tempfile
import httpx
from datetime import datetime, timezone
from typing import Dict, Optional

# Install: pip install telethon httpx
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError

# ========== CONFIGURATION ==========
BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_KEY = "${supabaseKey}"

# Telegram API credentials
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"

# Temp folder for session files
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")

# ========== GLOBAL STATE ==========
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


async def get_or_create_client(account: dict) -> Optional[TelegramClient]:
    """Get existing client or create new one"""
    account_id = account["id"]
    
    if account_id in active_clients:
        client = active_clients[account_id]
        if client.is_connected():
            return client
    
    session_data = account.get("session_data")
    if not session_data:
        print(f"  ⚠ No session data for {account.get('phone_number', 'unknown')}")
        return None
    
    session_path = decode_session_file(account["phone_number"], session_data)
    if not session_path:
        return None
    
    try:
        client = TelegramClient(session_path, int(TELEGRAM_API_ID), TELEGRAM_API_HASH)
        await client.connect()
        
        if not await client.is_user_authorized():
            print(f"  ⚠ Session expired for {account['phone_number']}")
            await report_result("account_disconnected", {"account_id": account_id, "reason": "Session expired"})
            return None
        
        # Set up incoming message handler
        await setup_message_handler(client, account_id)
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
        
        print(f"  ✓ Connected: {account['phone_number']}")
        return client
    except Exception as e:
        print(f"  ⚠ Failed to connect {account['phone_number']}: {e}")
        return None


async def setup_message_handler(client: TelegramClient, account_id: str):
    """Set up handler for incoming messages"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                content = event.message.text or "[Media message]"
                media_url = None
                media_type = None
                
                # Handle photos
                if event.message.photo:
                    print(f"    📷 Receiving photo...")
                    photo_bytes = await client.download_media(event.message.photo, file=bytes)
                    if photo_bytes:
                        # Upload to backend would go here
                        content = "[Photo] " + (event.message.text or "")
                        media_type = "image"
                
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "content": content,
                    "media_url": media_url,
                    "media_type": media_type
                })
        except Exception as e:
            print(f"    ⚠ Error handling incoming message: {e}")


async def get_next_task() -> dict:
    """Ask backend for next task"""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{BACKEND_URL}/get-next-task",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={}
            )
            return resp.json()
    except Exception as e:
        print(f"  ⚠ Failed to get task: {e}")
        return {"task": "wait", "seconds": 5}


async def report_result(task_type: str, result: dict):
    """Report task result to backend"""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            await client.post(
                f"{BACKEND_URL}/report-task-result",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
                json={"task_type": task_type, "result": result}
            )
    except Exception as e:
        print(f"  ⚠ Failed to report result: {e}")


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
        
        # Send message (text only for now, media support can be added)
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


async def check_spambot(client: TelegramClient):
    """Check SpamBot for account status"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(3)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        
        response_lower = response.lower()
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
        elif "limited" in response_lower or "restricted" in response_lower:
            return "restricted", None, response
        elif "banned" in response_lower:
            return "banned", response[:200], response
        return "active", None, response
    except Exception as e:
        return "active", None, f"Error: {e}"


async def main_loop():
    """Main task execution loop"""
    print("=" * 60)
    print("  TelegramCRM - Backend-Driven Runner")
    print("=" * 60)
    print(f"  • Backend: {BACKEND_URL}")
    print(f"  • Session folder: {SESSION_FOLDER}")
    print("=" * 60)
    print("\\n✓ Starting task loop... (Ctrl+C to stop)\\n")
    
    while True:
        try:
            # Get next task from backend
            task = await get_next_task()
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 2)
                # Keep clients alive during wait
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc)
                await asyncio.sleep(seconds)
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                mode = task.get("mode", "campaign")
                
                client = await get_or_create_client(account)
                if client and recipient:
                    icon = "⚡" if mode == "live" else "📨"
                    print(f"  {icon} Sending to {recipient}...")
                    
                    success, error = await send_message(
                        client, recipient, msg.get("content", ""),
                        msg.get("media_url")
                    )
                    
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    
                    if success:
                        print(f"    ✓ Sent!")
                    else:
                        print(f"    ✗ Failed: {error}")
            
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  📋 Validating {len(recipients)} recipients...")
                    for r in recipients:
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {
                            "recipient_id": r["id"],
                            "exists": exists,
                            "name": name,
                            "telegram_id": telegram_id
                        })
                        await asyncio.sleep(0.5)
            
            elif task_type == "spambot_check":
                task_id = task.get("task_id")
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  🤖 SpamBot check for {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "status": status,
                        "ban_reason": ban_reason,
                        "response": response
                    })
                    print(f"    Result: {status}")
        
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(2)


async def shutdown():
    """Cleanup on shutdown"""
    print("\\nShutting down...")
    for client in active_clients.values():
        await client.disconnect()
    print("Disconnected all clients.")


if __name__ == "__main__":
    print("Starting TelegramCRM Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        asyncio.run(shutdown())
`;
  return (
    <DashboardLayout>
      <PageHeader
        title="Setup Guide"
        description="Complete beginner guide to run the sender script on your PC"
      />

      <div className="space-y-6">
        {/* Quick Overview */}
        <Card className="border-primary/50 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Play className="w-5 h-5 text-primary" />
              Quick Overview - What You'll Do
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-5">
              <div className="text-center p-3">
                <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-2 font-bold">1</div>
                <p className="text-sm">Install Python</p>
              </div>
              <div className="text-center p-3">
                <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-2 font-bold">2</div>
                <p className="text-sm">Create a folder</p>
              </div>
              <div className="text-center p-3">
                <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-2 font-bold">3</div>
                <p className="text-sm">Download script</p>
              </div>
              <div className="text-center p-3">
                <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-2 font-bold">4</div>
                <p className="text-sm">Install libraries</p>
              </div>
              <div className="text-center p-3">
                <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center mx-auto mb-2 font-bold">5</div>
                <p className="text-sm">Run the script</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 1: Install Python */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 1</Badge>
              Install Python (if not installed)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="list-decimal list-inside space-y-3 text-muted-foreground">
              <li>
                Go to <a href="https://www.python.org/downloads/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                  python.org/downloads <ExternalLink className="w-3 h-3" />
                </a>
              </li>
              <li>Click the big yellow <strong>"Download Python 3.x.x"</strong> button</li>
              <li>Run the downloaded installer</li>
              <li className="text-status-warning font-medium">
                ⚠️ IMPORTANT: Check the box <strong>"Add Python to PATH"</strong> at the bottom!
              </li>
              <li>Click "Install Now" and wait for it to finish</li>
            </ol>
            
            <div className="p-4 rounded-lg bg-accent/50 border">
              <h4 className="font-medium mb-2">✅ Verify Installation</h4>
              <p className="text-sm text-muted-foreground mb-2">Open CMD (Command Prompt) and type:</p>
              <div className="relative">
                <pre className="bg-background p-3 rounded-lg border text-sm">python --version</pre>
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute top-1 right-1"
                  onClick={() => copyToClipboard('python --version', 'pyver')}
                >
                  {copied === 'pyver' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">You should see something like: <code>Python 3.12.0</code></p>
            </div>
          </CardContent>
        </Card>

        {/* Step 2: Create Folder */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 2</Badge>
              Create a Folder on Your PC
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="list-decimal list-inside space-y-3 text-muted-foreground">
              <li>Open <strong>File Explorer</strong> (Windows) or <strong>Finder</strong> (Mac)</li>
              <li>Go to your <strong>Desktop</strong> or <strong>Documents</strong> folder</li>
              <li>Right-click → <strong>New</strong> → <strong>Folder</strong></li>
              <li>Name it something like: <code className="bg-accent px-2 py-1 rounded">telegram-sender</code></li>
            </ol>
            
            <div className="p-4 rounded-lg bg-primary/10 border border-primary/30">
              <p className="text-sm">
                📁 Your folder will look like: <code className="bg-background px-2 py-1 rounded">C:\Users\YourName\Desktop\telegram-sender</code>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Step 3: Download Script */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 3</Badge>
              Download the Script
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Click the button below to download the script, then <strong>save it to your folder</strong> you created in Step 2:
            </p>
            <Button 
              onClick={() => {
                const blob = new Blob([pythonScript], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'telegram_sender.py';
                a.click();
                URL.revokeObjectURL(url);
                toast.success('Script downloaded! Save it to your telegram-sender folder');
              }}
              size="lg"
              className="gap-2"
            >
              <Download className="w-5 h-5" />
              Download telegram_sender.py
            </Button>
            
            <div className="p-4 rounded-lg bg-accent/50 border">
              <p className="text-sm text-muted-foreground">
                📁 After saving, your folder should have: <code className="bg-background px-2 py-1 rounded">telegram_sender.py</code>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Step 4: Open CMD in Folder */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 4</Badge>
              Open CMD in Your Folder
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-accent/50 border">
                <h4 className="font-medium mb-2">🪟 Windows - Easy Method:</h4>
                <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                  <li>Open your <strong>telegram-sender</strong> folder in File Explorer</li>
                  <li>Click on the address bar at the top (where it shows the folder path)</li>
                  <li>Type <code className="bg-background px-2 py-1 rounded">cmd</code> and press <strong>Enter</strong></li>
                  <li>A black Command Prompt window will open in that folder!</li>
                </ol>
              </div>
              
              <div className="p-4 rounded-lg bg-accent/50 border">
                <h4 className="font-medium mb-2">🍎 Mac - Easy Method:</h4>
                <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                  <li>Open your <strong>telegram-sender</strong> folder in Finder</li>
                  <li>Right-click the folder → <strong>Services</strong> → <strong>New Terminal at Folder</strong></li>
                </ol>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 5: Install Libraries */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 5</Badge>
              Install Required Libraries
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              In the CMD/Terminal window, copy and paste this command and press <strong>Enter</strong>:
            </p>
            <div className="relative">
              <pre className="bg-background p-4 rounded-lg border overflow-x-auto text-sm font-mono">pip install telethon supabase</pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2"
                onClick={() => copyToClipboard('pip install telethon supabase', 'pip')}
              >
                {copied === 'pip' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Wait for it to finish (you'll see "Successfully installed..." messages)
            </p>
          </CardContent>
        </Card>

        {/* Step 6: Get Telegram API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 6</Badge>
              Get Telegram API Credentials
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="list-decimal list-inside space-y-3 text-muted-foreground">
              <li>Go to <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">my.telegram.org <ExternalLink className="w-3 h-3" /></a></li>
              <li>Log in with your phone number (any Telegram account)</li>
              <li>Click <strong>"API development tools"</strong></li>
              <li>Fill in any app name (e.g., "MySender") and short name</li>
              <li>You'll get your <strong>api_id</strong> (numbers) and <strong>api_hash</strong> (letters+numbers)</li>
            </ol>
            
            <div className="p-4 rounded-lg bg-status-warning/10 border border-status-warning/30">
              <div className="flex gap-2">
                <AlertTriangle className="w-5 h-5 text-status-warning flex-shrink-0" />
                <div>
                  <h4 className="font-medium text-status-warning">Keep These Safe!</h4>
                  <p className="text-sm text-muted-foreground mt-1">
                    Save your api_id and api_hash somewhere - you'll need them in the next step.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 7: Set Environment Variables */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 7</Badge>
              Set Your API Credentials
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              In the same CMD window, run these commands (replace with YOUR values):
            </p>
            
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-accent/50 border">
                <h4 className="font-medium mb-2">🪟 Windows (CMD):</h4>
                <div className="relative">
                  <pre className="bg-background p-3 rounded-lg border text-sm font-mono overflow-x-auto">
{`set TELEGRAM_API_ID=12345678
set TELEGRAM_API_HASH=your_api_hash_here`}
                  </pre>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="absolute top-1 right-1"
                    onClick={() => copyToClipboard('set TELEGRAM_API_ID=12345678\nset TELEGRAM_API_HASH=your_api_hash_here', 'envwin')}
                  >
                    {copied === 'envwin' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              
              <div className="p-4 rounded-lg bg-accent/50 border">
                <h4 className="font-medium mb-2">🍎 Mac/Linux (Terminal):</h4>
                <div className="relative">
                  <pre className="bg-background p-3 rounded-lg border text-sm font-mono overflow-x-auto">
{`export TELEGRAM_API_ID=12345678
export TELEGRAM_API_HASH=your_api_hash_here`}
                  </pre>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="absolute top-1 right-1"
                    onClick={() => copyToClipboard('export TELEGRAM_API_ID=12345678\nexport TELEGRAM_API_HASH=your_api_hash_here', 'envmac')}
                  >
                    {copied === 'envmac' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 8: Run the Script */}
        <Card className="border-green-500/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-green-600 text-white">Step 8</Badge>
              Run the Script! 🚀
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Now run this command in the same CMD window:
            </p>
            <div className="relative">
              <pre className="bg-background p-4 rounded-lg border overflow-x-auto text-lg font-mono font-bold">python telegram_sender.py</pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2"
                onClick={() => copyToClipboard('python telegram_sender.py', 'run')}
              >
                {copied === 'run' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            
            <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                You Should See:
              </h4>
              <pre className="text-xs text-muted-foreground font-mono">
{`==================================================
TelegramCRM Bulk Message Sender
==================================================

[14:30:00] Checking for pending messages...
  No pending messages. Waiting 30 seconds...`}
              </pre>
            </div>
            
            <p className="text-sm text-muted-foreground">
              ✅ The script is now running! It will check for messages every 30 seconds. <br/>
              ❌ To stop it, press <kbd className="bg-accent px-2 py-1 rounded">Ctrl</kbd> + <kbd className="bg-accent px-2 py-1 rounded">C</kbd>
            </p>
          </CardContent>
        </Card>

        {/* Troubleshooting */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-status-warning" />
              Common Issues
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-accent/50 border">
                <p className="font-medium text-sm">"python" is not recognized</p>
                <p className="text-xs text-muted-foreground mt-1">→ You didn't check "Add Python to PATH" during install. Reinstall Python and check that box!</p>
              </div>
              <div className="p-3 rounded-lg bg-accent/50 border">
                <p className="font-medium text-sm">ModuleNotFoundError: No module named 'telethon'</p>
                <p className="text-xs text-muted-foreground mt-1">→ Run: <code>pip install telethon supabase</code> again</p>
              </div>
              <div className="p-3 rounded-lg bg-accent/50 border">
                <p className="font-medium text-sm">Processing account: + (or phone number looks wrong)</p>
                <p className="text-xs text-muted-foreground mt-1">
                  → Your <code>.session</code> file name must contain the phone number (digits) like <code>+15551234567.session</code> or <code>15551234567.session</code>. Rename the file and upload again, then delete the broken account.
                </p>
              </div>
              <div className="p-3 rounded-lg bg-accent/50 border">
                <p className="font-medium text-sm">"Please set TELEGRAM_API_ID and TELEGRAM_API_HASH"</p>
                <p className="text-xs text-muted-foreground mt-1">
                  → You must run Step 7 in the <strong>same CMD/Terminal window</strong> where you run <code>python telegram_sender.py</code>. If you close the window, you must set them again.
                </p>
              </div>
              <div className="p-3 rounded-lg bg-accent/50 border">
                <p className="font-medium text-sm">Script says "No session data for..."</p>
                <p className="text-xs text-muted-foreground mt-1">→ Upload your .session files on the Accounts page first</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Upload Session Files Reminder */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-primary" />
              Don't Forget: Upload Session Files
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Before running the script, make sure you have uploaded your <code className="bg-accent px-1 rounded">.session</code> files on the Accounts page:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
              <li>Go to <strong>Accounts</strong> page</li>
              <li>Click <strong>"Add Accounts"</strong></li>
              <li>Drag and drop your .session files</li>
              <li>Click <strong>"Upload"</strong></li>
            </ol>
          </CardContent>
        </Card>

        {/* Complete Workflow */}
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Play className="w-5 h-5 text-primary" />
              How It Works
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              <li className="flex gap-3">
                <Badge variant="outline">1</Badge>
                <span className="text-muted-foreground">Upload accounts with session data on the <strong>Accounts</strong> page</span>
              </li>
              <li className="flex gap-3">
                <Badge variant="outline">2</Badge>
                <span className="text-muted-foreground">Create a campaign on the <strong>Campaigns</strong> page</span>
              </li>
              <li className="flex gap-3">
                <Badge variant="outline">3</Badge>
                <span className="text-muted-foreground">Upload recipients and click <strong>Start</strong> to queue messages</span>
              </li>
              <li className="flex gap-3">
                <Badge variant="outline">4</Badge>
                <span className="text-muted-foreground">Run the Python script on your PC to send the messages</span>
              </li>
              <li className="flex gap-3">
                <Badge variant="outline">5</Badge>
                <span className="text-muted-foreground">Monitor progress on the <strong>Dashboard</strong></span>
              </li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
