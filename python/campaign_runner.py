#!/usr/bin/env python3
"""
TelegramCRM - Campaign Runner (Server-Controlled Speed + Parallel Reporting)
=============================================================================
BUILD: 2026-01-08-batch-reporting-v2

All speed settings controlled by admin dashboard.

- Polls server for batch of tasks
- Speed settings (stagger, polling) controlled by server
- Executes ALL tasks in parallel
- Reports results in parallel (bounded concurrency)
- Uses batch reporting endpoint for speed

Run: python campaign_runner.py
Stop: Ctrl+C or pause campaign from dashboard
"""

BUILD_VERSION = "2026-01-08-batch-reporting-v2"

import asyncio
import signal
import random
import time

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    send_message, shutdown_all, disconnect_batch, report_batch_results
)

# ========== GLOBAL STATE ==========
RUNNING = True
DEFAULT_POLL_INTERVAL = 0  # INSTANT - no delay between batches
REPORT_CONCURRENCY = 1000  # Max parallel report calls for 5000 batch


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def pre_connect_batch(tasks: list) -> int:
    """Pre-connect all accounts in parallel BEFORE processing tasks.
    
    This speeds up batch processing by connecting all clients upfront
    instead of sequentially during task processing.
    
    Returns: number of successfully pre-connected accounts
    """
    unique_accounts = {}
    for t in tasks:
        acc = t.get("account", {})
        acc_id = acc.get("id")
        if acc_id and acc_id not in unique_accounts:
            unique_accounts[acc_id] = (acc, t.get("proxy"))
    
    if not unique_accounts:
        return 0
    
    print(f"  ⚡ Pre-connecting {len(unique_accounts)} accounts in parallel...")
    
    async def connect_one(account: dict, proxy: dict) -> bool:
        try:
            client = await get_or_create_client(account, task_proxy=proxy, skip_avatar=True)
            return client is not None
        except Exception as e:
            print(f"    ⚠ Pre-connect failed for {account.get('phone_number', '???')[-4:]}: {e}")
            return False
    
    results = await asyncio.gather(
        *[connect_one(acc, px) for acc, px in unique_accounts.values()],
        return_exceptions=True
    )
    
    success_count = sum(1 for r in results if r is True)
    print(f"  ✓ Pre-connection complete: {success_count}/{len(unique_accounts)} connected")
    return success_count


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
    
    # Get campaign metadata from task (passed from get-batch-tasks)
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
        
        # NO STAGGER - INSTANT SEND (server sends 0,0 for max speed)
        # Only sleep if server explicitly requests delay > 0
        if stagger_max > 0:
            stagger_delay = random.uniform(stagger_min, stagger_max)
            if stagger_delay > 0:
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
            # Include campaign metadata for faster backend processing
            "campaign_seat_id": campaign_seat_id,
            "campaign_id": campaign_id,
            "campaign_name": campaign_name,
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


async def report_results_parallel(results: list) -> tuple:
    """Report all results to server in parallel with bounded concurrency.
    
    Returns: (success_count, fail_count, report_time_seconds)
    """
    start_time = time.time()
    
    # Filter out exceptions
    valid_results = [r for r in results if not isinstance(r, Exception)]
    
    if not valid_results:
        return 0, 0, 0
    
    # Try batch reporting first (much faster if available)
    try:
        batch_success = await report_batch_results(valid_results)
        if batch_success:
            elapsed = time.time() - start_time
            success_count = sum(1 for r in valid_results if r.get("success"))
            return success_count, len(valid_results) - success_count, elapsed
    except Exception as e:
        print(f"  ⚠ Batch report failed, falling back to parallel: {e}")
    
    # Fallback: parallel individual reports with bounded concurrency
    semaphore = asyncio.Semaphore(REPORT_CONCURRENCY)
    
    async def report_one(result: dict) -> bool:
        async with semaphore:
            try:
                await report_result("send", result)
                return result.get("success", False)
            except Exception as e:
                print(f"    ⚠ Report error: {e}")
                return False
    
    # Report all in parallel (bounded by semaphore)
    report_results = await asyncio.gather(
        *[report_one(r) for r in valid_results],
        return_exceptions=True
    )
    
    elapsed = time.time() - start_time
    success_count = sum(1 for r in report_results if r is True)
    fail_count = len(valid_results) - success_count
    
    return success_count, fail_count, elapsed


async def main_loop():
    """Main campaign loop - Server-controlled speed settings
    
    Simple loop:
    1. Request tasks from server (server decides batch size + speed)
    2. Execute ALL tasks in parallel with server-controlled stagger
    3. Report ALL results in parallel (bounded concurrency)
    4. Wait delay_after seconds (server-controlled, can be 0)
    5. Repeat
    """
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Campaign Runner (Parallel Speed)")
    print(f"  BUILD: {BUILD_VERSION}")
    print("=" * 60)
    print("  🚀 Speed settings from admin dashboard")
    print("  ⚡ Parallel sending + batch reporting")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("  ⏹ Stop: Press Ctrl+C or pause campaign in dashboard")
    print("=" * 60)
    print("\n✓ Starting campaign runner...\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            batch_start = time.time()
            
            # Request batch of tasks from server
            batch_result = await get_batch_tasks(runner="campaign")
            tasks = batch_result.get("tasks", [])
            
            fetch_time = time.time() - batch_start
            
            # Get server-controlled speed settings
            stagger_min = batch_result.get("stagger_min", 0.3)
            stagger_max = batch_result.get("stagger_max", 1.5)
            delay_after = batch_result.get("delay_after", DEFAULT_POLL_INTERVAL)
            more_pending = batch_result.get("more_pending", False)

            # Check for stop signal from server - now just waits instead of stopping
            if batch_result.get("stop_signal"):
                reason = batch_result.get("reason", "Campaign paused from dashboard")
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print(f"  ⏸️  {reason} — waiting for campaign to resume...")
                elif consecutive_empty % 20 == 0:
                    print("  ⏸️  Still waiting for campaign to resume...")
                await asyncio.sleep(delay_after if delay_after > 0 else DEFAULT_POLL_INTERVAL)
                continue

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
            print(f"     [fetch: {fetch_time:.2f}s]")
            
            # Pre-connect all accounts in parallel FIRST (major speedup)
            connect_start = time.time()
            await pre_connect_batch(tasks)
            connect_time = time.time() - connect_start
            print(f"     [connect: {connect_time:.2f}s]")
            
            # Execute ALL tasks in parallel with server-controlled stagger
            send_start = time.time()
            results = await asyncio.gather(
                *[process_single_task(task, stagger_min, stagger_max) for task in tasks],
                return_exceptions=True
            )
            send_time = time.time() - send_start
            print(f"     [send: {send_time:.2f}s]")
            
            # Report ALL results in parallel (bounded concurrency)
            success_count, fail_count, report_time = await report_results_parallel(results)
            
            total_time = time.time() - batch_start
            msgs_per_min = (len(tasks) / total_time * 60) if total_time > 0 else 0
            
            print(f"  📊 Batch: {success_count}✓ {fail_count}✗ | {total_time:.1f}s total ({msgs_per_min:.0f}/min)")
            print(f"     [report: {report_time:.2f}s]")

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
    print("  Starting Campaign Runner - Parallel Speed")
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
