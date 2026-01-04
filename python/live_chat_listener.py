#!/usr/bin/env python3
"""
TelegramCRM - Live Chat Listener
=================================
Keeps all accounts connected and listens for incoming messages.
Sends outgoing messages for active conversations instantly.

Run: python live_chat_listener.py
Stop: Ctrl+C
"""

import asyncio
import signal
import sys

from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, active_clients
)

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_conversation_exists(account_id: str, sender_id: int) -> bool:
    """Check if we have an existing conversation (meaning we messaged them first)"""
    import httpx
    from config import SUPABASE_URL, SUPABASE_KEY
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            # Check if conversation exists where we initiated contact
            response = await http.get(
                f"{SUPABASE_URL}/rest/v1/conversations",
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}"
                },
                params={
                    "account_id": f"eq.{account_id}",
                    "recipient_telegram_id": f"eq.{sender_id}",
                    "select": "id,first_message_sent"
                }
            )
            
            if response.status_code == 200:
                data = response.json()
                # Return True only if conversation exists AND we sent first message
                if data and len(data) > 0:
                    return data[0].get("first_message_sent", False)
            return False
    except Exception as e:
        print(f"    ⚠ Check conversation error: {e}")
        return False


async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages - ONLY for campaign-initiated conversations"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if not sender:
                return
            
            # Skip channel/group messages - only handle private chats
            from telethon.tl.types import User
            if not isinstance(sender, User):
                # It's a Channel, Chat, or other non-user entity - skip
                return

            # Skip bots (often spam / auto messages)
            if getattr(sender, 'bot', False):
                return

            # Get sender name safely for logging
            first_name = getattr(sender, 'first_name', None) or ''
            last_name = getattr(sender, 'last_name', None) or ''
            sender_name = f"{first_name} {last_name}".strip() or str(sender.id)

            # FILTER: Only process messages from conversations WE initiated
            conversation_exists = await check_conversation_exists(account_id, sender.id)
            if not conversation_exists:
                # Telegram will still deliver all messages to the client; we just ignore non-campaign contacts.
                return
            
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
                        import time
                        from config import SUPABASE_URL, SUPABASE_KEY
                        
                        # Upload to Supabase storage
                        file_name = f"incoming_{account_id}_{int(time.time() * 1000)}.jpg"
                        file_path = f"{account_id}/{file_name}"
                        
                        async with httpx.AsyncClient(timeout=30.0) as http:
                            upload_response = await http.post(
                                f"{SUPABASE_URL}/storage/v1/object/message-attachments/{file_path}",
                                headers={
                                    "apikey": SUPABASE_KEY,
                                    "Authorization": f"Bearer {SUPABASE_KEY}",
                                    "Content-Type": "image/jpeg"
                                },
                                content=photo_bytes
                            )
                            
                            if upload_response.status_code in (200, 201):
                                media_url = f"{SUPABASE_URL}/storage/v1/object/public/message-attachments/{file_path}"
                                print(f"    ✓ Photo uploaded: {file_name}")
                            else:
                                print(f"    ⚠ Photo upload failed: {upload_response.status_code}")
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
    """Main live chat loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Live Chat Listener")
    print("=" * 60)
    print("  📥 Handles: Incoming messages, Live chat replies")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting live chat listener...\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY livechat tasks
            task = await get_next_task(runner="livechat")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 0.05)
                # Connect all accounts and set up handlers
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc, setup_handler=setup_message_handler)
                await asyncio.sleep(seconds)
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                
                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    print(f"  ⚡ Live reply to {recipient}...")
                    
                    success, error = await send_message(
                        client, recipient, msg.get("content", ""),
                        msg.get("media_url")
                    )
                    
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    
                    if success:
                        print(f"    ✓ Sent!")
                    else:
                        print(f"    ✗ Failed: {error}")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(0.1)
    
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
