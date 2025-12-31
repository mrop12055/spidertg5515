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
TelegramCRM Bulk Message Sender
Run this script on your PC to send queued messages via Telegram.
Session files are downloaded from the database (base64 encoded).
"""

import asyncio
import os
import base64
import tempfile
from datetime import datetime

# Install: pip install telethon supabase
from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError
from supabase import create_client

# ========== CONFIGURATION ==========
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"

# Telegram API credentials (get from my.telegram.org)
TELEGRAM_API_ID = os.getenv("TELEGRAM_API_ID", "YOUR_API_ID")
TELEGRAM_API_HASH = os.getenv("TELEGRAM_API_HASH", "YOUR_API_HASH")

# Temp folder for session files
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")

# Message delay (seconds between messages to avoid spam detection)
MESSAGE_DELAY = 30

# ===================================

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def decode_session_file(phone_number: str, base64_data: str) -> str:
    """Decode base64 session data and save to temp file"""
    session_path = os.path.join(SESSION_FOLDER, f"{phone_number}")
    
    try:
        # Decode base64 and write to file
        session_bytes = base64.b64decode(base64_data)
        with open(session_path + ".session", "wb") as f:
            f.write(session_bytes)
        return session_path
    except Exception as e:
        print(f"  ⚠ Failed to decode session for {phone_number}: {e}")
        return None

async def load_accounts():
    """Load accounts with session data from database"""
    result = supabase.table("telegram_accounts").select("*").eq("status", "active").execute()
    accounts = result.data or []
    
    # Decode session files
    valid_accounts = []
    for account in accounts:
        if account.get("session_data"):
            session_path = decode_session_file(
                account["phone_number"].replace("+", ""),
                account["session_data"]
            )
            if session_path:
                account["_session_path"] = session_path
                valid_accounts.append(account)
        else:
            print(f"  ⚠ No session data for {account['phone_number']}")
    
    return valid_accounts

async def get_pending_messages():
    """Get pending messages from the queue"""
    result = supabase.table("messages").select(
        "*, conversations(*)"
    ).eq("status", "pending").eq("direction", "outgoing").limit(50).execute()
    return result.data or []

async def update_message_status(message_id: str, status: str, error: str = None):
    """Update message status in database"""
    update_data = {"status": status}
    if status == "sent":
        update_data["delivered_at"] = datetime.utcnow().isoformat()
    supabase.table("messages").update(update_data).eq("id", message_id).execute()

async def send_message(client: TelegramClient, phone: str, content: str):
    """Send a message to a phone number"""
    try:
        # Try to get the user entity
        entity = await client.get_entity(phone)
        await client.send_message(entity, content)
        return True, None
    except UserPrivacyRestrictedError:
        return False, "User privacy settings prevent messaging"
    except FloodWaitError as e:
        return False, f"Rate limited, wait {e.seconds} seconds"
    except Exception as e:
        return False, str(e)

async def process_account(account: dict, messages: list):
    """Process messages for a single account"""
    session_path = account.get("_session_path")
    
    if not session_path:
        print(f"  ⚠ No session path for {account['phone_number']}")
        return
    
    api_id = TELEGRAM_API_ID
    api_hash = TELEGRAM_API_HASH
    
    if api_id == "YOUR_API_ID" or api_hash == "YOUR_API_HASH":
        print("  ⚠ Please set TELEGRAM_API_ID and TELEGRAM_API_HASH")
        return
    
    client = TelegramClient(session_path, int(api_id), api_hash)
    
    try:
        await client.connect()
        
        if not await client.is_user_authorized():
            print(f"  ⚠ Session expired for {account['phone_number']}")
            return
        
        print(f"  ✓ Connected as {account['phone_number']}")
        
        account_messages = [m for m in messages if m["account_id"] == account["id"]]
        
        for msg in account_messages:
            conv = msg.get("conversations", {})
            phone = conv.get("recipient_phone")
            
            if not phone:
                await update_message_status(msg["id"], "failed")
                continue
            
            print(f"    → Sending to {phone}...")
            success, error = await send_message(client, phone, msg["content"])
            
            if success:
                await update_message_status(msg["id"], "sent")
                print(f"    ✓ Sent!")
            else:
                await update_message_status(msg["id"], "failed")
                print(f"    ✗ Failed: {error}")
            
            # Wait between messages
            await asyncio.sleep(MESSAGE_DELAY)
    
    finally:
        await client.disconnect()

async def main():
    print("=" * 50)
    print("TelegramCRM Bulk Message Sender")
    print(f"Session folder: {SESSION_FOLDER}")
    print("=" * 50)
    
    while True:
        print(f"\\n[{datetime.now().strftime('%H:%M:%S')}] Checking for pending messages...")
        
        accounts = await load_accounts()
        messages = await get_pending_messages()
        
        if not messages:
            print("  No pending messages. Waiting 30 seconds...")
            await asyncio.sleep(30)
            continue
        
        print(f"  Found {len(messages)} pending messages")
        print(f"  Active accounts: {len(accounts)}")
        
        for account in accounts:
            print(f"\\nProcessing account: {account['phone_number']}")
            await process_account(account, messages)
        
        print("\\n  Cycle complete. Checking again in 30 seconds...")
        await asyncio.sleep(30)

if __name__ == "__main__":
    print("Starting sender... Press Ctrl+C to stop.")
    asyncio.run(main())
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
