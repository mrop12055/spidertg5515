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
        description="Configure the Python sender script on your PC"
      />

      <div className="space-y-6">
        {/* Requirements */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="w-5 h-5 text-primary" />
              Requirements
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="p-4 rounded-lg bg-accent/50 border">
                <h4 className="font-medium mb-2">Python 3.8+</h4>
                <p className="text-sm text-muted-foreground mb-2">Download from python.org</p>
                <a 
                  href="https://www.python.org/downloads/" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary text-sm flex items-center gap-1 hover:underline"
                >
                  Download Python <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="p-4 rounded-lg bg-accent/50 border">
                <h4 className="font-medium mb-2">Telethon Library</h4>
                <p className="text-sm text-muted-foreground mb-2">Telegram client for Python</p>
                <code className="text-xs bg-background px-2 py-1 rounded">pip install telethon</code>
              </div>
              <div className="p-4 rounded-lg bg-accent/50 border">
                <h4 className="font-medium mb-2">Supabase Library</h4>
                <p className="text-sm text-muted-foreground mb-2">Database connection</p>
                <code className="text-xs bg-background px-2 py-1 rounded">pip install supabase</code>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 1: Install Dependencies */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 1</Badge>
              Install Dependencies
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Open your terminal/command prompt and run:
            </p>
            <div className="relative">
              <pre className="bg-background p-4 rounded-lg border overflow-x-auto text-sm">
                pip install telethon supabase
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2"
                onClick={() => copyToClipboard('pip install telethon supabase', 'pip')}
              >
                {copied === 'pip' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Step 2: Download Script */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 2</Badge>
              Download the Sender Script
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Save this Python script to your computer (e.g., <code className="bg-accent px-1 rounded">telegram_sender.py</code>):
            </p>
            <div className="relative">
              <pre className="bg-background p-4 rounded-lg border overflow-x-auto text-xs max-h-96">
                {pythonScript}
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2"
                onClick={() => copyToClipboard(pythonScript, 'script')}
              >
                {copied === 'script' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <Button 
              onClick={() => {
                const blob = new Blob([pythonScript], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'telegram_sender.py';
                a.click();
                URL.revokeObjectURL(url);
                toast.success('Script downloaded!');
              }}
              className="gap-2"
            >
              <Download className="w-4 h-4" />
              Download Script
            </Button>
          </CardContent>
        </Card>

        {/* Step 3: Upload Session Files */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 3</Badge>
              Upload Session Files
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Go to the <strong>Accounts</strong> page and upload your <code className="bg-accent px-1 rounded">.session</code> files:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
              <li>Click <strong>"Add Accounts"</strong> button</li>
              <li>Drag and drop your .session files (e.g., <code className="bg-accent px-1 rounded">5493416219301.session</code>)</li>
              <li>Phone number is auto-detected from filename</li>
              <li>Click <strong>"Upload"</strong> to save to database</li>
            </ol>
            <div className="p-4 rounded-lg bg-status-warning/10 border border-status-warning/30">
              <div className="flex gap-2">
                <AlertTriangle className="w-5 h-5 text-status-warning flex-shrink-0" />
                <div>
                  <h4 className="font-medium text-status-warning">Important</h4>
                  <p className="text-sm text-muted-foreground mt-1">
                    Your .session files must be valid Telethon SQLite sessions created with your logged-in Telegram accounts.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 4: API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 4</Badge>
              Configure Telegram API Credentials
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
              <li>Go to <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">my.telegram.org</a></li>
              <li>Log in with your phone number</li>
              <li>Go to "API Development Tools"</li>
              <li>Create a new application</li>
              <li>Copy your <strong>api_id</strong> and <strong>api_hash</strong></li>
            </ol>
            <div className="p-4 rounded-lg bg-accent/50 border mt-4">
              <h4 className="font-medium mb-2">Set as environment variables before running:</h4>
              <div className="space-y-2">
                <div className="relative">
                  <pre className="bg-background p-3 rounded-lg border text-xs overflow-x-auto">
{`# Windows (PowerShell)
$env:TELEGRAM_API_ID="12345678"
$env:TELEGRAM_API_HASH="your_api_hash"

# Linux/Mac
export TELEGRAM_API_ID="12345678"
export TELEGRAM_API_HASH="your_api_hash"`}
                  </pre>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Step 5: Run */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground">Step 5</Badge>
              Run the Script
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Open terminal in the folder with your script and run:
            </p>
            <div className="relative">
              <pre className="bg-background p-4 rounded-lg border overflow-x-auto text-sm">
                python telegram_sender.py
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2"
                onClick={() => copyToClipboard('python telegram_sender.py', 'run')}
              >
                {copied === 'run' ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <div className="p-4 rounded-lg bg-accent/50 border">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                Expected Output
              </h4>
              <pre className="text-xs text-muted-foreground">
{`==================================================
TelegramCRM Bulk Message Sender
==================================================

[14:30:00] Checking for pending messages...
  Found 5 pending messages
  Active accounts: 2

Processing account: +14155551234
  ✓ Connected as +14155551234
    → Sending to +19876543210...
    ✓ Sent!`}
              </pre>
            </div>
          </CardContent>
        </Card>

        {/* Workflow */}
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Play className="w-5 h-5 text-primary" />
              Complete Workflow
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
