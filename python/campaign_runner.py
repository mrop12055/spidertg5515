#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Server-Controlled Speed)
=========================================================
All speed settings controlled by admin dashboard.

- Polls server for batch of tasks
- Speed settings (stagger, polling) controlled by server
- Executes ALL tasks in parallel
- Reports results back to server

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
DEFAULT_POLL_INTERVAL = 3  # Default polling (server can override)


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def process_single_task(task: dict, stagger_min: float, stagger_max: float) -> dict:
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
        
        # Server-controlled stagger delay
        stagger_delay = random.uniform(stagger_min, stagger_max)
        await asyncio.sleep(stagger_delay)
        
        print(f"  📨 [{account_phone}] → {recipient}")
        
        send_res = await send_message(
            client, recipient, content,
            msg.get("media_url")
        )
        if isinstance(send_res, tuple) and len(send_res) == 3:
            success, error, meta = send_res
        elif isinstance(send_res, tuple) and len(send_res) == 2:
            success, error = send_res
            meta = None
        else:
            success, error, meta = False, f"Unexpected send_message return: {type(send_res)}", None
        
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
    """Main campaign loop - Server-controlled speed settings
    
    Simple loop:
    1. Request tasks from server (server decides batch size + speed)
    2. Execute ALL tasks in parallel with server-controlled stagger
    3. Report ALL results
    4. Wait delay_after seconds (server-controlled, can be 0)
    5. Repeat
    """
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Server-Controlled Speed)")
    print("=" * 60)
    print("  🚀 Speed settings from admin dashboard")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\n✓ Starting campaign runner...\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            # Request batch of tasks from server
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            
            # Get server-controlled speed settings
            stagger_min = batch_result.get("stagger_min", 0.3)
            stagger_max = batch_result.get("stagger_max", 1.5)
            delay_after = batch_result.get("delay_after", DEFAULT_POLL_INTERVAL)
            more_pending = batch_result.get("more_pending", False)

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
                elif consecutive_empty % 10 == 0:
                    print("  ⏳ Still waiting for campaign tasks...")

                await asyncio.sleep(delay_after if delay_after > 0 else DEFAULT_POLL_INTERVAL)
                continue
            
            consecutive_empty = 0
            print(f"\n  📦 Processing {len(tasks)} messages (stagger: {stagger_min:.1f}-{stagger_max:.1f}s)...")
            
            # Execute ALL tasks in parallel with server-controlled stagger
            results = await asyncio.gather(
                *[process_single_task(task, stagger_min, stagger_max) for task in tasks],
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

            # IMPORTANT: Disconnect batch clients to avoid memory/connection buildup
            # (Keeping hundreds of Telethon clients open can lead to OOM / OS-kill after a few batches)
            batch_account_ids = list({
                (t.get("account") or {}).get("id")
                for t in tasks
                if (t.get("account") or {}).get("id")
            })
            if batch_account_ids:
                await disconnect_batch(batch_account_ids)

            # Use server-controlled delay (can be 0 for immediate repoll if more pending)
            if RUNNING and delay_after > 0:
                print(f"  ⏳ Next batch in {delay_after}s...")
                await asyncio.sleep(delay_after)
            elif RUNNING and more_pending:
                print("  🚀 More pending, immediate repoll...")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(DEFAULT_POLL_INTERVAL)
    
    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Campaign Runner - Server-Controlled Speed")
    print("  Speed & batch settings from admin dashboard")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    print("Required: pip install telethon httpx pysocks")
    
    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\n⏹ Keyboard interrupt - stopping...")
            break
        except Exception as e:
            print(f"\n⚠ Runner crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)
    
    print("Goodbye!")
