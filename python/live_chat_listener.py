#!/usr/bin/env python3
"""
LiveChat Runner - Handles incoming messages and live chat replies
RUNS FOREVER with crash recovery, memory cleanup, and heartbeat logging
"""
import asyncio
import signal
import base64
import time
import gc

import httpx
from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_stale_clients, active_clients, get_http_client
)
from config import SUPABASE_URL, SUPABASE_KEY
from urllib.parse import urlparse

# Ensure we always get the *origin* (e.g. https://xxxx.supabase.co)
_u = urlparse(SUPABASE_URL)
SUPABASE_URL_BASE = f"{_u.scheme}://{_u.netloc}" if _u.scheme and _u.netloc else SUPABASE_URL.rstrip("/")

RUNNING = True
CLEANUP_INTERVAL = 300  # 5 minutes
HEARTBEAT_INTERVAL = 60  # 1 minute


def signal_handler(sig, frame):
    global RUNNING
    print("\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_conversation_exists(account_id: str, sender_id: int, sender_username: str = None, sender_phone: str = None) -> bool:
    """Multi-strategy matching: telegram_id -> username -> phone"""
    import re
    try:
        http = get_http_client()
        
        # Strategy 1: Match by telegram_id
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
        print(f"    [WARN] Check conversation error: {e}")
        return False


async def setup_message_handler(client, account_id: str):
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if not sender:
                return
            
            from telethon.tl.types import User
            if not isinstance(sender, User):
                return
            if getattr(sender, 'bot', False):
                return
            
            # Get sender info for matching
            sender_username = getattr(sender, 'username', None)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
            
            # Multi-strategy conversation check
            conversation_exists = await check_conversation_exists(account_id, sender.id, sender_username, sender_phone)
            if not conversation_exists:
                # Rate-limited logging for ignored messages
                if not hasattr(handler, '_ignored_log') or time.time() - handler._ignored_log.get(sender.id, 0) > 60:
                    if not hasattr(handler, '_ignored_log'):
                        handler._ignored_log = {}
                    handler._ignored_log[sender.id] = time.time()
                    print(f"    [IGNORED] {sender_name} (id={sender.id}): no campaign conversation")
                return
            
            content = event.message.text or "[Media]"
            media_url = None
            media_type = None
            
            if event.message.photo:
                print(f"    [PHOTO] Receiving...")
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
                        
                        http = get_http_client()
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
                            print(f"    [OK] Photo uploaded: {file_name}")
                        else:
                            error_text = upload_response.text[:300] if upload_response.text else "No details"
                            print(f"    [WARN] Photo upload failed: {upload_response.status_code} - {error_text}")
                except Exception as e:
                    print(f"    [WARN] Could not upload photo: {e}")
            
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
            except:
                pass
            
            print(f"  [IN] From {sender_name}: {content[:40]}...")
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
            print(f"  [WARN] Handler error: {e}")


async def main_loop():
    print("=" * 50)
    print("  LiveChat Runner")
    print("  [Incoming + Replies]")
    print("  🧹 Memory cleanup every 5 minutes")
    print("  💓 Heartbeat every 60 seconds")
    print("=" * 50)
    
    connected_ids = set()  # Track connected accounts to avoid redundant work
    last_cleanup = time.time()
    last_heartbeat = time.time()
    iteration_count = 0
    
    while RUNNING:
        try:
            iteration_count += 1
            
            # Heartbeat logging
            if time.time() - last_heartbeat > HEARTBEAT_INTERVAL:
                print(f"  [HEARTBEAT] Iteration {iteration_count}, Connected: {len(connected_ids)}, Active: {len(active_clients)}")
                last_heartbeat = time.time()
            
            # Periodic cleanup - sync connected_ids with actual clients
            if time.time() - last_cleanup > CLEANUP_INTERVAL:
                # Remove stale IDs from connected_ids
                stale_ids = [acc_id for acc_id in connected_ids if acc_id not in active_clients]
                for acc_id in stale_ids:
                    connected_ids.discard(acc_id)
                
                if stale_ids:
                    print(f"  [CLEANUP] Removed {len(stale_ids)} stale IDs from connected_ids")
                
                # Clean up disconnected clients
                await cleanup_stale_clients()
                gc.collect()
                last_cleanup = time.time()
            
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                # Only connect NEW accounts (skip already connected)
                new_accounts = [acc for acc in accounts if acc.get("id") not in connected_ids]
                if new_accounts:
                    # Connect in parallel for speed
                    results = await asyncio.gather(
                        *[get_or_create_client(acc, setup_handler=setup_message_handler) for acc in new_accounts],
                        return_exceptions=True
                    )
                    for acc in new_accounts:
                        if acc.get("id"):
                            connected_ids.add(acc["id"])
                # No artificial delay - server returns seconds=0 for instant polling
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    print(f"  [REPLY] To {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "account_id": account.get("id")
                    })
        
        except Exception as e:
            print(f"  [ERROR] {e}")
            await asyncio.sleep(0.5)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\nInstall: pip install telethon httpx\n")
    
    while True:  # FOREVER LOOP WITH CRASH RECOVERY
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\n⏹ Stopping...")
            break
        except Exception as e:
            print(f"\n⚠ LiveChat crashed: {e}")
            print("  Restarting in 5 seconds...")
            time.sleep(5)
    
    print("Goodbye!")
