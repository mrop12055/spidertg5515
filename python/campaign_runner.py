#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (PARALLEL BATCH MODE)
=====================================================
Handles campaign messages with PARALLEL execution across multiple accounts.
Each account processes its message with proper delays independently.

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True
PARALLEL_BATCH_SIZE = 50  # Process up to 50 messages simultaneously


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def process_single_task(task: dict, settings: dict) -> dict:
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
        
        # Check if this is a sender-side privacy restriction
        is_privacy_error = error and any(x in error.lower() for x in [
            "privacyrestricted", "privacy restricted", "userprivacyrestricted"
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
        
        if is_privacy_error:
            result["skip_account"] = True
            result["retry_with_different_account"] = True
            print(f"    ⚠ [{account_phone}] Privacy restricted")
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
    """Main campaign task execution loop - PARALLEL BATCH MODE"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (PARALLEL BATCH MODE)")
    print("=" * 60)
    print(f"  📨 Processing up to {PARALLEL_BATCH_SIZE} messages SIMULTANEOUSLY")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\n✓ Starting parallel campaign loop...\n")
    
    consecutive_empty = 0
    
    # Default settings
    settings = {
        "minDelaySeconds": 5,
        "maxDelaySeconds": 15,
    }
    
    while RUNNING:
        try:
            # Get batch of campaign tasks
            batch_result = await get_batch_tasks(runner="campaign", batch_size=PARALLEL_BATCH_SIZE)
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", 5)
            
            # Check for stop signal
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
                elif consecutive_empty % 12 == 0:  # Every ~minute
                    print("  ⏳ Still waiting for campaign tasks...")
                
                await asyncio.sleep(delay_after)
                continue
            
            consecutive_empty = 0
            print(f"\n  📦 Processing batch of {len(tasks)} messages in PARALLEL...")
            
            # Process all tasks in parallel
            results = await asyncio.gather(
                *[process_single_task(task, settings) for task in tasks],
                return_exceptions=True
            )
            
            # Report all results
            success_count = 0
            for result in results:
                if isinstance(result, Exception):
                    print(f"  ⚠ Task exception: {result}")
                    continue
                
                if result.get("success"):
                    success_count += 1
                
                # Report each result to backend
                await report_result("send", result)
            
            fail_count = len(results) - success_count
            print(f"  📊 Batch complete: {success_count} success, {fail_count} failed")
            
            # Wait between batches
            if RUNNING and delay_after > 0:
                print(f"  ⏳ Waiting {delay_after}s before next batch...")
                await asyncio.sleep(delay_after)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(5)
    
    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Campaign Runner (Parallel)... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
