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
TelegramCRM Dual-Mode Message Sender & Receiver
===============================================
Run this script on your PC to send queued messages and receive incoming replies.
Session files are downloaded from the database (base64 encoded).
Supports sending and receiving images.

DUAL MODE OPERATION:
  • Campaign Mode: Controlled intervals for first-contact messages (uses account rotation)
  • Live Chat Mode: Fast 1-2 second checks for active conversations (after customer replies)

A conversation is "live" when the customer has replied within the last 5 minutes.
"""

import asyncio
import os
import base64
import tempfile
import httpx
import json
import time
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Set

# Install: pip install telethon supabase httpx
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError, UsernameNotOccupiedError
from supabase import create_client

# ========== CONFIGURATION ==========
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"

# Telegram API credentials (hardcoded for convenience)
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"

# Temp folder for session files
SESSION_FOLDER = tempfile.mkdtemp(prefix="telegram_sessions_")

# ========== DUAL MODE CONFIGURATION ==========
CAMPAIGN_CHECK_INTERVAL = 3  # seconds - for campaign messages (faster!)
LIVE_CHAT_CHECK_INTERVAL = 1  # seconds - for live conversations (customer replied)
LIVE_CONVERSATION_TIMEOUT = 5  # minutes - conversation stays "live" after last incoming message

# Default settings (can be overridden by scheduler settings from localStorage)
DEFAULT_MESSAGE_DELAY = 1  # faster default
DEFAULT_CHECK_INTERVAL = 1  # faster default

# ========== SCHEDULER SETTINGS ==========
@dataclass
class SchedulerSettings:
    enabled: bool = True
    max_messages_before_rotation: int = 10  # more messages before rotating
    cooldown_duration: int = 10  # minutes (reduced from 30)
    prioritize_high_maturity: bool = True
    auto_skip_restricted: bool = True
    balance_load: bool = True
    messages_per_account: int = 10  # more per account before switching
    message_interval: int = 3  # seconds between messages (reduced from 30!)
    account_switch_delay: int = 5  # seconds before next account (reduced from 60!)

@dataclass
class AccountState:
    id: str
    phone_number: str
    first_name: str = ""
    messages_sent_today: int = 0
    daily_limit: int = 25
    maturity_score: int = 0
    status: str = "active"
    cooldown_until: float = 0  # timestamp when cooldown ends
    messages_sent_this_session: int = 0
    last_message_time: float = 0
    priority: float = 0

# ===================================

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Store active clients for receiving messages
active_clients: Dict[str, TelegramClient] = {}

# Account states for scheduling
account_states: Dict[str, AccountState] = {}

# Scheduler settings
scheduler_settings = SchedulerSettings()

# Current active account for sending
current_account_id: Optional[str] = None

# Message counter for rotation
messages_sent_by_current: int = 0


def load_scheduler_settings():
    """Load scheduler settings from a JSON file (exported from the web app)"""
    global scheduler_settings
    
    settings_file = os.path.join(SESSION_FOLDER, "scheduler_settings.json")
    
    # Check for settings file in current directory too
    if not os.path.exists(settings_file):
        settings_file = "scheduler_settings.json"
    
    if os.path.exists(settings_file):
        try:
            with open(settings_file, 'r') as f:
                data = json.load(f)
                scheduler_settings = SchedulerSettings(
                    enabled=data.get('enabled', True),
                    max_messages_before_rotation=data.get('maxMessagesBeforeRotation', 5),
                    cooldown_duration=data.get('cooldownDuration', 30),
                    prioritize_high_maturity=data.get('prioritizeHighMaturity', True),
                    auto_skip_restricted=data.get('autoSkipRestricted', True),
                    balance_load=data.get('balanceLoad', True),
                    messages_per_account=data.get('messagesPerAccount', 5),
                    message_interval=data.get('messageInterval', 30),
                    account_switch_delay=data.get('accountSwitchDelay', 60),
                )
                print(f"  📋 Loaded scheduler settings from {settings_file}")
        except Exception as e:
            print(f"  ⚠ Failed to load scheduler settings: {e}")
    else:
        print(f"  ℹ Using default scheduler settings")
        print(f"    Tip: Create scheduler_settings.json with your campaign settings")


def calculate_account_priority(state: AccountState) -> float:
    """Calculate priority score for an account"""
    if state.status != 'active':
        return -1000
    
    if state.messages_sent_today >= state.daily_limit:
        return -500  # Exhausted
    
    if time.time() < state.cooldown_until:
        return -100  # In cooldown
    
    priority = 100.0
    messages_remaining = state.daily_limit - state.messages_sent_today
    
    # Higher maturity = higher priority
    if scheduler_settings.prioritize_high_maturity:
        priority += state.maturity_score * 0.5
    
    # More messages remaining = higher priority
    priority += messages_remaining * 2
    
    # Balance load - lower usage today = higher priority
    if scheduler_settings.balance_load:
        priority += messages_remaining * 3
    
    return priority


def get_next_available_account() -> Optional[str]:
    """Get the next best account for sending messages"""
    global current_account_id
    
    if not scheduler_settings.enabled:
        # If scheduler disabled, just return first active account
        for account_id, state in account_states.items():
            if state.status == 'active' and state.messages_sent_today < state.daily_limit:
                return account_id
        return None
    
    # Calculate priorities and sort
    available = []
    now = time.time()
    
    for account_id, state in account_states.items():
        # Skip restricted accounts if setting enabled
        if scheduler_settings.auto_skip_restricted:
            if state.status in ['banned', 'restricted', 'disconnected']:
                continue
        
        # Skip if exhausted
        if state.messages_sent_today >= state.daily_limit:
            continue
        
        # Skip if in cooldown
        if now < state.cooldown_until:
            remaining = int(state.cooldown_until - now)
            if remaining > 0:
                continue
        
        priority = calculate_account_priority(state)
        available.append((account_id, priority))
    
    if not available:
        return None
    
    # Sort by priority (highest first)
    available.sort(key=lambda x: x[1], reverse=True)
    
    return available[0][0]


def put_account_on_cooldown(account_id: str):
    """Put an account on cooldown"""
    if account_id in account_states:
        cooldown_seconds = scheduler_settings.cooldown_duration * 60
        account_states[account_id].cooldown_until = time.time() + cooldown_seconds
        print(f"    ⏸ Account {account_states[account_id].phone_number} on cooldown for {scheduler_settings.cooldown_duration}m")


def should_rotate_account() -> bool:
    """Check if we should rotate to a different account"""
    global messages_sent_by_current, current_account_id
    
    if not scheduler_settings.enabled:
        return False
    
    if current_account_id is None:
        return True
    
    # Rotate if we've sent enough messages
    if messages_sent_by_current >= scheduler_settings.max_messages_before_rotation:
        return True
    
    # Rotate if current account is at daily limit
    if current_account_id in account_states:
        state = account_states[current_account_id]
        if state.messages_sent_today >= state.daily_limit:
            return True
        
        # Rotate if current account is no longer active
        if state.status != 'active':
            return True
    
    return False


def rotate_account() -> Optional[str]:
    """Rotate to the next best account"""
    global current_account_id, messages_sent_by_current
    
    old_account = current_account_id
    
    # Put old account on cooldown if it was active
    if old_account and old_account in account_states:
        put_account_on_cooldown(old_account)
    
    # Get next account
    new_account = get_next_available_account()
    
    if new_account:
        current_account_id = new_account
        messages_sent_by_current = 0
        state = account_states[new_account]
        print(f"  🔄 Rotated to account: {state.phone_number} (priority: {calculate_account_priority(state):.1f})")
        return new_account
    else:
        print("  ⚠ No available accounts for rotation")
        current_account_id = None
        return None


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
    global account_states
    
    result = supabase.table("telegram_accounts").select("*").eq("status", "active").execute()
    accounts = result.data or []
    
    # Decode session files and update account states
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
                
                # Update or create account state
                account_id = account["id"]
                if account_id not in account_states:
                    account_states[account_id] = AccountState(
                        id=account_id,
                        phone_number=account["phone_number"]
                    )
                
                # Update state from database
                state = account_states[account_id]
                state.first_name = account.get("first_name", "")
                state.messages_sent_today = account.get("messages_sent_today", 0)
                state.daily_limit = account.get("daily_limit", 25)
                state.maturity_score = account.get("maturity_score", 0)
                state.status = account.get("status", "active")
        else:
            print(f"  ⚠ No session data for {account['phone_number']}")
    
    return valid_accounts


async def get_pending_messages():
    """Get pending messages from the queue (excludes orphaned campaign messages)"""
    result = supabase.table("messages").select(
        "*, conversations(*)"
    ).eq("status", "pending").eq("direction", "outgoing").limit(50).execute()
    
    # Filter out orphaned campaign messages (campaign was deleted)
    # A message is orphaned if it was meant for a campaign but has no campaign_recipient_id
    # This can happen if the campaign was deleted while messages were queued
    messages = result.data or []
    return [
        msg for msg in messages 
        if not is_orphaned_campaign_message(msg)
    ]


def is_orphaned_campaign_message(msg):
    """
    Check if a message is an orphaned campaign message.
    Orphaned messages have no campaign_recipient_id but were queued from a campaign.
    These should be skipped as the campaign was deleted.
    """
    # If it has a campaign_recipient_id, it's valid
    if msg.get("campaign_recipient_id"):
        return False
    
    # Check if conversation was created for a campaign (has no customer reply)
    conv = msg.get("conversations", {}) or {}
    
    # If conversation has no recipient_telegram_id and is not active, 
    # it's likely a campaign-created conversation that was orphaned
    if not conv.get("is_active") and not conv.get("recipient_telegram_id"):
        # This is a first-contact message with no campaign tracking - orphaned
        return True
    
    return False


async def get_validating_recipients():
    """Get recipients that need Telegram validation"""
    result = supabase.table("campaign_recipients").select("*").eq("status", "validating").limit(50).execute()
    return result.data or []


async def validate_telegram_contact(client: TelegramClient, phone_number: str) -> Tuple[bool, Optional[str], Optional[int]]:
    """
    Validate if a phone number exists on Telegram and get their name.
    Uses ImportContactsRequest to properly resolve phone numbers.
    Returns: (exists: bool, name: str or None, telegram_id: int or None)
    """
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        import random
        
        # Create a temporary contact to check if user exists
        contact = InputPhoneContact(
            client_id=random.randint(0, 2**31 - 1),
            phone=phone_number,
            first_name="Validation",
            last_name=""
        )
        
        # Import the contact - this will tell us if the phone is on Telegram
        result = await client(ImportContactsRequest([contact]))
        
        if result.users:
            user = result.users[0]
            # Build the name from first_name and last_name
            first_name = getattr(user, 'first_name', '') or ''
            last_name = getattr(user, 'last_name', '') or ''
            full_name = f"{first_name} {last_name}".strip()
            
            telegram_id = getattr(user, 'id', None)
            
            print(f"    ✓ Found on Telegram: {phone_number} -> {full_name or 'No name'}")
            return True, full_name if full_name else None, telegram_id
        else:
            print(f"    ✗ Not on Telegram: {phone_number}")
            return False, None, None
            
    except Exception as e:
        print(f"    ⚠ Error validating {phone_number}: {e}")
        return False, None, None


async def update_recipient_validation(recipient_id: str, status: str, name: str = None):
    """Update recipient validation status and name"""
    update_data = {"status": status}
    if name:
        update_data["name"] = name
    supabase.table("campaign_recipients").update(update_data).eq("id", recipient_id).execute()


async def validate_recipients(client: TelegramClient):
    """Validate pending recipients - check if they exist on Telegram and get their names"""
    recipients = await get_validating_recipients()
    
    if not recipients:
        return
    
    print(f"\\n  📋 Validating {len(recipients)} recipients...")
    
    valid_count = 0
    invalid_count = 0
    
    for recipient in recipients:
        phone = recipient["phone_number"]
        
        exists, name, telegram_id = await validate_telegram_contact(client, phone)
        
        if exists:
            # Update to pending (ready to send) with auto-fetched name
            await update_recipient_validation(recipient["id"], "pending", name)
            valid_count += 1
        else:
            # Mark as invalid - not on Telegram
            await update_recipient_validation(recipient["id"], "invalid")
            invalid_count += 1
        
        # Small delay to avoid rate limiting
        await asyncio.sleep(0.5)
    
    print(f"  ✓ Validation complete: {valid_count} valid, {invalid_count} invalid")


async def update_message_status(message_id: str, status: str, error: str = None):
    """Update message status in database"""
    update_data = {"status": status}
    if status == "sent":
        update_data["delivered_at"] = datetime.now(timezone.utc).isoformat()
    if error:
        update_data["failed_reason"] = error
    supabase.table("messages").update(update_data).eq("id", message_id).execute()


async def update_campaign_recipient_status_by_id(campaign_recipient_id: str, status: str):
    """
    Update campaign recipient status directly using the campaign_recipient_id from the message.
    This is more reliable than phone number matching.
    """
    if not campaign_recipient_id:
        return
    
    try:
        # Get the campaign_id first for updating counts
        result = supabase.table("campaign_recipients").select("id, campaign_id").eq("id", campaign_recipient_id).single().execute()
        
        if result.data:
            recipient = result.data
            update_data = {"status": status}
            if status == "sent":
                update_data["sent_at"] = datetime.now(timezone.utc).isoformat()
            
            # Update the recipient status
            supabase.table("campaign_recipients").update(update_data).eq("id", campaign_recipient_id).execute()
            
            # Also update campaign sent_count or failed_count directly
            campaign_id = recipient["campaign_id"]
            try:
                campaign_result = supabase.table("campaigns").select("sent_count, failed_count").eq("id", campaign_id).single().execute()
                if campaign_result.data:
                    if status == "sent":
                        new_sent = (campaign_result.data.get("sent_count") or 0) + 1
                        supabase.table("campaigns").update({"sent_count": new_sent}).eq("id", campaign_id).execute()
                    elif status == "failed":
                        new_failed = (campaign_result.data.get("failed_count") or 0) + 1
                        supabase.table("campaigns").update({"failed_count": new_failed}).eq("id", campaign_id).execute()
            except Exception as count_err:
                print(f"    ⚠ Could not update campaign counts: {count_err}")
            
            print(f"    📊 Updated campaign recipient status: {status}")
    except Exception as e:
        print(f"    ⚠ Could not update campaign recipient: {e}")


async def update_campaign_recipient_status(phone_number: str, account_id: str, status: str):
    """
    Fallback: Update campaign recipient status by phone number matching.
    Used when campaign_recipient_id is not available on the message.
    """
    try:
        # Normalize phone number for matching (remove spaces, ensure + prefix)
        normalized_phone = phone_number.strip()
        if not normalized_phone.startswith('+') and not normalized_phone.startswith('@'):
            normalized_phone = '+' + normalized_phone
        
        # Find campaign recipients with this phone number assigned to this account
        result = supabase.table("campaign_recipients").select("id, campaign_id").eq(
            "phone_number", normalized_phone
        ).eq("sent_by_account_id", account_id).eq("status", "pending").limit(1).execute()
        
        if result.data and len(result.data) > 0:
            recipient = result.data[0]
            update_data = {"status": status}
            if status == "sent":
                update_data["sent_at"] = datetime.now(timezone.utc).isoformat()
            
            # Update the recipient status
            supabase.table("campaign_recipients").update(update_data).eq("id", recipient["id"]).execute()
            
            # Also update campaign sent_count or failed_count directly
            campaign_id = recipient["campaign_id"]
            try:
                campaign_result = supabase.table("campaigns").select("sent_count, failed_count").eq("id", campaign_id).single().execute()
                if campaign_result.data:
                    if status == "sent":
                        new_sent = (campaign_result.data.get("sent_count") or 0) + 1
                        supabase.table("campaigns").update({"sent_count": new_sent}).eq("id", campaign_id).execute()
                    elif status == "failed":
                        new_failed = (campaign_result.data.get("failed_count") or 0) + 1
                        supabase.table("campaigns").update({"failed_count": new_failed}).eq("id", campaign_id).execute()
            except Exception as count_err:
                print(f"    ⚠ Could not update campaign counts: {count_err}")
            
            print(f"    📊 Updated campaign recipient status: {status}")
    except Exception as e:
        print(f"    ⚠ Could not update campaign recipient: {e}")


async def increment_account_message_count(account_id: str):
    """Increment the messages_sent_today counter for an account"""
    global messages_sent_by_current
    
    if account_id in account_states:
        account_states[account_id].messages_sent_today += 1
        account_states[account_id].messages_sent_this_session += 1
        account_states[account_id].last_message_time = time.time()
        messages_sent_by_current += 1
        
        # Update in database too
        new_count = account_states[account_id].messages_sent_today
        supabase.table("telegram_accounts").update({
            "messages_sent_today": new_count,
            "last_active": datetime.now(timezone.utc).isoformat()
        }).eq("id", account_id).execute()


async def download_media(url: str) -> bytes:
    """Download media from URL"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, follow_redirects=True)
            response.raise_for_status()
            return response.content
    except Exception as e:
        print(f"    ⚠ Failed to download media: {e}")
        return None


async def upload_media_to_supabase(file_bytes: bytes, file_name: str, content_type: str) -> str:
    """Upload media to Supabase storage and return public URL"""
    try:
        import uuid
        unique_name = f"{uuid.uuid4()}_{file_name}"
        
        # Upload to Supabase storage
        result = supabase.storage.from_("message-attachments").upload(
            unique_name,
            file_bytes,
            {"content-type": content_type}
        )
        
        # Get public URL
        public_url = supabase.storage.from_("message-attachments").get_public_url(unique_name)
        return public_url
    except Exception as e:
        print(f"    ⚠ Failed to upload media: {e}")
        return None


async def save_incoming_message(account_id: str, sender_id: int, sender_name: str, sender_username: str, content: str, media_url: str = None, media_type: str = None):
    """Save incoming message to database"""
    try:
        # Find or create conversation
        phone_display = f"@{sender_username}" if sender_username else f"User {sender_id}"
        
        # Check if conversation exists - first by telegram_id, then by username
        conv_id = None
        conv = None
        
        # Try to find by telegram_id first
        result = supabase.table("conversations").select("*").eq("account_id", account_id).eq("recipient_telegram_id", sender_id).execute()
        
        if result.data and len(result.data) > 0:
            conv = result.data[0]
            conv_id = conv["id"]
        elif sender_username:
            # Try to find by username (for conversations created before we knew the telegram_id)
            username_search = f"@{sender_username}"
            result = supabase.table("conversations").select("*").eq("account_id", account_id).eq("recipient_username", username_search).execute()
            if result.data and len(result.data) > 0:
                conv = result.data[0]
                conv_id = conv["id"]
        
        if conv_id:
            # Update existing conversation with telegram_id and name if we have them
            update_data = {
                "last_message_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "unread_count": (conv.get("unread_count") or 0) + 1,
                "is_active": True
            }
            # Always update telegram_id if we have it (might be missing from original conversation)
            if sender_id:
                update_data["recipient_telegram_id"] = sender_id
            if sender_name:
                update_data["recipient_name"] = sender_name
            
            supabase.table("conversations").update(update_data).eq("id", conv_id).execute()
        else:
            # Create new conversation
            new_conv = supabase.table("conversations").insert({
                "account_id": account_id,
                "recipient_telegram_id": sender_id,
                "recipient_name": sender_name or phone_display,
                "recipient_username": f"@{sender_username}" if sender_username else None,
                "recipient_phone": phone_display,
                "is_active": True,
                "unread_count": 1,
                "last_message_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            conv_id = new_conv.data[0]["id"]
        
        # Save message with media if present
        message_data = {
            "account_id": account_id,
            "conversation_id": conv_id,
            "content": content,
            "direction": "incoming",
            "status": "delivered",
            "telegram_message_id": None,
            "delivered_at": datetime.now(timezone.utc).isoformat()
        }
        
        if media_url:
            message_data["media_url"] = media_url
            message_data["media_type"] = media_type
        
        supabase.table("messages").insert(message_data).execute()
        
        media_info = f" [with {media_type}]" if media_type else ""
        print(f"    📩 Saved incoming message from {sender_name or sender_username or sender_id}{media_info}")
        return True
    except Exception as e:
        print(f"    ⚠ Failed to save incoming message: {e}")
        return False


async def send_message(client: TelegramClient, recipient: str, content: str, media_url: str = None, media_type: str = None):
    """Send a message (with optional media) to a phone number or username"""
    try:
        # Handle username (starts with @) or phone number
        if recipient.startswith("@"):
            entity = await client.get_entity(recipient)
        else:
            # For phone numbers, we need to import as contact first
            from telethon.tl.functions.contacts import ImportContactsRequest, DeleteContactsRequest
            from telethon.tl.types import InputPhoneContact
            import random
            
            # Create a temporary contact
            contact = InputPhoneContact(
                client_id=random.randint(0, 2**31 - 1),
                phone=recipient,
                first_name="Contact",
                last_name=""
            )
            
            # Import the contact
            result = await client(ImportContactsRequest([contact]))
            
            if result.users:
                entity = result.users[0]
                # Optionally delete the contact after getting entity (to keep contacts clean)
                # await client(DeleteContactsRequest(id=[entity.id]))
            else:
                # User not found on Telegram
                return False, "PERMANENT: User not found - not on Telegram or privacy restricted"
        
        # Check if we need to send media
        if media_url and media_type == "image":
            print(f"    📷 Downloading image from {media_url[:50]}...")
            media_bytes = await download_media(media_url)
            
            if media_bytes:
                # Create a temporary file for the image
                import tempfile
                with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp_file:
                    tmp_file.write(media_bytes)
                    tmp_path = tmp_file.name
                
                try:
                    # Send with caption
                    await client.send_file(entity, tmp_path, caption=content if content else None)
                finally:
                    # Clean up temp file
                    os.unlink(tmp_path)
            else:
                # If media download failed, send text only
                if content:
                    await client.send_message(entity, content + "\\n\\n[Image could not be sent]")
                else:
                    return False, "Failed to download image"
        else:
            # Text only message
            await client.send_message(entity, content)
        
        return True, None
    except UserPrivacyRestrictedError:
        return False, "PERMANENT: User privacy settings prevent messaging"
    except UsernameNotOccupiedError:
        return False, "PERMANENT: Username not found on Telegram"
    except ValueError as e:
        # "Cannot find any entity corresponding to..." is a ValueError
        if "Cannot find any entity" in str(e):
            return False, "PERMANENT: User not found - not on Telegram or privacy restricted"
        return False, f"PERMANENT: {str(e)}"
    except FloodWaitError as e:
        return False, f"RATE_LIMITED: Wait {e.seconds} seconds"
    except Exception as e:
        error_str = str(e)
        # Mark as permanent if it's clearly not retryable
        if "banned" in error_str.lower() or "deactivated" in error_str.lower():
            return False, f"PERMANENT: {error_str}"
        return False, error_str


async def setup_message_handler(client: TelegramClient, account_id: str):
    """Set up handler for incoming messages"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip()
                sender_username = sender.username
                sender_id = sender.id
                
                # Check for media
                media_url = None
                media_type = None
                content = event.message.text or ""
                
                if event.message.photo:
                    # Download photo
                    print(f"    📷 Receiving photo from {sender_name or sender_username or sender_id}...")
                    photo_bytes = await client.download_media(event.message.photo, file=bytes)
                    if photo_bytes:
                        # Upload to Supabase storage
                        media_url = await upload_media_to_supabase(photo_bytes, "photo.jpg", "image/jpeg")
                        media_type = "image"
                        if not content:
                            content = "[Photo]"
                
                elif event.message.document:
                    # Check if it's an image document
                    doc = event.message.document
                    mime_type = doc.mime_type or ""
                    
                    if mime_type.startswith("image/"):
                        print(f"    📷 Receiving image from {sender_name or sender_username or sender_id}...")
                        doc_bytes = await client.download_media(event.message.document, file=bytes)
                        if doc_bytes:
                            ext = mime_type.split("/")[1] if "/" in mime_type else "jpg"
                            media_url = await upload_media_to_supabase(doc_bytes, f"image.{ext}", mime_type)
                            media_type = "image"
                            if not content:
                                content = "[Image]"
                    else:
                        # Other document types
                        content = content or f"[Document: {doc.mime_type}]"
                
                elif not content:
                    content = "[Media message]"
                
                await save_incoming_message(
                    account_id=account_id,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    sender_username=sender_username,
                    content=content,
                    media_url=media_url,
                    media_type=media_type
                )
        except Exception as e:
            print(f"    ⚠ Error handling incoming message: {e}")
    
    return handler


async def process_account(account: dict, messages: list):
    """Process messages for a single account with scheduling"""
    global current_account_id, messages_sent_by_current
    
    account_id = account["id"]
    session_path = account.get("_session_path")
    
    if not session_path:
        print(f"  ⚠ No session path for {account['phone_number']}")
        return
    
    api_id = TELEGRAM_API_ID
    api_hash = TELEGRAM_API_HASH
    
    if api_id == "YOUR_API_ID" or api_hash == "YOUR_API_HASH":
        print("  ⚠ Please set TELEGRAM_API_ID and TELEGRAM_API_HASH")
        return
    
    # Check if we already have an active client for this account
    client = active_clients.get(account_id)
    
    if not client:
        client = TelegramClient(session_path, int(api_id), api_hash)
        await client.connect()
        
        if not await client.is_user_authorized():
            print(f"  ⚠ Session expired for {account['phone_number']}")
            supabase.table("telegram_accounts").update({"status": "disconnected"}).eq("id", account_id).execute()
            if account_id in account_states:
                account_states[account_id].status = "disconnected"
            return
        
        # Set up incoming message handler
        await setup_message_handler(client, account_id)
        active_clients[account_id] = client
        print(f"  ✓ Connected and listening for messages")
    
    try:
        # Get account info and update in database
        me = await client.get_me()
        if me:
            update_data = {
                "status": "active",
                "last_active": datetime.now(timezone.utc).isoformat()
            }
            if me.first_name:
                update_data["first_name"] = me.first_name
            if me.last_name:
                update_data["last_name"] = me.last_name
            if me.username:
                update_data["username"] = me.username
            if me.id:
                update_data["telegram_id"] = me.id
            if me.phone:
                update_data["phone_number"] = f"+{me.phone}"
            
            # Try to get profile photo
            try:
                photos = await client.get_profile_photos(me, limit=1)
                if photos:
                    # Download the photo
                    import io
                    photo_bytes = await client.download_media(photos[0], file=bytes)
                    if photo_bytes:
                        photo_base64 = base64.b64encode(photo_bytes).decode('utf-8')
                        update_data["avatar_url"] = f"data:image/jpeg;base64,{photo_base64}"
            except Exception as photo_err:
                print(f"    Could not get profile photo: {photo_err}")
            
            supabase.table("telegram_accounts").update(update_data).eq("id", account_id).execute()
            display_name = me.first_name or me.username or me.phone
            
            # Show scheduling info
            if account_id in account_states:
                state = account_states[account_id]
                print(f"  ✓ {display_name} | {state.messages_sent_today}/{state.daily_limit} msgs | Priority: {calculate_account_priority(state):.1f}")
            else:
                print(f"  ✓ Connected as {display_name} (@{me.username or 'no username'})")
        
        # CRITICAL FIX: Filter messages to only process those belonging to THIS account
        # This ensures one contact = one account, no mixing of accounts per conversation
        account_messages = [m for m in messages if m.get("account_id") == account_id]
        
        if not account_messages:
            # No messages for this account
            return
        
        print(f"    📬 {len(account_messages)} message(s) for this account")
        
        # Check account limits
        if account_id in account_states:
            state = account_states[account_id]
            if state.messages_sent_today >= state.daily_limit:
                print(f"    ⚠ Daily limit reached for {account['phone_number']}")
                return
            
            # Check messages per account setting (only for NEW campaign recipients, not follow-ups)
            # Skip this check for follow-up messages in existing conversations
        
        # Process outgoing messages for THIS account only
        for msg in account_messages:
            conv = msg.get("conversations", {}) or {}
            # Support both phone number and username
            recipient = conv.get("recipient_username") or conv.get("recipient_phone")
            
            if not recipient:
                print(f"    ⚠ No recipient for message {msg['id']}")
                await update_message_status(msg["id"], "failed", "No recipient phone/username")
                continue
            
            # Verify message belongs to this account (double-check)
            if msg.get("account_id") != account_id:
                print(f"    ⚠ Skipping message {msg['id']} - belongs to different account")
                continue
            
            # Get media info from message
            media_url = msg.get("media_url")
            media_type = msg.get("media_type")
            
            if media_url:
                print(f"    → Sending image to {recipient} (account: {account['phone_number']})...")
            else:
                print(f"    → Sending to {recipient} (account: {account['phone_number']})...")
            
            success, error = await send_message(client, recipient, msg["content"], media_url, media_type)
            
            # Get campaign_recipient_id if this is a campaign message
            campaign_recipient_id = msg.get("campaign_recipient_id")
            
            if success:
                await update_message_status(msg["id"], "sent")
                await increment_account_message_count(account_id)
                # Update campaign recipient - prefer direct ID if available
                if campaign_recipient_id:
                    await update_campaign_recipient_status_by_id(campaign_recipient_id, "sent")
                else:
                    await update_campaign_recipient_status(recipient, account_id, "sent")
                print(f"    ✓ Sent from {account['phone_number']}!")
            else:
                await update_message_status(msg["id"], "failed", error)
                # Update campaign recipient - prefer direct ID if available
                if campaign_recipient_id:
                    await update_campaign_recipient_status_by_id(campaign_recipient_id, "failed")
                else:
                    await update_campaign_recipient_status(recipient, account_id, "failed")
                print(f"    ✗ Failed: {error}")
                
                # If rate limited, put account on cooldown
                if "RATE_LIMITED" in str(error):
                    put_account_on_cooldown(account_id)
            
            # Wait between messages (use scheduler setting)
            message_delay = scheduler_settings.message_interval if scheduler_settings.enabled else DEFAULT_MESSAGE_DELAY
            await asyncio.sleep(message_delay)
            
            # Only process one message per cycle to avoid spam detection
            break
    
    except Exception as e:
        print(f"  ⚠ Error processing account: {e}")
        # Remove from active clients on error
        if account_id in active_clients:
            del active_clients[account_id]
            await client.disconnect()


def print_scheduler_status():
    """Print current scheduler status"""
    if not scheduler_settings.enabled:
        print("  📋 Scheduler: DISABLED (using sequential mode)")
        return
    
    print(f"  📋 Scheduler: ENABLED")
    print(f"     • Rotation after: {scheduler_settings.max_messages_before_rotation} messages")
    print(f"     • Cooldown: {scheduler_settings.cooldown_duration} minutes")
    print(f"     • Messages/account: {scheduler_settings.messages_per_account}")
    print(f"     • Message interval: {scheduler_settings.message_interval}s")
    
    # Show account statuses
    if account_states:
        print(f"     • Accounts:")
        now = time.time()
        for acc_id, state in account_states.items():
            status_icon = "✓" if state.status == "active" else "✗"
            cooldown_info = ""
            if now < state.cooldown_until:
                remaining = int((state.cooldown_until - now) / 60)
                cooldown_info = f" (cooldown: {remaining}m)"
            priority = calculate_account_priority(state)
            active = " 👈 ACTIVE" if acc_id == current_account_id else ""
            print(f"       {status_icon} {state.phone_number}: {state.messages_sent_today}/{state.daily_limit} msgs, priority: {priority:.0f}{cooldown_info}{active}")


async def get_live_conversations() -> Set[str]:
    """
    Get conversation IDs that are 'live' (have incoming messages in last 5 minutes).
    A conversation is live when the customer has replied recently.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=LIVE_CONVERSATION_TIMEOUT)
    
    # Get conversations with recent incoming messages
    result = supabase.table("messages").select(
        "conversation_id"
    ).eq("direction", "incoming").gte(
        "created_at", cutoff.isoformat()
    ).execute()
    
    return set(msg["conversation_id"] for msg in (result.data or []))


async def get_live_pending_messages(live_conv_ids: Set[str]):
    """Get pending messages ONLY for live conversations (fast send)"""
    if not live_conv_ids:
        return []
    
    result = supabase.table("messages").select(
        "*, conversations(*)"
    ).eq("status", "pending").eq("direction", "outgoing").execute()
    
    # Filter to only live conversations (live chats don't need campaign_recipient_id check)
    return [
        msg for msg in (result.data or [])
        if msg.get("conversation_id") in live_conv_ids
    ]


async def get_campaign_pending_messages(live_conv_ids: Set[str]):
    """Get pending messages for NON-live conversations (campaign mode)"""
    result = supabase.table("messages").select(
        "*, conversations(*), campaign_recipients(campaign_id)"
    ).eq("status", "pending").eq("direction", "outgoing").limit(50).execute()
    
    valid_messages = []
    for msg in (result.data or []):
        # Skip live conversations (handled by live loop)
        if msg.get("conversation_id") in live_conv_ids:
            continue
        
        # Skip orphaned campaign messages (campaign was deleted)
        campaign_recipient_id = msg.get("campaign_recipient_id")
        if not campaign_recipient_id:
            # No campaign link - check if it's an orphaned first-contact message
            if is_orphaned_campaign_message(msg):
                print(f"    ⚠️ Skipping orphaned message {msg['id'][:8]} (campaign deleted)")
                continue
        else:
            # Has campaign_recipient_id - verify campaign still exists
            campaign_recipient = msg.get("campaign_recipients")
            if not campaign_recipient or not campaign_recipient.get("campaign_id"):
                print(f"    ⚠️ Skipping message {msg['id'][:8]} (campaign recipient deleted)")
                continue
        
        valid_messages.append(msg)
    
    return valid_messages


async def live_chat_loop():
    """
    Fast loop for live conversations - checks every 1-2 seconds.
    Used when customer has replied and we need instant message delivery.
    """
    print("\\n🚀 Live Chat Mode: Checking every 1-2 seconds for active chats...")
    
    while True:
        try:
            live_conv_ids = await get_live_conversations()
            
            if live_conv_ids:
                messages = await get_live_pending_messages(live_conv_ids)
                
                if messages:
                    print(f"\\n⚡ Live: {len(messages)} message(s) to send immediately")
                    
                    for msg in messages:
                        conv = msg.get("conversations", {}) or {}
                        account_id = msg.get("account_id")
                        
                        if account_id and account_id in active_clients:
                            client = active_clients[account_id]
                            recipient = conv.get("recipient_username") or conv.get("recipient_phone")
                            
                            if not recipient:
                                await update_message_status(msg["id"], "failed", "No recipient")
                                continue
                            
                            media_url = msg.get("media_url")
                            media_type = msg.get("media_type")
                            
                            success, error = await send_message(
                                client, recipient, msg["content"], media_url, media_type
                            )
                            
                            # Get campaign_recipient_id if this is a campaign message
                            campaign_recipient_id = msg.get("campaign_recipient_id")
                            
                            if success:
                                await update_message_status(msg["id"], "sent")
                                await increment_account_message_count(account_id)
                                # Update campaign recipient if available
                                if campaign_recipient_id:
                                    await update_campaign_recipient_status_by_id(campaign_recipient_id, "sent")
                                print(f"    ⚡ Sent instantly to {recipient}")
                            else:
                                await update_message_status(msg["id"], "failed", error)
                                # Update campaign recipient if available
                                if campaign_recipient_id:
                                    await update_campaign_recipient_status_by_id(campaign_recipient_id, "failed")
                                print(f"    ✗ Failed: {error}")
                        else:
                            # Account not connected, mark as pending for later
                            pass
            
            await asyncio.sleep(LIVE_CHAT_CHECK_INTERVAL)
        except Exception as e:
            print(f"  ⚠ Live chat error: {e}")
            await asyncio.sleep(2)


async def campaign_loop():
    """
    Slower loop for campaign/first-contact messages.
    Uses account rotation, cooldowns, and controlled intervals.
    """
    global current_account_id, messages_sent_by_current
    
    print("\\n📢 Campaign Mode: Using configured intervals for first-contact messages...")
    
    while True:
        try:
            # Get live conversations to exclude
            live_conv_ids = await get_live_conversations()
            
            # Get only non-live pending messages
            campaign_messages = await get_campaign_pending_messages(live_conv_ids)
            validating_recipients = await get_validating_recipients()
            
            accounts = await load_accounts()
            
            if campaign_messages or validating_recipients:
                print(f"\\n[{datetime.now().strftime('%H:%M:%S')}] Campaign check...")
                print(f"  Campaign messages: {len(campaign_messages)} (excluding {len(live_conv_ids)} live convs)")
                print(f"  Recipients to validate: {len(validating_recipients)}")
                
                print_scheduler_status()
                
                # Initialize current account if needed
                if scheduler_settings.enabled and (current_account_id is None or should_rotate_account()):
                    new_account = rotate_account()
                    if not new_account and campaign_messages:
                        print("  ⚠ No accounts available!")
                        await asyncio.sleep(60)
                        continue
                
                # Process each account IN PARALLEL for speed
                tasks = []
                for account in accounts:
                    # Validate recipients using first available account
                    if validating_recipients and account["id"] in active_clients:
                        client = active_clients[account["id"]]
                        await validate_recipients(client)
                        validating_recipients = []
                    
                    # Process campaign messages for this account (parallel)
                    tasks.append(process_account(account, campaign_messages))
                
                # Run all account processing in parallel
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
            
            await asyncio.sleep(CAMPAIGN_CHECK_INTERVAL)
        except Exception as e:
            print(f"  ⚠ Campaign error: {e}")
            await asyncio.sleep(5)


async def initialize_clients():
    """Initialize all Telegram clients and set up message handlers"""
    print("\\n📱 Initializing Telegram clients...")
    
    accounts = await load_accounts()
    
    for account in accounts:
        account_id = account["id"]
        session_path = account.get("_session_path")
        
        if not session_path:
            continue
        
        if account_id in active_clients:
            continue
        
        try:
            client = TelegramClient(session_path, int(TELEGRAM_API_ID), TELEGRAM_API_HASH)
            await client.connect()
            
            if not await client.is_user_authorized():
                print(f"  ⚠ Session expired for {account['phone_number']}")
                supabase.table("telegram_accounts").update({"status": "disconnected"}).eq("id", account_id).execute()
                continue
            
            # Set up incoming message handler
            await setup_message_handler(client, account_id)
            active_clients[account_id] = client
            
            # Get and update account info
            me = await client.get_me()
            if me:
                update_data = {
                    "status": "active",
                    "last_active": datetime.now(timezone.utc).isoformat()
                }
                if me.first_name:
                    update_data["first_name"] = me.first_name
                if me.last_name:
                    update_data["last_name"] = me.last_name
                if me.username:
                    update_data["username"] = me.username
                if me.id:
                    update_data["telegram_id"] = me.id
                if me.phone:
                    update_data["phone_number"] = f"+{me.phone}"
                
                supabase.table("telegram_accounts").update(update_data).eq("id", account_id).execute()
                
                display_name = me.first_name or me.username or me.phone
                print(f"  ✓ {display_name} connected and listening")
        except Exception as e:
            print(f"  ⚠ Failed to connect {account['phone_number']}: {e}")
    
    print(f"  Total clients: {len(active_clients)}")


async def spambot_check_loop():
    """
    Process queued SpamBot check tasks.
    Sends /start to @SpamBot and parses response to determine account status.
    """
    print("\\n🤖 SpamBot Check Loop: Monitoring for check tasks...")
    
    while True:
        try:
            # Fetch pending check tasks
            result = supabase.table("account_check_tasks").select(
                "*, telegram_accounts(*)"
            ).eq("status", "pending").eq("task_type", "spambot_check").limit(10).execute()
            
            tasks = result.data or []
            
            for task in tasks:
                account_id = task["account_id"]
                task_id = task["id"]
                account_data = task.get("telegram_accounts", {})
                phone = account_data.get("phone_number", "Unknown")
                
                # Check 96-hour cooldown - skip if already checked within 96 hours
                last_check = account_data.get("last_spambot_check")
                if last_check:
                    try:
                        last_check_dt = datetime.fromisoformat(last_check.replace('Z', '+00:00'))
                        hours_since_check = (datetime.now(timezone.utc) - last_check_dt).total_seconds() / 3600
                        if hours_since_check < 96:
                            print(f"  ⏭ Skipping {phone}: Checked {hours_since_check:.1f} hours ago (cooldown: 96h)")
                            supabase.table("account_check_tasks").update({
                                "status": "skipped",
                                "result": f"Already checked {hours_since_check:.1f} hours ago. Cooldown is 96 hours.",
                                "completed_at": datetime.now(timezone.utc).isoformat()
                            }).eq("id", task_id).execute()
                            continue
                    except Exception as parse_err:
                        print(f"  ⚠ Could not parse last_spambot_check date: {parse_err}")
                
                # Check if we have an active client for this account
                if account_id not in active_clients:
                    supabase.table("account_check_tasks").update({
                        "status": "failed",
                        "result": "Account not connected. Run the script to connect accounts first.",
                        "completed_at": datetime.now(timezone.utc).isoformat()
                    }).eq("id", task_id).execute()
                    continue
                
                client = active_clients[account_id]
                
                print(f"  🔍 Checking @SpamBot for {phone}...")
                
                # Update task to processing
                supabase.table("account_check_tasks").update({
                    "status": "processing"
                }).eq("id", task_id).execute()
                
                try:
                    # Get SpamBot entity
                    spambot = await client.get_entity("@SpamBot")
                    
                    # Send /start
                    await client.send_message(spambot, "/start")
                    
                    # Wait for response
                    await asyncio.sleep(3)
                    
                    # Get last message from SpamBot
                    messages = await client.get_messages(spambot, limit=1)
                    response_text = messages[0].text if messages else "No response from SpamBot"
                    
                    # Parse response to determine status
                    response_lower = response_text.lower()
                    new_status = "active"
                    ban_reason = None
                    restricted_until = None
                    
                    if "no limits" in response_lower or "good news" in response_lower or "free to message" in response_lower:
                        new_status = "active"
                        print(f"    ✓ {phone}: No limits!")
                    elif "limited" in response_lower or "restricted" in response_lower:
                        new_status = "restricted"
                        # Try to extract time info
                        import re
                        time_match = re.search(r'(\\d+)\\s*(hour|day|minute)', response_lower)
                        if time_match:
                            amount = int(time_match.group(1))
                            unit = time_match.group(2)
                            if unit == "hour":
                                restricted_until = (datetime.now(timezone.utc) + timedelta(hours=amount)).isoformat()
                            elif unit == "day":
                                restricted_until = (datetime.now(timezone.utc) + timedelta(days=amount)).isoformat()
                            elif unit == "minute":
                                restricted_until = (datetime.now(timezone.utc) + timedelta(minutes=amount)).isoformat()
                        print(f"    ⚠ {phone}: Restricted!")
                    elif "banned" in response_lower or "cannot send" in response_lower:
                        new_status = "banned"
                        ban_reason = response_text[:200]
                        print(f"    ✗ {phone}: Banned!")
                    else:
                        print(f"    ? {phone}: Unknown response")
                    
                    # Update account status in database (including last_spambot_check timestamp)
                    update_data = {
                        "status": new_status,
                        "last_spambot_check": datetime.now(timezone.utc).isoformat()
                    }
                    if ban_reason:
                        update_data["ban_reason"] = ban_reason
                    if restricted_until:
                        update_data["restricted_until"] = restricted_until
                    
                    supabase.table("telegram_accounts").update(update_data).eq("id", account_id).execute()
                    
                    # Update account state
                    if account_id in account_states:
                        account_states[account_id].status = new_status
                    
                    # Mark task completed
                    supabase.table("account_check_tasks").update({
                        "status": "completed",
                        "result": response_text[:500],
                        "completed_at": datetime.now(timezone.utc).isoformat()
                    }).eq("id", task_id).execute()
                    
                except Exception as e:
                    error_msg = str(e)[:500]
                    print(f"    ✗ Error checking {phone}: {error_msg}")
                    supabase.table("account_check_tasks").update({
                        "status": "failed",
                        "result": error_msg,
                        "completed_at": datetime.now(timezone.utc).isoformat()
                    }).eq("id", task_id).execute()
                
                # Randomized delay between checks (3-8 seconds) to appear more human-like
                import random
                await asyncio.sleep(random.uniform(3, 8))
            
            # Wait before checking for more tasks
            await asyncio.sleep(5)
        except Exception as e:
            print(f"  ⚠ SpamBot check error: {e}")
            await asyncio.sleep(5)


async def main():
    """Main entry point - runs Campaign, Live Chat, and SpamBot check loops in parallel"""
    print("=" * 70)
    print("  TelegramCRM - DUAL MODE Message Sender & Receiver")
    print("=" * 70)
    print("  • Campaign Mode: Controlled intervals for first-contact messages")
    print("  • Live Chat Mode: Instant delivery (1-2s) for active conversations")
    print("  • SpamBot Check: Monitors for account restriction check tasks")
    print(f"  • Session folder: {SESSION_FOLDER}")
    print("=" * 70)
    
    # Load scheduler settings
    load_scheduler_settings()
    
    # Initialize all clients first
    await initialize_clients()
    
    if not active_clients:
        print("\\n❌ No active clients! Please check your session files.")
        return
    
    print("\\n✓ Starting triple-mode operation...")
    
    # Run ALL loops in parallel
    await asyncio.gather(
        live_chat_loop(),       # Fast - every 1-2 seconds for live chats
        campaign_loop(),        # Slow - with rotation/delays for campaigns
        spambot_check_loop()    # SpamBot restriction checks
    )


async def shutdown():
    """Cleanup on shutdown"""
    print("\\nShutting down...")
    for account_id, client in active_clients.items():
        await client.disconnect()
    print("Disconnected all clients.")


if __name__ == "__main__":
    print("Starting DUAL-MODE sender & receiver... Press Ctrl+C to stop.")
    print("Required: pip install telethon supabase httpx")
    print("")
    print("MODES:")
    print("  📢 Campaign: First-contact messages with rotation & intervals")
    print("  ⚡ Live Chat: Instant delivery when customer has replied")
    print("")
    print("TIP: Create 'scheduler_settings.json' with your campaign settings:")
    print('  {"enabled": true, "maxMessagesBeforeRotation": 5, "cooldownDuration": 30, ...}')
    try:
        asyncio.run(main())
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
