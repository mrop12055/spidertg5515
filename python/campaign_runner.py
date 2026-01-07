#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Server-Controlled)
===================================================
Simple task executor - all settings controlled by admin side.

- Polls server every 10 seconds for batch of tasks
- Executes ALL tasks in parallel
- Reports results back to server
- Server controls: batch size, delays, limits

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, disconnect_batch
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 10  # Fixed 10-second polling interval


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def process_single_task(task: dict) -> dict:
    """Process a single campaign send task.
    
    IMPORTANT: This function is fully isolated - any exception here
    only affects this task, never crashes the whole runner.
    """
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    account = task.get("account", {})
    proxy = task.get("proxy")
    content = msg.get("content", "")
    
    account_id = account.get("id")
    account_phone = account.get("phone_number", "????")[-4:]
    
    if not account_id or not recipient:
        return {
            "success": False,
            "error": "Missing account or recipient",
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "account_id": account_id,
        }
    
    try:
        # Get or create client with task-level proxy
        client = await get_or_create_client(account, task_proxy=proxy)
        
        if not client:
            result = {
                "success": False,
                "error": "Could not connect client",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account_id,
            }
            print(f"    ✗ [{account_phone}] No client")
            return result
        
        # Add small random delay to stagger sends (human-like)
        stagger_delay = random.uniform(0.5, 3)
        await asyncio.sleep(stagger_delay)
        
        print(f"  📨 [{account_phone}] → {recipient}")
        
        success, error, meta = await send_message(
            client, recipient, content,
            msg.get("media_url")
        )
        
        # Check if this is a sender-side issue (should retry with different account)
        is_sender_error = error and any(x in error.lower() for x in [
            "privacyrestricted", "privacy restricted", "userprivacyrestricted",
            "too many requests", "sendmessagerequest"
        ])
        
        # Get API credential ID
        api_creds = account.get("telegram_api_credentials")
        api_credential_id = api_creds.get("id") if api_creds else account.get("api_credential_id")
        
        result = {
            "success": success,
            "error": error,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"),
            "account_id": account_id,
            "api_credential_id": api_credential_id,
            "content": content,
            "recipient_phone": recipient,
            "recipient_name": recipient_name,
        }
        
        if is_sender_error:
            result["skip_account"] = True
            result["retry_with_different_account"] = True
            print(f"    ⚠ [{account_phone}] Sender error (will retry with different account)")
        elif success:
            print(f"    ✓ [{account_phone}] Sent")
        else:
            print(f"    ✗ [{account_phone}] {error}")
        
        if meta:
            result.update(meta)
        
        return result
        
    except Exception as e:
        error_str = str(e)
        print(f"    ✗ [{account_phone}] Error: {error_str[:50]}")
        return {
            "success": False,
            "error": error_str,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"),
            "account_id": account_id,
        }


async def main_loop():
    """Main campaign loop - Server-controlled batch processing
    
    Simple loop:
    1. Request tasks from server (server decides batch size)
    2. Execute ALL tasks in parallel
    3. Report ALL results
    4. Wait delay_after seconds (server-controlled)
    5. Repeat
    """
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Server-Controlled)")
    print("=" * 60)
    print(f"  📨 Polling every {POLL_INTERVAL} seconds")
    print("  🔧 All settings controlled by admin dashboard")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\n✓ Starting campaign runner...\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            # Request batch of tasks from server
            # Server controls: batch size, which tasks, timing
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", POLL_INTERVAL)
            
            # Check for stop signal from server
            if batch_result.get("stop_signal"):
                print("⏹ Campaign paused from dashboard. Stopping...")
                break
            
            # Handle no tasks
            if not tasks:
                reason = batch_result.get("reason", "")
                consecutive_empty += 1
                
                if consecutive_empty == 1:
                    if reason:
                        print(f"  ⏳ {reason}")
                    else:
                        print("  ⏳ No pending campaign tasks, waiting...")
                elif consecutive_empty % 6 == 0:  # Every ~minute at 10s interval
                    print("  ⏳ Still waiting for campaign tasks...")
                
                await asyncio.sleep(delay_after if delay_after > 0 else POLL_INTERVAL)
                continue
            
            consecutive_empty = 0
            print(f"\n  📦 Processing batch of {len(tasks)} messages in PARALLEL...")
            
            # Execute ALL tasks in parallel
            results = await asyncio.gather(
                *[process_single_task(task) for task in tasks],
                return_exceptions=True
            )
            
            # Report ALL results to server
            success_count = 0
            for result in results:
                if isinstance(result, Exception):
                    print(f"  ⚠ Task exception: {result}")
                    continue
                
                if result.get("success"):
                    success_count += 1
                
                await report_result("send", result)
            
            fail_count = len(results) - success_count
            print(f"  📊 Batch complete: {success_count} success, {fail_count} failed")
            
            # Disconnect clients after batch to save memory
            batch_account_ids = list(set(
                task.get("account", {}).get("id") 
                for task in tasks 
                if task.get("account", {}).get("id")
            ))
            await disconnect_batch(batch_account_ids)
            
            # Wait server-specified delay before next poll
            wait_time = delay_after if delay_after > 0 else POLL_INTERVAL
            if RUNNING and wait_time > 0:
                print(f"  ⏳ Waiting {wait_time}s before next poll...")
                await asyncio.sleep(wait_time)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
    
    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Campaign Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx python-socks")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
