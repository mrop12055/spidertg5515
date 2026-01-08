#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (MAXIMUM SPEED - NO DELAYS)
==========================================================
BUILD: 2026-01-08-instant-v1

NO STAGGER. NO DELAYS. INSTANT PROCESSING.

- Polls server instantly (0.1s only when empty)
- Executes ALL tasks in parallel immediately
- Reports results in parallel
- Immediately requests more work

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

BUILD_VERSION = "2026-01-08-instant-v1"

import asyncio
import signal
import time

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, disconnect_batch, report_batch_results
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_WHEN_EMPTY = 0.1  # Only wait 0.1s when no tasks
REPORT_CONCURRENCY = 1000


def signal_handler(sig, frame):
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def pre_connect_batch(tasks: list) -> int:
    """Pre-connect all accounts in parallel."""
    unique_accounts = {}
    for t in tasks:
        acc = t.get("account", {})
        acc_id = acc.get("id")
        if acc_id and acc_id not in unique_accounts:
            unique_accounts[acc_id] = (acc, t.get("proxy"))
    
    if not unique_accounts:
        return 0
    
    print(f"  ⚡ Pre-connecting {len(unique_accounts)} accounts...")
    
    async def connect_one(account: dict, proxy: dict) -> bool:
        try:
            client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True)
            return client is not None
        except Exception as e:
            return False
    
    results = await asyncio.gather(
        *[connect_one(acc, px) for acc, px in unique_accounts.values()],
        return_exceptions=True
    )
    
    success_count = sum(1 for r in results if r is True)
    print(f"  ✓ {success_count}/{len(unique_accounts)} connected")
    return success_count


async def process_single_task(task: dict) -> dict:
    """Process a single campaign send task - NO DELAYS."""
    msg = task.get("message", {})
    recipient = task.get("recipient")
    recipient_name = task.get("recipient_name")
    account = task.get("account", {})
    proxy = task.get("proxy")
    content = msg.get("content", "")
    
    campaign_seat_id = task.get("campaign_seat_id")
    campaign_id = task.get("campaign_id")
    campaign_name = task.get("campaign_name")
    
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
        client = await get_or_create_client(account, task_proxy=proxy)
        
        if not client:
            print(f"    ✗ [{account_phone}] No client")
            return {
                "success": False,
                "error": "Could not connect client",
                "campaign_recipient_id": msg.get("campaign_recipient_id"),
                "message_id": msg.get("id"),
                "account_id": account_id,
            }
        
        # NO STAGGER - SEND IMMEDIATELY
        print(f"  📨 [{account_phone}] → {recipient}")
        
        send_res = await send_message(client, recipient, content, msg.get("media_url"))
        
        if isinstance(send_res, tuple) and len(send_res) == 3:
            success, error, meta = send_res
        elif isinstance(send_res, tuple) and len(send_res) == 2:
            success, error = send_res
            meta = None
        else:
            success, error, meta = False, f"Unexpected return: {type(send_res)}", None
        
        is_sender_error = error and any(x in error.lower() for x in [
            "privacyrestricted", "privacy restricted", "userprivacyrestricted",
            "too many requests", "sendmessagerequest"
        ])
        
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
            "campaign_seat_id": campaign_seat_id,
            "campaign_id": campaign_id,
            "campaign_name": campaign_name,
        }
        
        if is_sender_error:
            result["skip_account"] = True
            result["retry_with_different_account"] = True
            print(f"    ⚠ [{account_phone}] Sender error")
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


async def report_results_parallel(results: list) -> tuple:
    """Report all results in parallel."""
    start_time = time.time()
    valid_results = [r for r in results if not isinstance(r, Exception)]
    
    if not valid_results:
        return 0, 0, 0
    
    # Try batch reporting first
    try:
        batch_success = await report_batch_results(valid_results)
        if batch_success:
            elapsed = time.time() - start_time
            success_count = sum(1 for r in valid_results if r.get("success"))
            return success_count, len(valid_results) - success_count, elapsed
    except Exception as e:
        print(f"  ⚠ Batch report failed: {e}")
    
    # Fallback: parallel individual reports
    semaphore = asyncio.Semaphore(REPORT_CONCURRENCY)
    
    async def report_one(result: dict) -> bool:
        async with semaphore:
            try:
                await report_result("send", result)
                return result.get("success", False)
            except:
                return False
    
    report_results = await asyncio.gather(
        *[report_one(r) for r in valid_results],
        return_exceptions=True
    )
    
    elapsed = time.time() - start_time
    success_count = sum(1 for r in report_results if r is True)
    
    return success_count, len(valid_results) - success_count, elapsed


async def main_loop():
    """Main campaign loop - NO DELAYS, INSTANT PROCESSING"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (INSTANT MODE)")
    print(f"  BUILD: {BUILD_VERSION}")
    print("=" * 60)
    print("  🚀 NO STAGGER - NO DELAYS - INSTANT PROCESSING")
    print("  ⚡ All tasks processed in parallel immediately")
    print("  ♾️  Runs forever - auto-restarts on errors")
    print("  ⏹ Stop: Ctrl+C")
    print("=" * 60)
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            batch_start = time.time()
            
            # Get batch of tasks
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            more_pending = batch_result.get("more_pending", False)
            
            # Handle stop signal
            if batch_result.get("stop_signal"):
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print("  ⏸️  Campaign paused, waiting...")
                await asyncio.sleep(POLL_WHEN_EMPTY)
                continue

            # Handle no tasks
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print("  ⏳ No tasks, polling...")
                await asyncio.sleep(POLL_WHEN_EMPTY)
                continue
            
            consecutive_empty = 0
            print(f"\n  📦 Processing {len(tasks)} messages INSTANTLY...")
            
            # Pre-connect all accounts in parallel
            await pre_connect_batch(tasks)
            
            # Execute ALL tasks in parallel - NO STAGGER
            send_start = time.time()
            results = await asyncio.gather(
                *[process_single_task(task) for task in tasks],
                return_exceptions=True
            )
            send_time = time.time() - send_start
            
            # Report ALL results in parallel
            success_count, fail_count, report_time = await report_results_parallel(results)
            
            total_time = time.time() - batch_start
            msgs_per_min = (len(tasks) / total_time * 60) if total_time > 0 else 0
            
            print(f"  📊 {success_count}✓ {fail_count}✗ | {total_time:.1f}s ({msgs_per_min:.0f}/min)")

            # IMMEDIATE REPOLL - NO DELAY
            if more_pending:
                print("  🚀 More pending, requesting immediately...")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(POLL_WHEN_EMPTY)
    
    print("\n⏹ Campaign loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Campaign Runner - INSTANT MODE")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    
    while True:
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\n⏹ Stopping...")
            break
        except Exception as e:
            print(f"\n⚠ Crashed: {e}, restarting in 2s...")
            time.sleep(2)
    
    print("Goodbye!")
