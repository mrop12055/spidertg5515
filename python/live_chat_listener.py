#!/usr/bin/env python3
"""
TelegramCRM - Live Chat Listener
=================================
Keeps all accounts connected and listens for incoming messages.
Sends outgoing messages for active conversations with 1-second polling.

Features:
- 1-second polling for send tasks (batch mode)
- Keep-alive mechanism to prevent disconnections
- Parallel batch processing of send tasks

Run: python live_chat_listener.py
Stop: Ctrl+C
"""

import asyncio
import signal
import time

from telethon import events

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, active_clients
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 1  # 1-second polling for send tasks
KEEP_ALIVE_INTERVAL = 60  # Ping connections every 60 seconds

# Reduce noise + avoid slowing the event loop with repeated DB checks for non-campaign senders
LOG_IGNORED_NON_CAMPAIGN = False


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def ping_connected_clients():
    """Keep connections alive by checking client status"""
    disconnected = []
    for acc_id, client in list(active_clients.items()):
        try:
            if not client.is_connected():
                disconnected.append(acc_id)
            else:
                # Light ping - just check connection
                await asyncio.wait_for(client.get_me(), timeout=5)
        except Exception as e:
            print(f"  ⚠ Client {acc_id[:8]}... ping failed: {e}")
            disconnected.append(acc_id)
    
    # Remove disconnected from tracking
    for acc_id in disconnected:
        if acc_id in active_clients:
            try:
                await active_clients[acc_id].disconnect()
            except:
                pass
            del active_clients[acc_id]
    
    if disconnected:
        print(f"  🔄 Cleaned up {len(disconnected)} disconnected clients")


async def process_send_task(task: dict) -> dict:
    """Process a single send task for live chat"""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_tid = task.get("recipient_telegram_id")
    account = task.get("account", {})
    task_proxy = task.get("proxy")
    
    account_id = account.get("id")
    account_phone = account.get("phone_number", "????")[-4:]
    
    if not account_id or not recipient:
        return {
            "message_id": msg.get("id"),
            "success": False,
            "error": "Missing account or recipient",
            "account_id": account_id,
        }
    
    try:
        # Get or create client with task-level proxy
        client = await get_or_create_client(
            account, 
            setup_handler=setup_message_handler,
            skip_avatar=True,
            task_proxy=task_proxy
        )
        
        if not client:
            return {
                "message_id": msg.get("id"),
                "success": False,
                "error": "Could not connect client",
                "account_id": account_id,
            }
        
        target = recipient_tid if recipient_tid else recipient
        
        print(f"  ⚡ [{account_phone}] Live reply to {recipient}...")
        
        success, error, meta = await send_message(
            client, target, msg.get("content", ""),
            msg.get("media_url")
        )
        
        result = {
            "message_id": msg.get("id"),
            "success": success,
            "error": error,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "account_id": account_id,
        }
        
        if meta:
            result.update(meta)
        
        if success:
            print(f"    ✓ Sent!")
        else:
            print(f"    ✗ Failed: {error}")
        
        return result
        
    except Exception as e:
        error_str = str(e)
        print(f"    ✗ [{account_phone}] Error: {error_str[:50]}")
        return {
            "message_id": msg.get("id"),
            "success": False,
            "error": error_str,
            "account_id": account_id,
        }


async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages - ONLY for campaign-initiated conversations"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            # Get sender with error handling for forwarded messages from private channels
            try:
                sender = await event.get_sender()
            except Exception as sender_error:
                error_str = str(sender_error).lower()
                # Skip forwarded messages from private channels/groups we can't access
                if any(x in error_str for x in ["private", "banned", "channel", "permission"]):
                    return  # Silently skip - this is a forwarded message from inaccessible source
                raise  # Re-raise other errors
            
            if not sender:
                return
            
            # Skip channel/group messages - only handle private chats
            from telethon.tl.types import User
            if not isinstance(sender, User):
                return

            # Skip bots
            if getattr(sender, 'bot', False):
                return
            
            # FILTER: Only process messages from contacts (people in contact list)
            # This is faster than database checks and ensures we only handle known contacts
            if not getattr(sender, 'contact', False):
                return  # Skip - sender is not in contact list
            
            # Get sender info
            first_name = getattr(sender, 'first_name', None) or ''
            last_name = getattr(sender, 'last_name', None) or ''
            sender_name = f"{first_name} {last_name}".strip() or str(sender.id)
            sender_username = getattr(sender, 'username', None)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            
            content = event.message.text or "[Media message]"
            media_url = None
            media_type = None
            
            # Handle photos - download and upload to Supabase storage
            if event.message.photo:
                print(f"    📷 Receiving photo...")
                content = "[Photo] " + (event.message.text or "")
                media_type = "image"
                
                try:
                    # Download the photo to bytes
                    photo_bytes = await client.download_media(event.message.photo, bytes)
                    if photo_bytes:
                        import base64
                        import httpx
                        import time as time_module
                        from config import SUPABASE_URL, SUPABASE_KEY
                        
                        # Upload to Supabase storage using PUT with x-upsert
                        file_name = f"incoming_{account_id}_{int(time_module.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        
                        # Get mime type from message if available
                        mime_type = "image/jpeg"
                        if hasattr(event.message, 'file') and event.message.file:
                            mime_type = getattr(event.message.file, 'mime_type', None) or "image/jpeg"
                        
                        async with httpx.AsyncClient(timeout=30.0) as http:
                            upload_response = await http.put(
                                f"{SUPABASE_URL}/storage/v1/object/message-attachments/{file_path}",
                                headers={
                                    "apikey": SUPABASE_KEY,
                                    "Authorization": f"Bearer {SUPABASE_KEY}",
                                    "Content-Type": mime_type,
                                    "x-upsert": "true"
                                },
                                content=photo_bytes
                            )
                            
                            if upload_response.status_code in (200, 201):
                                media_url = f"{SUPABASE_URL}/storage/v1/object/public/message-attachments/{file_path}"
                                print(f"    ✓ Photo uploaded: {file_name}")
                            else:
                                error_text = upload_response.text[:300] if upload_response.text else "No details"
                                print(f"    ⚠ Photo upload failed: {upload_response.status_code} - {error_text}")
                except Exception as e:
                    print(f"    ⚠ Could not download/upload photo: {e}")
            
            # Get phone number if available
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
            
            # Get profile photo
            avatar_base64 = None
            try:
                photo = await client.download_profile_photo(sender, bytes)
                if photo:
                    import base64
                    avatar_base64 = base64.b64encode(photo).decode('utf-8')
                    print(f"    📸 Got profile photo for {sender_name}")
            except Exception as e:
                print(f"    ⚠ Could not get profile photo: {e}")
            
            print(f"  📥 [IN] From {sender_name}: {content[:50]}...")
            
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": sender_name,
                "sender_username": getattr(sender, 'username', None),
                "sender_phone": sender_phone,
                "sender_avatar": avatar_base64,
                "content": content,
                "media_url": media_url,
                "media_type": media_type
            })
        except Exception as e:
            print(f"    ⚠ Handler error: {e}")


async def main_loop():
    """Main live chat loop with 1-second polling and keep-alive"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Live Chat Listener")
    print("=" * 60)
    print("  📥 Handles: Incoming messages, Live chat replies")
    print(f"  ⚡ Polling: Every {POLL_INTERVAL} second(s)")
    print(f"  💓 Keep-alive: Every {KEEP_ALIVE_INTERVAL} seconds")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting live chat listener...\n")
    
    connected_ids = set()  # Track connected accounts to avoid redundant work
    last_keep_alive = time.time()
    
    while RUNNING:
        try:
            # 1. Poll for send tasks using batch endpoint (every 1 second)
            batch_result = await get_batch_tasks(runner="livechat", batch_size=50)
            tasks = batch_result.get("tasks", [])
            accounts = batch_result.get("accounts", [])
            
            # 2. Connect new accounts from response
            new_accounts = [acc for acc in accounts if acc.get("id") not in connected_ids]
            if new_accounts:
                print(f"  🔌 Connecting {len(new_accounts)} new accounts...")
                # Connect in parallel for faster startup
                results = await asyncio.gather(
                    *[get_or_create_client(
                        acc, 
                        setup_handler=setup_message_handler, 
                        task_proxy=acc.get("proxy")
                    ) for acc in new_accounts],
                    return_exceptions=True
                )
                for acc in new_accounts:
                    if acc.get("id"):
                        connected_ids.add(acc["id"])
            
            # 3. Process send tasks in parallel
            if tasks:
                print(f"\n  📦 Processing {len(tasks)} send tasks in parallel...")
                results = await asyncio.gather(
                    *[process_send_task(task) for task in tasks],
                    return_exceptions=True
                )
                
                # Report all results
                for result in results:
                    if isinstance(result, Exception):
                        print(f"  ⚠ Task exception: {result}")
                        continue
                    if isinstance(result, dict):
                        await report_result("send", result)
            
            # 4. Keep-alive ping every 60 seconds
            if time.time() - last_keep_alive > KEEP_ALIVE_INTERVAL:
                print("  💓 Keep-alive check...")
                await ping_connected_clients()
                last_keep_alive = time.time()
            
            # 5. Fixed 1-second polling interval
            await asyncio.sleep(POLL_INTERVAL)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(1)
    
    print("\n⏹ Live chat listener stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Live Chat Listener... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
