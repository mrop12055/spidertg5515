#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Sequential with Rate Limiting)
==============================================================
Handles campaign messages with SEQUENTIAL execution and proper delays.
Respects all timing settings: message delay, account rotation, cooldowns.

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, cleanup_idle_clients
)

# ========== GLOBAL STATE ==========
RUNNING = True
last_account_id = None
messages_sent_by_account = {}  # Track messages sent per account in this session


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current task...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def main_loop():
    """Main campaign task execution loop - SEQUENTIAL with proper delays"""
    global RUNNING, last_account_id, messages_sent_by_account
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Sequential)")
    print("=" * 60)
    print("  📨 Mode: Sequential execution with rate limiting")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\n✓ Starting sequential campaign loop...\n")
    
    while RUNNING:
        try:
            # Get ONE task at a time from backend
            task_response = await get_next_task(runner="campaign")
            
            task_type = task_response.get("task", "wait")
            
            # Handle wait command - RESPECT THE BACKEND'S WAIT TIME
            if task_type == "wait":
                seconds = task_response.get("seconds", 5)
                reason = task_response.get("reason", "")
                if reason:
                    print(f"  ⏳ {reason}")
                else:
                    print(f"  ⏳ Waiting {seconds}s...")
                await asyncio.sleep(seconds)
                continue
            
            # Check for stop signal
            if task_response.get("stop_signal"):
                print("⏹ Campaign paused from dashboard. Stopping...")
                break
            
            # Only process "send" tasks
            if task_type != "send":
                print(f"  ⚠ Unknown task type: {task_type}, waiting...")
                await asyncio.sleep(2)
                continue
            
            # Get task details
            msg = task_response.get("message", {})
            recipient = task_response.get("recipient")
            recipient_name = task_response.get("recipient_name")
            account = task_response.get("account", {})
            content = msg.get("content", "")
            
            # Validate required fields
            account_id = account.get("id")
            if not account_id or not recipient:
                print(f"  ⚠ Invalid task: missing account or recipient, skipping...")
                await asyncio.sleep(2)
                continue
            
            # Get timing settings from task response
            settings = task_response.get("settings", {})
            min_delay = settings.get("minDelaySeconds", 5)
            max_delay = settings.get("maxDelaySeconds", 15)
            account_switch_delay = settings.get("accountSwitchDelaySeconds", 30)
            max_messages_before_rotation = settings.get("maxMessagesBeforeRotation", 10)
            messages_per_account = settings.get("messagesPerAccount", 5)
            
            account_phone = account.get("phone_number", "????")[-4:]
            
            # Check if we need to switch accounts
            if last_account_id and last_account_id != account_id:
                print(f"  🔄 Switching accounts... waiting {account_switch_delay}s")
                await asyncio.sleep(account_switch_delay)
                messages_sent_by_account[account_id] = 0  # Reset for new account
            
            # Track messages per account
            if account_id not in messages_sent_by_account:
                messages_sent_by_account[account_id] = 0
            
            # Check if account hit session limit for rotation
            if messages_sent_by_account[account_id] >= max_messages_before_rotation:
                print(f"  🔄 Account {account_phone} hit rotation limit ({max_messages_before_rotation}). Backend will assign next account.")
                messages_sent_by_account[account_id] = 0
            
            last_account_id = account_id
            
            # Execute the send task
            print(f"  📨 [{account_phone}] → {recipient}")
            
            skip_delay = False  # Flag to skip delay when account needs rotation
            
            try:
                # Pass task-level proxy to ensure consistent proxy usage
                task_proxy = task_response.get("proxy")
                client = await get_or_create_client(account, task_proxy=task_proxy)
                if not client or not recipient:
                    result = {
                        "success": False,
                        "error": "No client or recipient",
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "message_id": msg.get("id"),
                        "account_id": account_id,
                    }
                else:
                    success, error, meta = await send_message(
                        client, recipient, content,
                        msg.get("media_url")
                    )
                    
                    # Check if this is a sender-side privacy restriction (account issue, not recipient)
                    is_privacy_error = error and any(x in error.lower() for x in [
                        "privacyrestricted", "privacy restricted", "userprivacyrestricted"
                    ])

                    # Get the API credential ID that was used (from joined data or account)
                    api_creds = account.get("telegram_api_credentials")
                    api_credential_id = api_creds.get("id") if api_creds else account.get("api_credential_id")

                    result = {
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "message_id": msg.get("id"),
                        "account_id": account_id,
                        "api_credential_id": api_credential_id,  # Track which API was actually used
                        "content": content,
                        "recipient_phone": recipient,
                        "recipient_name": recipient_name,
                    }
                    
                    # If privacy error, signal backend to skip this account and retry with another
                    if is_privacy_error:
                        result["skip_account"] = True
                        result["retry_with_different_account"] = True
                        skip_delay = True
                        print(f"    ⚠ Privacy restricted - requesting different account for this recipient")
                    
                    if meta:
                        result.update(meta)
                    
                    if success:
                        messages_sent_by_account[account_id] = messages_sent_by_account.get(account_id, 0) + 1
                        print(f"    ✓ Sent ({messages_sent_by_account[account_id]} msgs this session)")
                    elif not is_privacy_error:
                        print(f"    ✗ Failed: {error}")
                        
            except Exception as e:
                result = {
                    "success": False,
                    "error": str(e),
                    "campaign_recipient_id": msg.get("campaign_recipient_id"),
                    "message_id": msg.get("id"),
                    "account_id": account_id,
                }
                print(f"    ✗ Error: {e}")
            
            # Report result to backend
            await report_result("send", result)
            
            # Cleanup idle clients periodically to prevent session locks
            await cleanup_idle_clients()
            
            # Wait random delay between min and max BEFORE next message
            # Skip delay if we need to rotate account (privacy error)
            if RUNNING and not skip_delay:
                delay = random.uniform(min_delay, max_delay)
                print(f"    ⏳ Waiting {delay:.1f}s before next message...")
                await asyncio.sleep(delay)
            elif skip_delay:
                print(f"    🔄 Rotating account immediately...")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(5)
    
    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Campaign Runner (Sequential)... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
