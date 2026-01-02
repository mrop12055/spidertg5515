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


async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                content = event.message.text or "[Media message]"
                media_url = None
                media_type = None
                
                # Handle photos
                if event.message.photo:
                    print(f"    📷 Receiving photo...")
                    content = "[Photo] " + (event.message.text or "")
                    media_type = "image"
                
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
                        print(f"    📸 Got profile photo for {sender.first_name or sender.id}")
                except Exception as e:
                    print(f"    ⚠ Could not get profile photo: {e}")
                
                print(f"  📥 Message from {sender.first_name or sender.id}: {content[:50]}...")
                
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "sender_phone": sender_phone,
                    "sender_avatar": avatar_base64,
                    "content": content,
                    "media_url": media_url,
                    "media_type": media_type
                })
        except Exception as e:
            print(f"    ⚠ Error handling incoming message: {e}")


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
