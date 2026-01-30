"""
Incoming Message Handler for Telegram Runner
=============================================

This module handles:
1. Real-time incoming message listening via Telethon event handlers
2. Unread message sync on startup
3. Reporting all incoming messages to the backend

Integration Steps:
1. Import this module in your unified_runner.py
2. Call setup_incoming_handlers(client, account_id) after connecting each account
3. Call sync_unread_messages(client, account_id) on startup for each account

Required environment variables:
- SUPABASE_URL
- SUPABASE_ANON_KEY
"""

import os
import base64
import logging
from datetime import datetime, timedelta
from typing import Optional
import aiohttp
from telethon import events
from telethon.tl.types import MessageMediaPhoto, MessageMediaDocument

# Configure logging
logger = logging.getLogger(__name__)

# Get environment variables
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")

# Track which accounts have handlers registered (to avoid duplicates)
_registered_handlers = set()


def get_media_type(media) -> Optional[str]:
    """Determine the type of media attached to a message."""
    if media is None:
        return None
    if isinstance(media, MessageMediaPhoto):
        return "image"
    if isinstance(media, MessageMediaDocument):
        doc = media.document
        if doc:
            mime = getattr(doc, 'mime_type', '') or ''
            if mime.startswith('image/'):
                return "image"
            elif mime.startswith('video/'):
                return "video"
            elif mime.startswith('audio/'):
                return "audio"
            else:
                return "document"
    return "unknown"


async def get_media_base64(client, message) -> Optional[str]:
    """Download media and convert to base64 string."""
    try:
        if not message.media:
            return None
        
        # Download to bytes
        media_bytes = await client.download_media(message, bytes)
        if not media_bytes:
            return None
        
        # Convert to base64
        b64_data = base64.b64encode(media_bytes).decode('utf-8')
        
        # Determine mime type for data URI
        media_type = get_media_type(message.media)
        if media_type == "image":
            mime = "image/jpeg"  # Default, could be improved
        elif media_type == "video":
            mime = "video/mp4"
        elif media_type == "audio":
            mime = "audio/mpeg"
        else:
            mime = "application/octet-stream"
        
        return f"data:{mime};base64,{b64_data}"
    except Exception as e:
        logger.error(f"Failed to download media: {e}")
        return None


async def report_incoming_message(
    account_id: str,
    sender_id: int,
    sender_phone: Optional[str],
    sender_name: Optional[str],
    sender_username: Optional[str],
    content: str,
    telegram_message_id: int,
    media_url: Optional[str] = None,
    media_type: Optional[str] = None
):
    """Send incoming message report to the backend."""
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        logger.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables")
        return False
    
    payload = {
        "task_type": "incoming",
        "result": {
            "account_id": str(account_id),
            "sender_id": sender_id,
            "sender_phone": sender_phone,
            "sender_name": sender_name,
            "sender_username": sender_username,
            "content": content,
            "telegram_message_id": telegram_message_id,
        }
    }
    
    # Add media if present
    if media_url:
        payload["result"]["media_url"] = media_url
        payload["result"]["media_type"] = media_type
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{SUPABASE_URL}/functions/v1/runner-tasks/report",
                json=payload,
                headers={
                    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                    "Content-Type": "application/json"
                },
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                if response.status == 200:
                    logger.info(f"[incoming] Reported message from {sender_id} to account {account_id}")
                    return True
                else:
                    text = await response.text()
                    logger.error(f"[incoming] Failed to report: {response.status} - {text}")
                    return False
    except Exception as e:
        logger.error(f"[incoming] Error reporting message: {e}")
        return False


def setup_incoming_handlers(client, account_id: str, account_phone: str):
    """
    Register event handlers for incoming messages on a Telethon client.
    
    Call this after connecting each account.
    
    Args:
        client: Connected Telethon client
        account_id: UUID of the telegram_accounts record
        account_phone: Phone number (for logging)
    """
    # Avoid registering duplicate handlers
    handler_key = f"{account_id}:{id(client)}"
    if handler_key in _registered_handlers:
        logger.debug(f"Handler already registered for account {account_phone}")
        return
    
    @client.on(events.NewMessage(incoming=True))
    async def handle_incoming_message(event):
        """Handle all incoming private messages."""
        try:
            # Only process private messages (DMs), not groups/channels
            if not event.is_private:
                return
            
            # Get sender information
            sender = await event.get_sender()
            if not sender:
                logger.warning(f"Could not get sender for message {event.message.id}")
                return
            
            # Skip bots
            if getattr(sender, 'bot', False):
                return
            
            # Extract message content
            content = event.message.text or ""
            if not content and event.message.media:
                content = "[Media]"
            
            # Get media if present
            media_url = None
            media_type = None
            if event.message.media:
                media_type = get_media_type(event.message.media)
                # Only download images (to save bandwidth/time)
                if media_type == "image":
                    media_url = await get_media_base64(client, event.message)
            
            # Report to backend
            await report_incoming_message(
                account_id=account_id,
                sender_id=sender.id,
                sender_phone=getattr(sender, 'phone', None),
                sender_name=getattr(sender, 'first_name', None),
                sender_username=getattr(sender, 'username', None),
                content=content,
                telegram_message_id=event.message.id,
                media_url=media_url,
                media_type=media_type
            )
            
            # Optionally mark as read on Telegram
            try:
                await event.message.mark_read()
            except Exception as e:
                logger.debug(f"Could not mark message as read: {e}")
                
        except Exception as e:
            logger.error(f"Error handling incoming message: {e}", exc_info=True)
    
    _registered_handlers.add(handler_key)
    logger.info(f"[incoming] Registered handler for account {account_phone}")


async def sync_unread_messages(client, account_id: str, account_phone: str, max_dialogs: int = 100, max_hours: int = 24):
    """
    Scan dialogs for unread messages and report them to the backend.
    
    Call this on runner startup for each connected account.
    
    Args:
        client: Connected Telethon client
        account_id: UUID of the telegram_accounts record
        account_phone: Phone number (for logging)
        max_dialogs: Maximum number of dialogs to scan
        max_hours: Only sync messages from the last N hours
    """
    logger.info(f"[sync] Starting unread sync for account {account_phone}")
    
    cutoff_time = datetime.utcnow() - timedelta(hours=max_hours)
    synced_count = 0
    
    try:
        async for dialog in client.iter_dialogs(limit=max_dialogs):
            # Only private chats with unread messages
            if not dialog.is_user:
                continue
            if dialog.unread_count == 0:
                continue
            
            # Skip bots
            if getattr(dialog.entity, 'bot', False):
                continue
            
            logger.debug(f"[sync] Dialog with {dialog.name}: {dialog.unread_count} unread")
            
            # Get unread messages (limit to prevent overload)
            messages_to_sync = min(dialog.unread_count, 50)
            
            async for message in client.iter_messages(
                dialog.entity,
                limit=messages_to_sync
            ):
                # Skip our own messages
                if message.out:
                    continue
                
                # Skip messages older than cutoff
                if message.date.replace(tzinfo=None) < cutoff_time:
                    break
                
                # Extract content
                content = message.text or ""
                if not content and message.media:
                    content = "[Media]"
                
                # Get media if present (only images)
                media_url = None
                media_type = None
                if message.media:
                    media_type = get_media_type(message.media)
                    if media_type == "image":
                        media_url = await get_media_base64(client, message)
                
                # Report to backend
                success = await report_incoming_message(
                    account_id=account_id,
                    sender_id=dialog.entity.id,
                    sender_phone=getattr(dialog.entity, 'phone', None),
                    sender_name=getattr(dialog.entity, 'first_name', None),
                    sender_username=getattr(dialog.entity, 'username', None),
                    content=content,
                    telegram_message_id=message.id,
                    media_url=media_url,
                    media_type=media_type
                )
                
                if success:
                    synced_count += 1
            
            # Mark dialog as read after syncing
            try:
                await client.send_read_acknowledge(dialog.entity)
            except Exception as e:
                logger.debug(f"Could not mark dialog as read: {e}")
    
    except Exception as e:
        logger.error(f"[sync] Error during unread sync: {e}", exc_info=True)
    
    logger.info(f"[sync] Completed for account {account_phone}: synced {synced_count} messages")
    return synced_count


# ============================================================================
# INTEGRATION EXAMPLE
# ============================================================================
#
# In your unified_runner.py, add:
#
# from incoming_handler import setup_incoming_handlers, sync_unread_messages
#
# async def connect_account(account):
#     client = TelegramClient(...)
#     await client.connect()
#     
#     # After successful connection:
#     setup_incoming_handlers(client, account['id'], account['phone_number'])
#     await sync_unread_messages(client, account['id'], account['phone_number'])
#     
#     return client
#
# ============================================================================
