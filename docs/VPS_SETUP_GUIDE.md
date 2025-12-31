# VPS Setup Guide for Telegram Hub Backend

This guide will help you set up a Python backend on your VPS to handle real Telegram operations.

## Requirements

- **VPS**: Ubuntu 20.04+ or similar Linux server
- **Python**: 3.9+
- **Memory**: At least 2GB RAM
- **Storage**: 20GB+ for session files

## Step 1: Server Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Python and dependencies
sudo apt install python3 python3-pip python3-venv git screen -y

# Create project directory
mkdir ~/telegram-hub && cd ~/telegram-hub

# Create virtual environment
python3 -m venv venv
source venv/bin/activate
```

## Step 2: Install Dependencies

```bash
pip install telethon aiohttp python-socks aiosqlite cryptography
```

## Step 3: Configuration

Create a `config.py` file:

```python
# config.py
SUPABASE_URL = "https://ismtbdcnbxyyvsacbeld.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzbXRiZGNuYnh5eXZzYWNiZWxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxMjM5NzksImV4cCI6MjA4MjY5OTk3OX0.j0PjzGtgTtyhRvuG_IqsCHzrNBB_tni67q2_3SVXwL0"
API_ENDPOINT = f"{SUPABASE_URL}/functions/v1/telegram-api"

# Your VPS API key (generate a random string)
VPS_API_KEY = "your-random-api-key-here"

# Telegram API credentials (get from https://my.telegram.org)
TELEGRAM_API_ID = 12345678  # Your API ID
TELEGRAM_API_HASH = "your_api_hash_here"

# Settings
MESSAGE_DELAY = 60  # Seconds between messages
MAX_MESSAGES_PER_DAY = 25
HEARTBEAT_INTERVAL = 30  # Seconds
```

## Step 4: Main Backend Code

Create `main.py`:

```python
#!/usr/bin/env python3
"""
Telegram Hub VPS Backend
Handles real Telegram operations and syncs with Supabase
"""

import asyncio
import aiohttp
import json
import os
from datetime import datetime
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.types import PeerUser
import python_socks

from config import *

class TelegramHubBackend:
    def __init__(self):
        self.clients = {}  # account_id -> TelegramClient
        self.running = True
        self.session = None
    
    async def api_request(self, method, path, data=None):
        """Make request to Supabase Edge Function API"""
        url = f"{API_ENDPOINT}{path}"
        headers = {
            "Content-Type": "application/json",
            "x-vps-api-key": VPS_API_KEY,
            "apikey": SUPABASE_ANON_KEY
        }
        
        async with self.session.request(method, url, json=data, headers=headers) as resp:
            if resp.status >= 400:
                text = await resp.text()
                print(f"API Error {resp.status}: {text}")
                return None
            return await resp.json()
    
    async def send_heartbeat(self):
        """Send heartbeat to confirm VPS is running"""
        while self.running:
            try:
                result = await self.api_request("POST", "/vps/heartbeat")
                if result:
                    print(f"[Heartbeat] OK - Server time: {result.get('server_time')}")
            except Exception as e:
                print(f"[Heartbeat] Error: {e}")
            await asyncio.sleep(HEARTBEAT_INTERVAL)
    
    async def init_client(self, account):
        """Initialize Telegram client for an account"""
        account_id = account['id']
        session_data = account.get('session_data')
        
        if not session_data:
            print(f"[Client] No session for account {account['phone_number']}")
            return None
        
        # Get proxy config if available
        proxy = None
        if account.get('proxies'):
            p = account['proxies']
            proxy_type = {
                'socks5': python_socks.ProxyType.SOCKS5,
                'socks4': python_socks.ProxyType.SOCKS4,
                'http': python_socks.ProxyType.HTTP,
            }.get(p.get('proxy_type', 'socks5'))
            
            proxy = (proxy_type, p['host'], p['port'], True, p.get('username'), p.get('password'))
        
        try:
            client = TelegramClient(
                StringSession(session_data),
                TELEGRAM_API_ID,
                TELEGRAM_API_HASH,
                proxy=proxy
            )
            
            await client.connect()
            
            if not await client.is_user_authorized():
                print(f"[Client] Session expired for {account['phone_number']}")
                await self.api_request("PATCH", f"/accounts/{account_id}", {
                    "status": "disconnected"
                })
                return None
            
            # Get user info
            me = await client.get_me()
            print(f"[Client] Connected as {me.first_name} (@{me.username})")
            
            # Update account status
            await self.api_request("PATCH", f"/accounts/{account_id}", {
                "status": "active",
                "last_active": datetime.now().isoformat(),
                "telegram_id": me.id,
                "username": me.username,
                "first_name": me.first_name,
                "last_name": me.last_name
            })
            
            # Set up incoming message handler
            @client.on(events.NewMessage(incoming=True))
            async def handler(event):
                await self.handle_incoming_message(account_id, event)
            
            self.clients[account_id] = client
            return client
            
        except Exception as e:
            print(f"[Client] Error initializing {account['phone_number']}: {e}")
            await self.api_request("PATCH", f"/accounts/{account_id}", {
                "status": "disconnected",
                "ban_reason": str(e)
            })
            return None
    
    async def handle_incoming_message(self, account_id, event):
        """Handle incoming Telegram messages"""
        try:
            sender = await event.get_sender()
            
            # Find or create conversation
            conversations = await self.api_request("GET", f"/conversations?account_id={account_id}")
            
            existing_conv = None
            if conversations:
                for conv in conversations:
                    if conv.get('recipient_telegram_id') == sender.id:
                        existing_conv = conv
                        break
            
            if not existing_conv:
                # Create new conversation
                existing_conv = await self.api_request("POST", "/conversations", {
                    "account_id": account_id,
                    "recipient_telegram_id": sender.id,
                    "recipient_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "recipient_username": sender.username,
                    "is_active": True
                })
            
            if existing_conv:
                # Save message
                await self.api_request("POST", "/messages", {
                    "account_id": account_id,
                    "conversation_id": existing_conv['id'],
                    "telegram_message_id": event.message.id,
                    "content": event.message.text or "[Media]",
                    "direction": "incoming",
                    "status": "delivered"
                })
                
                print(f"[Message] Received from {sender.first_name}: {event.message.text[:50]}...")
                
        except Exception as e:
            print(f"[Message] Error handling incoming: {e}")
    
    async def send_pending_messages(self):
        """Send pending outgoing messages"""
        while self.running:
            try:
                messages = await self.api_request("GET", "/vps/pending-messages")
                
                if messages:
                    for msg in messages:
                        account_id = msg['account_id']
                        client = self.clients.get(account_id)
                        
                        if not client:
                            continue
                        
                        conv = msg.get('conversations', {})
                        recipient_id = conv.get('recipient_telegram_id')
                        
                        if not recipient_id:
                            # Try phone number
                            phone = conv.get('recipient_phone')
                            if phone:
                                try:
                                    entity = await client.get_entity(phone)
                                    recipient_id = entity.id
                                except:
                                    continue
                        
                        if recipient_id:
                            try:
                                # Send message
                                result = await client.send_message(recipient_id, msg['content'])
                                
                                # Update message status
                                await self.api_request("PATCH", f"/messages/{msg['id']}", {
                                    "status": "sent",
                                    "telegram_message_id": result.id,
                                    "delivered_at": datetime.now().isoformat()
                                })
                                
                                # Update account message count
                                account = msg.get('telegram_accounts', {})
                                await self.api_request("PATCH", f"/accounts/{account_id}", {
                                    "messages_sent_today": (account.get('messages_sent_today', 0) or 0) + 1,
                                    "last_active": datetime.now().isoformat()
                                })
                                
                                print(f"[Send] Message sent to {recipient_id}")
                                
                                # Delay between messages
                                await asyncio.sleep(MESSAGE_DELAY)
                                
                            except Exception as e:
                                print(f"[Send] Error: {e}")
                                await self.api_request("PATCH", f"/messages/{msg['id']}", {
                                    "status": "failed"
                                })
                                
                                # Check for ban/restriction
                                if "banned" in str(e).lower() or "flood" in str(e).lower():
                                    await self.api_request("PATCH", f"/accounts/{account_id}", {
                                        "status": "restricted" if "flood" in str(e).lower() else "banned",
                                        "ban_reason": str(e)
                                    })
                
            except Exception as e:
                print(f"[Send] Loop error: {e}")
            
            await asyncio.sleep(5)  # Check every 5 seconds
    
    async def load_accounts(self):
        """Load and initialize all active accounts"""
        accounts = await self.api_request("GET", "/vps/accounts-to-process")
        
        if accounts:
            print(f"[Load] Found {len(accounts)} accounts to process")
            
            for account in accounts:
                if account['id'] not in self.clients:
                    await self.init_client(account)
    
    async def run(self):
        """Main run loop"""
        print("=" * 50)
        print("Telegram Hub VPS Backend")
        print("=" * 50)
        
        self.session = aiohttp.ClientSession()
        
        try:
            # Start heartbeat
            asyncio.create_task(self.send_heartbeat())
            
            # Load accounts
            await self.load_accounts()
            
            # Start message sender
            asyncio.create_task(self.send_pending_messages())
            
            # Keep running
            while self.running:
                # Periodically reload accounts
                await asyncio.sleep(60)
                await self.load_accounts()
                
        except KeyboardInterrupt:
            print("\n[Shutdown] Stopping...")
        finally:
            self.running = False
            
            # Disconnect all clients
            for account_id, client in self.clients.items():
                await client.disconnect()
            
            await self.session.close()

if __name__ == "__main__":
    backend = TelegramHubBackend()
    asyncio.run(backend.run())
```

## Step 5: Session Generator

Create `generate_session.py` to create session strings from phone numbers:

```python
#!/usr/bin/env python3
"""Generate Telethon session string from phone number"""

import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

from config import TELEGRAM_API_ID, TELEGRAM_API_HASH

async def generate_session():
    phone = input("Enter phone number (with country code): ")
    
    client = TelegramClient(StringSession(), TELEGRAM_API_ID, TELEGRAM_API_HASH)
    await client.connect()
    
    await client.send_code_request(phone)
    code = input("Enter the code you received: ")
    
    try:
        await client.sign_in(phone, code)
    except Exception as e:
        if "password" in str(e).lower():
            password = input("Enter 2FA password: ")
            await client.sign_in(password=password)
    
    session_string = client.session.save()
    print("\n" + "=" * 50)
    print("SESSION STRING (save this):")
    print("=" * 50)
    print(session_string)
    print("=" * 50)
    
    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(generate_session())
```

## Step 6: Running the Backend

```bash
# Activate virtual environment
cd ~/telegram-hub
source venv/bin/activate

# Run in background with screen
screen -S telegram-hub
python main.py

# Detach from screen: Ctrl+A, then D
# Reattach: screen -r telegram-hub
```

## Step 7: Systemd Service (Optional)

Create `/etc/systemd/system/telegram-hub.service`:

```ini
[Unit]
Description=Telegram Hub Backend
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/home/your_username/telegram-hub
Environment=PATH=/home/your_username/telegram-hub/venv/bin
ExecStart=/home/your_username/telegram-hub/venv/bin/python main.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable telegram-hub
sudo systemctl start telegram-hub
sudo systemctl status telegram-hub
```

## API Endpoints

Your VPS backend communicates with these API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/accounts` | GET | Get all accounts |
| `/accounts` | POST | Add new account |
| `/accounts/:id` | PATCH | Update account |
| `/proxies` | GET/POST | Manage proxies |
| `/conversations` | GET/POST | Manage conversations |
| `/messages` | GET/POST | Manage messages |
| `/vps/heartbeat` | POST | VPS health check |
| `/vps/pending-messages` | GET | Get messages to send |

## Important Notes

1. **Get Telegram API credentials** from https://my.telegram.org
2. **Generate session strings** using the provided script
3. **Use proxies** to avoid IP bans
4. **Start with low message limits** (10-15/day) and increase gradually
5. **Mature accounts** for 10-15 days before bulk messaging

## Troubleshooting

- **Session expired**: Re-generate session string
- **FloodWait**: Too many requests, bot will wait automatically
- **Banned**: Account needs new SIM/number
- **Connection errors**: Check proxy settings
