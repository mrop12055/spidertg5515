#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner (POLLING MODE)
============================================
Simple polling-based warmup runner:
- Polls server every 2 seconds for pending tasks
- Server controls batch size - Python processes ALL tasks received
- No limits on Python side - admin controls everything
- Supports unlimited parallel tasks

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result,
    shutdown_all, disconnect_batch
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 2  # Poll every 2 seconds - fast polling

# Warmup channels (safe public channels for building history)
WARMUP_CHANNELS = [
    "telegram",
    "durov", 
    "TelegramTips",
    "android",
    "ios",
]

# Reaction emojis
REACTIONS = ["👍", "❤️", "🔥", "👏", "😊", "🎉", "💯", "⭐"]


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("")
    print("[STOP] Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def add_contact(client, phone: str, first_name: str, last_name: str = ""):
    """Add a contact (for interaction between accounts)"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact

        contact = InputPhoneContact(
            client_id=0,
            phone=phone,
            first_name=first_name,
            last_name=last_name
        )

        result = await client(ImportContactsRequest([contact]))
        if result.imported:
            return True, phone, None
        else:
            return True, phone, "Contact exists or invalid"
    except Exception as e:
        return False, phone, str(e)


async def send_warmup_chat(client, recipient_phone: str, message: str, recipient_telegram_id: int = None, recipient_username: str = None, recipient_first_name: str = None):
    """Send warmup chat message with human-like typing simulation"""
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact

        user = None

        # Try to get user by telegram_id first (fastest)
        if recipient_telegram_id:
            try:
                user = await client.get_entity(recipient_telegram_id)
            except:
                pass

        # Try username next
        if not user and recipient_username:
            try:
                user = await client.get_entity(recipient_username)
            except:
                pass

        # Fallback to phone number
        if not user:
            contact = InputPhoneContact(
                client_id=random.randint(0, 999999),
                phone=recipient_phone,
                first_name=recipient_first_name or "Friend",
                last_name=""
            )
            result = await client(ImportContactsRequest([contact]))
            if result.users:
                user = result.users[0]

        if not user:
            return False, "Could not find user"

        # Human-like typing simulation
        base_delay = random.uniform(2, 4)
        typing_delay = len(message) * random.uniform(0.08, 0.15)
        thinking_pause = random.uniform(0, 2)
        total_typing_time = min(base_delay + typing_delay + thinking_pause, 15)

        # Show typing indicator
        async with client.action(user, 'typing'):
            await asyncio.sleep(total_typing_time)

        # Send message
        await client.send_message(user, message)

        # Small random delay after sending
        await asyncio.sleep(random.uniform(0.5, 2))

        return True, None
    except Exception as e:
        return False, str(e)


async def process_single_task(task: dict) -> dict:
    """Process a single warmup task.
    
    IMPORTANT: This function is fully isolated - any exception here
    only affects this task, never crashes the whole runner.
    """
    task_type = task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    is_cycle_last = task.get("is_cycle_last", False)

    phone = account.get("phone_number", "Unknown")

    try:
        # Get or create client
        task_proxy = account.get("proxy")
        client = await get_or_create_client(account, task_proxy=task_proxy)

        if not client:
            error_msg = "Could not connect client - proxy may be down or expired"
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": False,
                "error": error_msg,
                "error_type": "proxy_error",
                "is_cycle_last": is_cycle_last,
            })
            return {"task_id": task_id, "success": False, "error": error_msg}

        if task_type == "warmup_add_contact":
            target_phone = task_data.get("phone") or task_data.get("recipient_phone")
            first_name = task_data.get("first_name", "Friend")

            display_phone = target_phone[:8] + "..." if target_phone and len(target_phone) > 8 else target_phone
            print(f"  [CONTACT] {phone} -> {display_phone} ({first_name})")

            success, added_phone, error = await add_contact(client, target_phone, first_name)
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": success,
                "error": error,
                "message_type": "add_contact",
                "is_cycle_last": is_cycle_last,
            })
            status = "OK" if success else "FAIL"
            print(f"    [{status}] Contact saved")
            return {"task_id": task_id, "success": success, "error": error}

        elif task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            recipient_telegram_id = task_data.get("recipient_telegram_id")
            recipient_username = task_data.get("recipient_username")
            recipient_first_name = task_data.get("first_name")
            message = task_data.get("message", "Hey!")

            display_phone = recipient_phone[:8] + "..." if recipient_phone and len(recipient_phone) > 8 else recipient_phone
            cycle_indicator = " [LAST]" if is_cycle_last else ""
            print(f"  [CHAT] {phone} -> {display_phone}{cycle_indicator}")

            success, error = await send_warmup_chat(
                client, 
                recipient_phone, 
                message, 
                recipient_telegram_id, 
                recipient_username,
                recipient_first_name
            )
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": success,
                "error": error,
                "message_type": "text",
                "is_cycle_last": is_cycle_last,
            })

            msg_preview = message[:30] + "..." if len(message) > 30 else message
            status = "OK" if success else "FAIL"
            print(f"    [{status}] {msg_preview}")
            return {"task_id": task_id, "success": success, "error": error}

        else:
            print(f"  [?] Unknown task type: {task_type}")
            return {"task_id": task_id, "success": False, "error": f"Unknown task type: {task_type}"}

    except Exception as e:
        error_str = str(e)
        error_type = "unknown"

        # Detect error type for better reporting
        error_lower = error_str.lower()
        if any(x in error_lower for x in ["proxy", "socks", "connection refused", "unreachable"]):
            error_type = "proxy_error"
        elif any(x in error_lower for x in ["timeout", "timed out"]):
            error_type = "connection_error"

        print(f"  [ERROR] {phone}: {e}")

        # Always report result, even on exception
        try:
            await report_result("warmup_chat", {
                "task_id": task_id,
                "pair_id": pair_id,
                "account_id": account.get("id"),
                "success": False,
                "error": error_str,
                "error_type": error_type,
                "is_cycle_last": is_cycle_last,
            })
        except Exception as report_error:
            print(f"  [WARN] Failed to report error: {report_error}")

        return {"task_id": task_id, "success": False, "error": error_str}


async def main_loop():
    """Main warmup loop - polls server every 2 seconds for work.
    
    NO LIMITS HERE - server controls everything:
    - Server decides batch size
    - Server decides which tasks to send
    - Python just processes ALL tasks it receives
    """
    global RUNNING

    print("=" * 60)
    print("  TelegramCRM - Warmup Runner (POLLING MODE)")
    print("=" * 60)
    print(f"  Polling every {POLL_INTERVAL} seconds")
    print("  Server controls batch size - Python processes ALL tasks")
    print("  Stop: Press Ctrl+C")
    print("=" * 60)
    print("")
    print("[START] Warmup runner started...")
    print("")

    consecutive_empty = 0

    while RUNNING:
        try:
            # Poll server for pending warmup tasks
            # Server returns ALL tasks based on admin batch_size settings
            # NO LIMIT HERE - we process everything server sends
            batch_result = await get_batch_tasks(runner="warmup_chat")
            tasks = batch_result.get("tasks", [])
            accounts_available = batch_result.get("accounts_available", 0)
            delay_after = batch_result.get("delay_after", POLL_INTERVAL)

            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    print(f"  [WAIT] No tasks available ({accounts_available} accounts ready)")
                elif consecutive_empty % 30 == 0:  # Every ~minute (30 x 2s)
                    print(f"  [WAIT] Still waiting... ({accounts_available} accounts ready)")

                # Wait before next poll
                await asyncio.sleep(POLL_INTERVAL)
                continue

            consecutive_empty = 0
            print(f"")
            print(f"  [BATCH] Processing {len(tasks)} tasks from server")

            # Process ALL tasks in parallel - no limit!
            results = await asyncio.gather(
                *[process_single_task(task) for task in tasks],
                return_exceptions=True
            )

            # Summary
            success_count = sum(1 for r in results if isinstance(r, dict) and r.get("success"))
            fail_count = len(results) - success_count
            print(f"  [DONE] Batch: {success_count} OK, {fail_count} failed")

            # Disconnect clients after batch
            batch_account_ids = list(set(
                task.get("account", {}).get("id") 
                for task in tasks 
                if task.get("account", {}).get("id")
            ))
            await disconnect_batch(batch_account_ids)

            # Use server-suggested delay or default poll interval
            await asyncio.sleep(delay_after if delay_after > 0 else POLL_INTERVAL)

        except Exception as e:
            print(f"  [ERROR] Loop error: {e}")
            await asyncio.sleep(POLL_INTERVAL)

    print("")
    print("[STOP] Warmup runner stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Warmup Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx python-socks")
    print("")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("")
        print("[STOP] Keyboard interrupt.")
    finally:
        print("Goodbye!")
