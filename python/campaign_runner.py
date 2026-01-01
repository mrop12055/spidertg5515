#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner
==============================
Handles ONLY campaign messages and recipient validation.
Can be stopped instantly with Ctrl+C or from frontend.

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

import asyncio
import signal
import sys

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, validate_contact, shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current task...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def main_loop():
    """Main campaign task execution loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner")
    print("=" * 60)
    print("  📨 Handles: Campaign messages, Recipient validation")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\n✓ Starting campaign loop...\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY campaign tasks
            task = await get_next_task(runner="campaign")
            task_type = task.get("task", "wait")
            
            # Check for stop signal from backend
            if task.get("stop_signal"):
                print("⏹ Campaign paused from dashboard. Stopping...")
                break
            
            if task_type == "wait":
                seconds = task.get("seconds", 1)
                # Keep clients alive during wait
                accounts = task.get("accounts", [])
                if accounts:
                    asyncio.gather(*[get_or_create_client(acc) for acc in accounts])
                await asyncio.sleep(seconds)
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client and recipient:
                    print(f"  📨 Sending to {recipient}...")
                    
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
            
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  📋 Validating {len(recipients)} recipients...")
                    for r in recipients:
                        if not RUNNING:
                            break
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {
                            "recipient_id": r["id"],
                            "exists": exists,
                            "name": name,
                            "telegram_id": telegram_id
                        })
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(1)
    
    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Campaign Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
