#!/usr/bin/env python3
"""
TelegramCRM - Live Chat Sender
===============================
Dedicated to sending outgoing messages with image/link support.
Polls for pending messages and sends them as fast as possible.

Run: python live_chat_sender.py
Stop: Ctrl+C
"""

import asyncio
import signal

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all
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


async def main_loop():
    """Main sender loop - ONLY handles outgoing messages"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Live Chat Sender")
    print("=" * 60)
    print("  📤 Handles: Send replies, photos, documents, links")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting live chat sender...\n")
    
    while RUNNING:
        try:
            # Get send tasks only - NO account listening
            task = await get_next_task(runner="livechat_sender")
            task_type = task.get("task", "wait")
            
            if task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                recipient_tid = task.get("recipient_telegram_id")
                account = task.get("account", {})

                # Get client with proxy and fingerprint from task
                client = await get_or_create_client(account, skip_avatar=True)
                target = recipient_tid if recipient_tid else recipient

                if client and target:
                    content = msg.get("content", "")
                    media_url = msg.get("media_url")
                    
                    # Log what we're sending
                    if media_url:
                        print(f"  📤 [SEND] To {recipient} (with media)...")
                    else:
                        print(f"  📤 [SEND] To {recipient}...")

                    success, error, meta = await send_message(
                        client, target, content, media_url
                    )

                    payload = {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id"),
                    }
                    if meta:
                        payload.update(meta)

                    await report_result("send", payload)

                    if success:
                        print(f"    ✓ Sent!")
                    else:
                        print(f"    ✗ Failed: {error}")
                else:
                    if not client:
                        print(f"  ⚠ Could not connect account {account.get('phone_number', 'unknown')}")
                    if not target:
                        print(f"  ⚠ No target recipient")
            
            elif task_type == "wait":
                # No pending messages - poll quickly
                await asyncio.sleep(0.05)
            
            else:
                # Unknown task type
                await asyncio.sleep(0.05)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(0.1)
    
    print("\n⏹ Live chat sender stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Live Chat Sender... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx pysocks")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
