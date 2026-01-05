#!/usr/bin/env python3
"""
TelegramCRM - Live Chat Receiver
=================================
Dedicated to receiving incoming messages with image/link support.
Loads accounts with proxies and fingerprints, connects in parallel.

Run: python live_chat_receiver.py
Stop: Ctrl+C
"""

import asyncio
import signal
import base64
import time
import re

import httpx
from telethon import events
from telethon.tl.types import User

from client_manager import (
    get_or_create_client, get_next_task, report_result, shutdown_all
)
from config import SUPABASE_URL, SUPABASE_KEY
from urllib.parse import urlparse

# Ensure we always get the *origin* (e.g. https://xxxx.supabase.co)
_u = urlparse(SUPABASE_URL)
SUPABASE_URL_BASE = f"{_u.scheme}://{_u.netloc}" if _u.scheme and _u.netloc else SUPABASE_URL.rstrip("/")

# ========== GLOBAL STATE ==========
RUNNING = True

# Cache conversation existence results to avoid repeated REST calls
NEGATIVE_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60  # 1 year = permanent
POSITIVE_CACHE_TTL_SECONDS = 6 * 60 * 60         # 6h: re-check campaign contacts occasionally
_conversation_cache = {}


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def _cache_get(account_id: str, sender_id: int):
    key = (account_id, int(sender_id))
    val = _conversation_cache.get(key)
    if not val:
        return None
    exists, ts = val
    ttl = POSITIVE_CACHE_TTL_SECONDS if exists else NEGATIVE_CACHE_TTL_SECONDS
    if (time.time() - ts) > ttl:
        _conversation_cache.pop(key, None)
        return None
    return exists


def _cache_set(account_id: str, sender_id: int, exists: bool):
    _conversation_cache[(account_id, int(sender_id))] = (bool(exists), time.time())


async def check_conversation_exists(account_id: str, sender_id: int, sender_username: str = None, sender_phone: str = None) -> bool:
    """
    Multi-strategy matching: telegram_id -> username -> phone
    Checks if we have an existing campaign conversation with this sender.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            # Strategy 1: Match by telegram_id (fastest)
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
                digits = re.sub(r'\D', '', sender_phone)
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
        print(f"    ⚠ Check conversation error: {e}")
        return False


async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages - ONLY for campaign-initiated conversations"""
    
    # Rate-limited ignored log
    _ignored_log = {}
    
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if not sender:
                return
            
            # Skip channel/group messages - only handle private chats
            if not isinstance(sender, User):
                return

            # Skip bots
            if getattr(sender, 'bot', False):
                return

            # Get sender info
            first_name = getattr(sender, 'first_name', None) or ''
            last_name = getattr(sender, 'last_name', None) or ''
            sender_name = f"{first_name} {last_name}".strip() or str(sender.id)
            sender_username = getattr(sender, 'username', None)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone

            # Check cache first
            cached_exists = _cache_get(account_id, sender.id)
            if cached_exists is None:
                conversation_exists = await check_conversation_exists(
                    account_id, sender.id, sender_username, sender_phone
                )
                _cache_set(account_id, sender.id, conversation_exists)
                cached_exists = conversation_exists

            if not cached_exists:
                # Rate-limited logging for ignored messages
                now = time.time()
                if sender.id not in _ignored_log or (now - _ignored_log[sender.id]) > 60:
                    _ignored_log[sender.id] = now
                    print(f"    [IGNORED] {sender_name} (id={sender.id}): no campaign conversation")
                return
            
            content = event.message.text or "[Media]"
            media_url = None
            media_type = None
            
            # Handle photos - download and upload to Supabase storage
            if event.message.photo:
                print(f"    📷 Receiving photo from {sender_name}...")
                content = "[Photo] " + (event.message.text or "")
                media_type = "image"
                
                try:
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        
                        mime_type = "image/jpeg"
                        if hasattr(event.message, 'file') and event.message.file:
                            mime_type = getattr(event.message.file, 'mime_type', None) or "image/jpeg"
                        
                        async with httpx.AsyncClient(timeout=30.0) as http:
                            upload_response = await http.put(
                                f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{file_path}",
                                headers={
                                    "apikey": SUPABASE_KEY,
                                    "Authorization": f"Bearer {SUPABASE_KEY}",
                                    "Content-Type": mime_type,
                                    "x-upsert": "true"
                                },
                                content=photo_bytes
                            )
                            
                            if upload_response.status_code in (200, 201):
                                media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{file_path}"
                                print(f"    ✓ Photo uploaded: {file_name}")
                            else:
                                error_text = upload_response.text[:300] if upload_response.text else "No details"
                                print(f"    ⚠ Photo upload failed: {upload_response.status_code} - {error_text}")
                except Exception as e:
                    print(f"    ⚠ Could not upload photo: {e}")
            
            # Handle documents/files
            elif event.message.document:
                print(f"    📎 Receiving document from {sender_name}...")
                content = "[Document] " + (event.message.text or "")
                media_type = "document"
                
                try:
                    doc_bytes = await client.download_media(event.message.document, bytes)
                    if doc_bytes:
                        # Get original filename if available
                        original_name = "document"
                        if hasattr(event.message.document, 'attributes'):
                            for attr in event.message.document.attributes:
                                if hasattr(attr, 'file_name'):
                                    original_name = attr.file_name
                                    break
                        
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}_{original_name}"
                        file_path = f"{account_id}/{file_name}"
                        
                        mime_type = getattr(event.message.document, 'mime_type', None) or "application/octet-stream"
                        
                        async with httpx.AsyncClient(timeout=60.0) as http:
                            upload_response = await http.put(
                                f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{file_path}",
                                headers={
                                    "apikey": SUPABASE_KEY,
                                    "Authorization": f"Bearer {SUPABASE_KEY}",
                                    "Content-Type": mime_type,
                                    "x-upsert": "true"
                                },
                                content=doc_bytes
                            )
                            
                            if upload_response.status_code in (200, 201):
                                media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{file_path}"
                                print(f"    ✓ Document uploaded: {file_name}")
                            else:
                                print(f"    ⚠ Document upload failed: {upload_response.status_code}")
                except Exception as e:
                    print(f"    ⚠ Could not upload document: {e}")
            
            # Get profile photo
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
            except:
                pass
            
            print(f"  📥 [IN] From {sender_name}: {content[:50]}...")
            
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": sender_name,
                "sender_username": sender_username,
                "sender_phone": sender_phone,
                "sender_avatar": avatar_base64,
                "content": content,
                "media_url": media_url,
                "media_type": media_type
            })
        except Exception as e:
            print(f"    ⚠ Handler error: {e}")


async def main_loop():
    """Main receiver loop - ONLY handles incoming messages"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Live Chat Receiver")
    print("=" * 60)
    print("  📥 Handles: Incoming messages, photos, documents, links")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting live chat receiver...\n")
    
    connected_ids = set()
    
    while RUNNING:
        try:
            # Get accounts for listening - NO send tasks
            task = await get_next_task(runner="livechat_receiver")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                # Only connect NEW accounts
                new_accounts = [acc for acc in accounts if acc.get("id") not in connected_ids]
                
                if new_accounts:
                    print(f"  📡 Connecting {len(new_accounts)} new account(s)...")
                    # Connect in parallel using proxy and fingerprint from task
                    results = await asyncio.gather(
                        *[get_or_create_client(acc, setup_handler=setup_message_handler) for acc in new_accounts],
                        return_exceptions=True
                    )
                    for acc in new_accounts:
                        if acc.get("id"):
                            connected_ids.add(acc["id"])
                    
                    success_count = sum(1 for r in results if r and not isinstance(r, Exception))
                    print(f"  ✓ Connected: {success_count}/{len(new_accounts)} accounts")
                
                # Fast polling for incoming messages
                await asyncio.sleep(0.05)
            else:
                # Receiver should only get "wait" tasks
                await asyncio.sleep(0.05)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(0.1)
    
    print("\n⏹ Live chat receiver stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Live Chat Receiver... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx pysocks")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
