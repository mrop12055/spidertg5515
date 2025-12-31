# Complete VPS Setup Guide (Step-by-Step)

This guide walks you through setting up a VPS from scratch to run your Telegram hub backend.

## Step 1: Create a VPS

### Option A: DigitalOcean ($6/month)
1. Go to [digitalocean.com](https://digitalocean.com) and create an account
2. Click **Create** → **Droplets**
3. Choose:
   - **Region**: Pick one closest to you
   - **Image**: Ubuntu 22.04 LTS
   - **Size**: Basic → Regular → $6/mo (1GB RAM, 1 CPU)
   - **Authentication**: Choose **Password** (easier) or SSH Key (more secure)
4. Click **Create Droplet**
5. Copy the **IP Address** shown (e.g., `165.232.xxx.xxx`)

### Option B: Linode ($5/month)
1. Go to [linode.com](https://linode.com) and create an account
2. Click **Create Linode**
3. Choose:
   - **Image**: Ubuntu 22.04 LTS
   - **Region**: Pick one closest to you
   - **Plan**: Shared CPU → Nanode 1GB ($5/mo)
   - Set a **Root Password**
4. Click **Create Linode**
5. Copy the **IP Address** shown

---

## Step 2: Connect to Your VPS

### On Windows:
1. Download [PuTTY](https://putty.org/) or use Windows Terminal
2. Open terminal and type:
```bash
ssh root@YOUR_IP_ADDRESS
```
3. Enter your password when prompted

### On Mac/Linux:
1. Open Terminal
2. Type:
```bash
ssh root@YOUR_IP_ADDRESS
```
3. Enter your password when prompted

---

## Step 3: Initial Server Setup

Copy and paste these commands one by one:

```bash
# Update the system
apt update && apt upgrade -y

# Install required packages
apt install -y python3 python3-pip python3-venv git screen

# Create a directory for our bot
mkdir -p /opt/telegram-hub
cd /opt/telegram-hub

# Create a virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python packages
pip install telethon aiohttp python-socks aiosqlite cryptography
```

---

## Step 4: Get Telegram API Credentials

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Click **API Development Tools**
4. Create a new application:
   - **App title**: Telegram Hub
   - **Short name**: tghub
   - **Platform**: Desktop
5. Save your **API ID** and **API Hash** (you'll need these!)

---

## Step 5: Create the Backend Files

### Create config.py:
```bash
nano /opt/telegram-hub/config.py
```

Paste this (replace the values with your own):
```python
# Supabase Configuration
SUPABASE_URL = "https://ismtbdcnbxyyvsacbeld.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzbXRiZGNuYnh5eXZzYWNiZWxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxMjM5NzksImV4cCI6MjA4MjY5OTk3OX0.j0PjzGtgTtyhRvuG_IqsCHzrNBB_tni67q2_3SVXwL0"

# VPS API Key (generate a random one - keep this secret!)
# You can generate one at: https://www.uuidgenerator.net/
VPS_API_KEY = "YOUR_RANDOM_API_KEY_HERE"

# Telegram API Credentials (from my.telegram.org)
TELEGRAM_API_ID = YOUR_API_ID  # e.g., 12345678
TELEGRAM_API_HASH = "YOUR_API_HASH"  # e.g., "abc123def456..."

# Settings
MESSAGE_DELAY_MIN = 30  # seconds between messages
MESSAGE_DELAY_MAX = 60
MAX_MESSAGES_PER_DAY = 50
HEARTBEAT_INTERVAL = 30  # seconds
```

Press `Ctrl+X`, then `Y`, then `Enter` to save.

### Create main.py:
```bash
nano /opt/telegram-hub/main.py
```

Paste the entire backend code:
```python
#!/usr/bin/env python3
import asyncio
import json
import logging
import random
import time
from datetime import datetime
from typing import Dict, Optional

import aiohttp
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.types import User
import python_socks

from config import (
    SUPABASE_URL, SUPABASE_ANON_KEY, VPS_API_KEY,
    TELEGRAM_API_ID, TELEGRAM_API_HASH,
    MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX, MAX_MESSAGES_PER_DAY,
    HEARTBEAT_INTERVAL
)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class TelegramHubBackend:
    def __init__(self):
        self.clients: Dict[str, TelegramClient] = {}
        self.session = None
        self.running = True
        self.message_counts: Dict[str, int] = {}
        
    async def api_request(self, method: str, endpoint: str, data: dict = None) -> dict:
        """Make request to Supabase Edge Function"""
        url = f"{SUPABASE_URL}/functions/v1/telegram-api/{endpoint}"
        headers = {
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Content-Type": "application/json",
            "x-vps-api-key": VPS_API_KEY
        }
        
        try:
            async with self.session.request(method, url, headers=headers, json=data) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    error_text = await resp.text()
                    logger.error(f"API error {resp.status}: {error_text}")
                    return {"error": error_text}
        except Exception as e:
            logger.error(f"API request failed: {e}")
            return {"error": str(e)}
    
    async def send_heartbeat(self):
        """Send periodic heartbeat to server"""
        while self.running:
            try:
                result = await self.api_request("POST", "vps/heartbeat", {
                    "active_accounts": list(self.clients.keys()),
                    "timestamp": datetime.now().isoformat()
                })
                logger.debug(f"Heartbeat sent: {result}")
            except Exception as e:
                logger.error(f"Heartbeat failed: {e}")
            await asyncio.sleep(HEARTBEAT_INTERVAL)
    
    async def init_client(self, account: dict) -> Optional[TelegramClient]:
        """Initialize a Telegram client for an account"""
        account_id = account['id']
        phone = account['phone_number']
        session_data = account.get('session_data')
        
        if not session_data:
            logger.warning(f"No session data for account {phone}")
            return None
        
        # Setup proxy if configured
        proxy = None
        if account.get('proxy_id'):
            proxy_data = account.get('proxy')
            if proxy_data:
                proxy_type = {
                    'socks5': python_socks.ProxyType.SOCKS5,
                    'socks4': python_socks.ProxyType.SOCKS4,
                    'http': python_socks.ProxyType.HTTP,
                    'https': python_socks.ProxyType.HTTP
                }.get(proxy_data.get('proxy_type', 'socks5'))
                
                proxy = {
                    'proxy_type': proxy_type,
                    'addr': proxy_data['host'],
                    'port': proxy_data['port'],
                    'username': proxy_data.get('username'),
                    'password': proxy_data.get('password')
                }
        
        try:
            client = TelegramClient(
                StringSession(session_data),
                TELEGRAM_API_ID,
                TELEGRAM_API_HASH,
                proxy=proxy
            )
            
            await client.connect()
            
            if not await client.is_user_authorized():
                logger.error(f"Session not authorized for {phone}")
                return None
            
            # Setup message handler
            @client.on(events.NewMessage(incoming=True))
            async def handle_incoming(event):
                await self.handle_incoming_message(account_id, event)
            
            self.clients[account_id] = client
            self.message_counts[account_id] = 0
            
            logger.info(f"Client initialized for {phone}")
            return client
            
        except Exception as e:
            logger.error(f"Failed to init client for {phone}: {e}")
            return None
    
    async def handle_incoming_message(self, account_id: str, event):
        """Handle incoming messages"""
        try:
            sender = await event.get_sender()
            if not isinstance(sender, User):
                return
            
            message_data = {
                "account_id": account_id,
                "telegram_id": sender.id,
                "username": sender.username,
                "first_name": sender.first_name,
                "last_name": sender.last_name,
                "content": event.message.text or "",
                "telegram_message_id": event.message.id
            }
            
            result = await self.api_request("POST", "messages/incoming", message_data)
            logger.info(f"Incoming message saved: {result}")
            
        except Exception as e:
            logger.error(f"Error handling incoming message: {e}")
    
    async def send_pending_messages(self):
        """Check and send pending outgoing messages"""
        while self.running:
            try:
                result = await self.api_request("GET", "messages/pending")
                messages = result.get("messages", [])
                
                for msg in messages:
                    account_id = msg['account_id']
                    client = self.clients.get(account_id)
                    
                    if not client:
                        continue
                    
                    # Check daily limit
                    if self.message_counts.get(account_id, 0) >= MAX_MESSAGES_PER_DAY:
                        logger.warning(f"Daily limit reached for {account_id}")
                        continue
                    
                    try:
                        # Get recipient
                        recipient = msg.get('recipient_phone') or msg.get('recipient_username')
                        if not recipient:
                            continue
                        
                        # Send message
                        await client.send_message(recipient, msg['content'])
                        
                        # Update status
                        await self.api_request("POST", "messages/status", {
                            "message_id": msg['id'],
                            "status": "sent"
                        })
                        
                        self.message_counts[account_id] = self.message_counts.get(account_id, 0) + 1
                        logger.info(f"Message sent to {recipient}")
                        
                        # Random delay between messages
                        delay = random.uniform(MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX)
                        await asyncio.sleep(delay)
                        
                    except Exception as e:
                        logger.error(f"Failed to send message: {e}")
                        await self.api_request("POST", "messages/status", {
                            "message_id": msg['id'],
                            "status": "failed",
                            "error": str(e)
                        })
                
            except Exception as e:
                logger.error(f"Error in send loop: {e}")
            
            await asyncio.sleep(5)
    
    async def load_accounts(self):
        """Load active accounts from database"""
        result = await self.api_request("GET", "vps/accounts")
        accounts = result.get("accounts", [])
        
        for account in accounts:
            if account['id'] not in self.clients:
                await self.init_client(account)
        
        logger.info(f"Loaded {len(self.clients)} accounts")
    
    async def run(self):
        """Main run loop"""
        logger.info("Starting Telegram Hub Backend...")
        
        self.session = aiohttp.ClientSession()
        
        try:
            # Load initial accounts
            await self.load_accounts()
            
            # Start background tasks
            tasks = [
                asyncio.create_task(self.send_heartbeat()),
                asyncio.create_task(self.send_pending_messages()),
            ]
            
            # Keep running
            while self.running:
                await asyncio.sleep(60)
                # Reload accounts periodically
                await self.load_accounts()
                
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            self.running = False
            
            # Disconnect all clients
            for client in self.clients.values():
                await client.disconnect()
            
            await self.session.close()

if __name__ == "__main__":
    backend = TelegramHubBackend()
    asyncio.run(backend.run())
```

Press `Ctrl+X`, then `Y`, then `Enter` to save.

### Create session generator script:
```bash
nano /opt/telegram-hub/generate_session.py
```

Paste:
```python
#!/usr/bin/env python3
import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from config import TELEGRAM_API_ID, TELEGRAM_API_HASH

async def generate_session():
    print("\n=== Telegram Session Generator ===\n")
    
    phone = input("Enter phone number (with country code, e.g., +1234567890): ")
    
    client = TelegramClient(StringSession(), TELEGRAM_API_ID, TELEGRAM_API_HASH)
    await client.connect()
    
    await client.send_code_request(phone)
    code = input("Enter the code you received: ")
    
    try:
        await client.sign_in(phone, code)
    except Exception as e:
        if "password" in str(e).lower():
            password = input("Enter your 2FA password: ")
            await client.sign_in(password=password)
    
    session_string = client.session.save()
    
    print("\n" + "="*50)
    print("YOUR SESSION STRING (copy this!):")
    print("="*50)
    print(session_string)
    print("="*50)
    print("\nSave this session string in your database!")
    
    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(generate_session())
```

Press `Ctrl+X`, then `Y`, then `Enter` to save.

---

## Step 6: Generate Session Strings for Your Telegram Accounts

For each Telegram account you want to use:

```bash
cd /opt/telegram-hub
source venv/bin/activate
python generate_session.py
```

1. Enter the phone number
2. Enter the verification code you receive on Telegram
3. Copy the session string that's printed
4. Add this session string to the account in your dashboard

---

## Step 7: Add VPS Connection to Dashboard

1. Go to your Telegram Hub dashboard
2. Navigate to **Settings** → **VPS Connections**
3. Click **Add VPS**
4. Enter:
   - **Name**: My VPS (or any name)
   - **API Key**: The same VPS_API_KEY you set in config.py
   - **IP Address**: Your VPS IP

---

## Step 8: Run the Backend

### Option A: Using Screen (stays running after you disconnect)
```bash
cd /opt/telegram-hub
source venv/bin/activate
screen -S telegram-hub
python main.py
```

To detach from screen: Press `Ctrl+A`, then `D`
To reattach later: `screen -r telegram-hub`

### Option B: Using Systemd (auto-starts on reboot)
```bash
nano /etc/systemd/system/telegram-hub.service
```

Paste:
```ini
[Unit]
Description=Telegram Hub Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/telegram-hub
ExecStart=/opt/telegram-hub/venv/bin/python main.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then run:
```bash
systemctl daemon-reload
systemctl enable telegram-hub
systemctl start telegram-hub
```

Check status:
```bash
systemctl status telegram-hub
```

View logs:
```bash
journalctl -u telegram-hub -f
```

---

## Step 9: Test the Connection

1. Check VPS logs for "Starting Telegram Hub Backend..."
2. In your dashboard, the VPS should show as "Online"
3. Try adding an account and generating a session
4. Test sending a message from the Chat page

---

## Troubleshooting

### "API request failed"
- Check your SUPABASE_URL and SUPABASE_ANON_KEY in config.py
- Make sure the VPS has internet access: `ping google.com`

### "Session not authorized"
- The session string is invalid or expired
- Generate a new session string for that account

### "Connection refused"
- Check if the service is running: `systemctl status telegram-hub`
- Check logs: `journalctl -u telegram-hub -f`

### Bot not receiving messages
- Make sure the account is "Active" in your dashboard
- Check that session_data is saved for the account

---

## Quick Reference Commands

```bash
# Start the bot
systemctl start telegram-hub

# Stop the bot
systemctl stop telegram-hub

# Restart the bot
systemctl restart telegram-hub

# View live logs
journalctl -u telegram-hub -f

# Edit config
nano /opt/telegram-hub/config.py

# Activate virtual environment
source /opt/telegram-hub/venv/bin/activate

# Generate new session
cd /opt/telegram-hub && source venv/bin/activate && python generate_session.py
```

---

## Security Tips

1. **Change SSH port** (optional but recommended):
   ```bash
   nano /etc/ssh/sshd_config
   # Change "Port 22" to something else like "Port 2222"
   systemctl restart sshd
   ```

2. **Setup firewall**:
   ```bash
   ufw allow ssh
   ufw enable
   ```

3. **Keep your VPS_API_KEY secret** - never share it publicly

4. **Use strong passwords** for both VPS and Telegram accounts
