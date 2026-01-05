#!/usr/bin/env python3
"""
LiveChat Receiver - Incoming messages handler
Handles: Incoming DMs, photos, documents
Only processes PRIVATE chats (not groups/channels)
"""
import asyncio
import signal
import base64
import time
import re
import io

import httpx
from telethon import events
from telethon.tl.types import User, PeerUser

from client_manager import (
    get_or_create_client, get_next_task, report_result, shutdown_all, get_http_client
)
from config import SUPABASE_URL, SUPABASE_KEY
from urllib.parse import urlparse

_u = urlparse(SUPABASE_URL)
SUPABASE_URL_BASE = f"{_u.scheme}://{_u.netloc}" if _u.scheme and _u.netloc else SUPABASE_URL.rstrip("/")

RUNNING = True
NEGATIVE_CACHE_TTL = 365 * 24 * 60 * 60
POSITIVE_CACHE_TTL = 6 * 60 * 60
_conversation_cache = {}

def signal_handler(sig, frame):
    global RUNNING
    print("\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def _cache_get(account_id, sender_id):
    key = (account_id, int(sender_id))
    val = _conversation_cache.get(key)
    if not val:
        return None
    exists, ts = val
    ttl = POSITIVE_CACHE_TTL if exists else NEGATIVE_CACHE_TTL
    if (time.time() - ts) > ttl:
        _conversation_cache.pop(key, None)
        return None
    return exists


def _cache_set(account_id, sender_id, exists):
    _conversation_cache[(account_id, int(sender_id))] = (bool(exists), time.time())


async def check_conversation_exists(account_id, sender_id, sender_username=None, sender_phone=None):
    try:
        http = await get_http_client()
        response = await http.get(
            f"{SUPABASE_URL_BASE}/rest/v1/conversations",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            params={"account_id": f"eq.{account_id}", "recipient_telegram_id": f"eq.{sender_id}", "first_message_sent": "eq.true", "select": "id"}
        )
        if response.status_code == 200 and response.json():
            return True
        if sender_username:
            for variant in [f"@{sender_username.lstrip('@').lower()}", sender_username.lstrip('@').lower()]:
                response = await http.get(f"{SUPABASE_URL_BASE}/rest/v1/conversations", headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}, params={"account_id": f"eq.{account_id}", "recipient_username": f"ilike.{variant}", "first_message_sent": "eq.true", "select": "id"})
                if response.status_code == 200 and response.json():
                    return True
        if sender_phone:
            digits = re.sub(r'\D', '', sender_phone)
            for pv in [f"+{digits}", digits, sender_phone]:
                response = await http.get(f"{SUPABASE_URL_BASE}/rest/v1/conversations", headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}, params={"account_id": f"eq.{account_id}", "recipient_phone": f"eq.{pv}", "first_message_sent": "eq.true", "select": "id"})
                if response.status_code == 200 and response.json():
                    return True
        return False
    except Exception as e:
        print(f"    [WARN] Check error: {e}")
        return False


async def setup_message_handler(client, account_id):
    _ignored_log = {}
    
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            # IMPORTANT: Only process PRIVATE chats (DMs), skip channels and groups
            if not event.is_private:
                return
            
            # Double-check it's a user message, not from a channel/bot
            sender = await event.get_sender()
            if not sender:
                return
            
            # Must be a User type (not Channel, Chat, etc.)
            if not isinstance(sender, User):
                return
            
            # Skip bots
            if getattr(sender, 'bot', False):
                return
            
            sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
            sender_username = getattr(sender, 'username', None)
            sender_phone = f"+{sender.phone}" if hasattr(sender, 'phone') and sender.phone and not sender.phone.startswith('+') else getattr(sender, 'phone', None)
            
            cached = _cache_get(account_id, sender.id)
            if cached is None:
                exists = await check_conversation_exists(account_id, sender.id, sender_username, sender_phone)
                _cache_set(account_id, sender.id, exists)
                cached = exists
            
            if not cached:
                now = time.time()
                if sender.id not in _ignored_log or (now - _ignored_log[sender.id]) > 60:
                    _ignored_log[sender.id] = now
                    print(f"    [IGNORED] {sender_name}: no campaign conversation")
                return
            
            content = event.message.text or "[Media]"
            media_url = None
            media_type = None
            
            # Handle photos with proper BytesIO download
            if event.message.photo:
                print(f"    [PHOTO] From {sender_name}...")
                content = "[Photo] " + (event.message.text or "")
                media_type = "image"
                try:
                    # Download to BytesIO buffer (more reliable than bytes param)
                    buffer = io.BytesIO()
                    await client.download_media(event.message.photo, buffer)
                    photo_bytes = buffer.getvalue()
                    
                    if photo_bytes and len(photo_bytes) > 0:
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.jpg"
                        http = await get_http_client()
                        resp = await http.put(
                            f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{account_id}/{file_name}",
                            headers={
                                "apikey": SUPABASE_KEY,
                                "Authorization": f"Bearer {SUPABASE_KEY}",
                                "Content-Type": "image/jpeg",
                                "x-upsert": "true"
                            },
                            content=photo_bytes,
                            timeout=30.0
                        )
                        if resp.status_code in (200, 201):
                            media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{account_id}/{file_name}"
                            print(f"    [PHOTO OK] Uploaded: {file_name}")
                        else:
                            print(f"    [PHOTO FAIL] Upload status: {resp.status_code}")
                    else:
                        print(f"    [PHOTO FAIL] Empty download")
                except Exception as e:
                    print(f"    [PHOTO ERROR] {e}")
            
            # Handle documents/files
            elif event.message.document:
                print(f"    [DOCUMENT] From {sender_name}...")
                content = "[Document] " + (event.message.text or "")
                media_type = "document"
                try:
                    buffer = io.BytesIO()
                    await client.download_media(event.message.document, buffer)
                    doc_bytes = buffer.getvalue()
                    
                    if doc_bytes and len(doc_bytes) > 0:
                        # Get original filename if available
                        orig_name = None
                        for attr in event.message.document.attributes:
                            if hasattr(attr, 'file_name'):
                                orig_name = attr.file_name
                                break
                        
                        ext = orig_name.split('.')[-1] if orig_name and '.' in orig_name else 'bin'
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.{ext}"
                        
                        # Determine content type
                        content_type = event.message.document.mime_type or 'application/octet-stream'
                        
                        http = await get_http_client()
                        resp = await http.put(
                            f"{SUPABASE_URL_BASE}/storage/v1/object/message-attachments/{account_id}/{file_name}",
                            headers={
                                "apikey": SUPABASE_KEY,
                                "Authorization": f"Bearer {SUPABASE_KEY}",
                                "Content-Type": content_type,
                                "x-upsert": "true"
                            },
                            content=doc_bytes,
                            timeout=60.0
                        )
                        if resp.status_code in (200, 201):
                            media_url = f"{SUPABASE_URL_BASE}/storage/v1/object/public/message-attachments/{account_id}/{file_name}"
                            print(f"    [DOC OK] Uploaded: {file_name}")
                except Exception as e:
                    print(f"    [DOC ERROR] {e}")
            
            # Download avatar (skip errors silently)
            avatar_base64 = None
            try:
                buffer = io.BytesIO()
                await client.download_profile_photo(sender, buffer)
                photo_data = buffer.getvalue()
                if photo_data:
                    avatar_base64 = base64.b64encode(photo_data).decode('utf-8')
            except:
                pass
            
            print(f"  [IN] From {sender_name}: {content[:40]}...")
            asyncio.create_task(report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": sender_name,
                "sender_username": sender_username,
                "sender_phone": sender_phone,
                "sender_avatar": avatar_base64,
                "content": content,
                "media_url": media_url,
                "media_type": media_type
            }))
        except Exception as e:
            err_str = str(e).lower()
            # Ignore channel/permission errors silently
            if "private" in err_str or "permission" in err_str or "banned" in err_str:
                return
            print(f"  [WARN] Handler error: {e}")


async def main_loop():
    print("=" * 50)
    print("  LiveChat Receiver")
    print("  [Private DMs only, photos, documents]")
    print("=" * 50)
    
    connected_ids = set()
    
    while RUNNING:
        try:
            task = await get_next_task(runner="livechat_receiver")
            if task.get("task") == "wait":
                accounts = task.get("accounts", [])
                new_accounts = [acc for acc in accounts if acc.get("id") not in connected_ids]
                if new_accounts:
                    print(f"  [CONNECT] {len(new_accounts)} accounts...")
                    await asyncio.gather(*[get_or_create_client(acc, setup_handler=setup_message_handler) for acc in new_accounts], return_exceptions=True)
                    for acc in new_accounts:
                        if acc.get("id"):
                            connected_ids.add(acc["id"])
            await asyncio.sleep(0.05)
        except Exception as e:
            print(f"  [ERROR] {e}")
            await asyncio.sleep(0.5)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\nInstall: pip install telethon httpx pysocks\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\nStopped.")
