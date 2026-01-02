#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Parallel)
=========================================
Handles campaign messages with PARALLEL execution across multiple accounts.
Uses batch task endpoint for high-volume sending (10K+ messages/day).

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

import asyncio
import signal
import sys

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, validate_contact, shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True
DEFAULT_BATCH_SIZE = 5  # Number of parallel tasks per batch


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def execute_send_task(task: dict) -> dict:
    """Execute a single send task and return result"""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    account = task.get("account", {})
    content = msg.get("content", "")
    
    try:
        client = await get_or_create_client(account)
        if not client or not recipient:
            return {
                "success": False,
                "error": "No client or recipient",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account.get("id"),
            }
        
        phone = account.get("phone_number", "?")[-4:]
        print(f"  📨 [{phone}] → {recipient}")
        
        success, error = await send_message(
            client, recipient, content,
            msg.get("media_url")
        )
        
        return {
            "success": success,
            "error": error,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"),
            "account_id": account.get("id"),
            "content": content,
            "recipient_phone": recipient,
            "recipient_name": recipient_name,
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "message_id": msg.get("id"),
            "account_id": account.get("id"),
        }


async def main_loop():
    """Main campaign task execution loop with parallel processing"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Parallel)")
    print("=" * 60)
    print(f"  📨 Mode: Parallel execution ({DEFAULT_BATCH_SIZE} accounts)")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\n✓ Starting parallel campaign loop...\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            # Get batch of tasks from backend
            batch = await get_batch_tasks(runner="campaign", batch_size=DEFAULT_BATCH_SIZE)
            
            tasks = batch.get("tasks", [])
            delay_after = batch.get("delay_after", 10)
            accounts_available = batch.get("accounts_available", 0)
            
            # Check for stop signal
            if batch.get("stop_signal"):
                print("⏹ Campaign paused from dashboard. Stopping...")
                break
            
            if not tasks:
                consecutive_empty += 1
                reason = batch.get("reason", "No tasks")
                
                # After 5 consecutive empty responses, slow down
                if consecutive_empty >= 5:
                    wait_time = min(delay_after * 2, 60)
                    print(f"  ⏳ {reason} (accounts: {accounts_available}). Waiting {wait_time}s...")
                else:
                    wait_time = delay_after
                    print(f"  ⏳ {reason}. Waiting {wait_time}s...")
                
                await asyncio.sleep(wait_time)
                continue
            
            # Reset counter when we have work
            consecutive_empty = 0
            
            print(f"\n📦 Batch: {len(tasks)} tasks ({accounts_available} accounts available)")
            
            # Execute all tasks in parallel
            results = await asyncio.gather(*[
                execute_send_task(task) for task in tasks
            ], return_exceptions=True)
            
            # Report results
            sent = 0
            failed = 0
            for result in results:
                if isinstance(result, Exception):
                    print(f"    ⚠ Task exception: {result}")
                    failed += 1
                    continue
                
                if result.get("success"):
                    sent += 1
                else:
                    failed += 1
                
                # Report to backend
                await report_result("send", result)
            
            print(f"  ✓ Batch complete: {sent} sent, {failed} failed")
            
            # Wait before next batch (backend controls timing)
            if RUNNING and delay_after > 0:
                print(f"  ⏳ Next batch in {delay_after}s...")
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
