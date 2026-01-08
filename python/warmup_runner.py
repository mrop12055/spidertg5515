#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner (PARALLEL BATCH MODE)
===================================================
Handles warmup tasks with PARALLEL execution.
Polls server every 7 seconds. RUNS FOREVER with auto-restart.

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_batch_tasks, report_result, shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True
POLL_INTERVAL = 7  # Poll server every 7 seconds
WARMUP_CHANNELS = ["telegram", "durov", "tginfo", "techcrunch"]
REACTIONS = ["👍", "❤️", "🔥", "👏", "😂", "🎉", "💯", "⭐"]


def signal_handler(sig, frame):
    global RUNNING
    print("\n[STOP] Stop signal received. Finishing current batch...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def add_contact(client, phone, first_name, last_name=""):
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        contact = InputPhoneContact(client_id=0, phone=phone, first_name=first_name, last_name=last_name)
        result = await client(ImportContactsRequest([contact]))
        if result.imported:
            return True, phone, None
        return True, phone, "Contact exists or invalid"
    except Exception as e:
        return False, phone, str(e)


async def send_warmup_chat(client, recipient_phone, message, recipient_telegram_id=None, recipient_username=None, recipient_first_name=None):
    try:
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        
        user = None
        if recipient_telegram_id:
            try:
                user = await client.get_entity(recipient_telegram_id)
            except:
                pass
        if not user and recipient_username:
            try:
                user = await client.get_entity(recipient_username)
            except:
                pass
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
        total_typing_time = min(base_delay + typing_delay, 15)
        
        async with client.action(user, 'typing'):
            await asyncio.sleep(total_typing_time)
        
        await client.send_message(user, message)
        await asyncio.sleep(random.uniform(0.5, 2))
        
        return True, None
    except Exception as e:
        return False, str(e)


async def join_channel(client, channel_username=None):
    try:
        from telethon.tl.functions.channels import JoinChannelRequest
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel_username)
        await client(JoinChannelRequest(entity))
        return True, channel_username, None
    except Exception as e:
        return False, channel_username, str(e)


async def view_channel_messages(client, channel_username=None):
    try:
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel_username)
        messages = await client.get_messages(entity, limit=10)
        if messages:
            await client.send_read_acknowledge(entity, messages[-1])
        return True, len(messages), None
    except Exception as e:
        return False, 0, str(e)


async def send_reaction(client, channel_username=None):
    try:
        from telethon.tl.functions.messages import SendReactionRequest
        from telethon.tl.types import ReactionEmoji
        if not channel_username:
            channel_username = random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel_username)
        messages = await client.get_messages(entity, limit=5)
        if messages:
            msg = random.choice(messages)
            reaction = random.choice(REACTIONS)
            await client(SendReactionRequest(peer=entity, msg_id=msg.id, reaction=[ReactionEmoji(emoticon=reaction)]))
            return True, reaction, None
    except Exception as e:
        return False, None, str(e)
    return False, None, "No messages"


async def update_profile_bio(client, bio=None):
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        if not bio:
            bios = ["🚀", "✨", "💫", "🌟", "⚡", "🔥", "💪", "🎯"]
            bio = random.choice(bios)
        await client(UpdateProfileRequest(about=bio))
        return True, None
    except Exception as e:
        return False, str(e)


async def process_single_warmup_task(task: dict) -> dict:
    """Process a single warmup task - fully isolated"""
    task_type = task.get("task_type") or task.get("task", "unknown")
    task_id = task.get("task_id")
    account = task.get("account", {})
    task_data = task.get("task_data", {})
    pair_id = task.get("pair_id")
    proxy = task.get("proxy")
    
    account_id = account.get("id")
    phone = account.get("phone_number", "????")[-4:]
    
    if not account_id:
        return {"success": False, "error": "No account", "task_id": task_id}
    
    try:
        client = await get_or_create_client(account, task_proxy=proxy)
        if not client:
            return {
                "success": False, "error": "Could not connect client",
                "task_id": task_id, "account_id": account_id, "pair_id": pair_id
            }
        
        await asyncio.sleep(random.uniform(0.5, 2))
        
        if task_type == "warmup_add_contact":
            target_phone = task_data.get("phone") or task_data.get("recipient_phone")
            first_name = task_data.get("first_name", "Friend")
            print(f"  [CONTACT] [{phone}] Adding contact...")
            success, added_phone, error = await add_contact(client, target_phone, first_name)
            return {"task_id": task_id, "pair_id": pair_id, "account_id": account_id, "success": success, "error": error, "task_subtype": "add_contact"}
        
        elif task_type == "warmup_chat":
            recipient_phone = task_data.get("recipient_phone")
            recipient_telegram_id = task_data.get("recipient_telegram_id")
            recipient_username = task_data.get("recipient_username")
            recipient_first_name = task_data.get("first_name")
            message = task_data.get("message", "Hey! 👋")
            print(f"  [CHAT] [{phone}] Sending warmup message...")
            success, error = await send_warmup_chat(client, recipient_phone, message, recipient_telegram_id, recipient_username, recipient_first_name)
            return {"task_id": task_id, "pair_id": pair_id, "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_join_channel":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [JOIN] [{phone}] Joining channel...")
            success, channel_name, error = await join_channel(client, channel)
            return {"task_id": task_id, "task_type": "join_channel", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_view_content":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [VIEW] [{phone}] Viewing content...")
            success, count, error = await view_channel_messages(client, channel)
            return {"task_id": task_id, "task_type": "view_content", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_send_reaction":
            channel = task_data.get("channel_username") or task.get("channel_username")
            print(f"  [REACT] [{phone}] Sending reaction...")
            success, reaction, error = await send_reaction(client, channel)
            return {"task_id": task_id, "task_type": "send_reaction", "account_id": account_id, "success": success, "error": error}
        
        elif task_type == "warmup_profile_update":
            bio = task_data.get("bio")
            print(f"  [BIO] [{phone}] Updating bio...")
            success, error = await update_profile_bio(client, bio)
            return {"task_id": task_id, "task_type": "profile_update", "account_id": account_id, "success": success, "error": error}
        
        else:
            print(f"  [?] [{phone}] Unknown task type: {task_type}")
            return {"success": False, "error": f"Unknown task type: {task_type}", "task_id": task_id}
    
    except Exception as e:
        print(f"  [ERROR] [{phone}] {str(e)[:50]}")
        return {"success": False, "error": str(e), "task_id": task_id, "account_id": account_id, "pair_id": pair_id}


async def main_loop():
    """Main warmup loop - RUNS FOREVER with 7s polling"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Warmup Runner (Server-Controlled)")
    print("=" * 60)
    print(f"  🔥 Polling server every {POLL_INTERVAL} seconds")
    print("  🔧 All settings controlled by admin dashboard")
    print("  ♾️  RUNS FOREVER - auto-restarts on errors")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting warmup runner...\n")
    
    consecutive_empty = 0
    
    while RUNNING:
        try:
            batch_result = await get_batch_tasks(runner="warmup_chat", batch_size=50)
            tasks = batch_result.get("tasks", [])
            delay_after = batch_result.get("delay_after", POLL_INTERVAL)
            
            if not tasks:
                consecutive_empty += 1
                if consecutive_empty == 1:
                    reason = batch_result.get("reason", "")
                    print(f"  [WAIT] {reason or 'No pending warmup tasks, waiting...'}")
                elif consecutive_empty % 8 == 0:  # Every ~56 seconds at 7s interval
                    print("  [WAIT] Still waiting for warmup tasks...")
                await asyncio.sleep(delay_after if delay_after > 0 else POLL_INTERVAL)
                continue
            
            consecutive_empty = 0
            print(f"\n  [BATCH] Processing {len(tasks)} warmup tasks in PARALLEL...")
            
            results = await asyncio.gather(
                *[process_single_warmup_task(task) for task in tasks],
                return_exceptions=True
            )
            
            success_count = 0
            for result in results:
                if isinstance(result, Exception):
                    print(f"  ⚠ Task exception: {result}")
                    continue
                if result.get("success"):
                    success_count += 1
                if result.get("task_subtype") == "add_contact" or result.get("pair_id"):
                    await report_result("warmup_chat", result)
                else:
                    await report_result("warmup", result)
            
            fail_count = len(results) - success_count
            print(f"  [RESULT] Batch complete: {success_count} success, {fail_count} failed")
            
            if RUNNING and delay_after > 0:
                print(f"  [WAIT] Waiting {delay_after}s before next batch...")
                await asyncio.sleep(delay_after)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
    
    print("\n[STOP] Warmup loop stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("=" * 60)
    print("  Starting Warmup Runner - RUNS FOREVER")
    print("  Polls server every 7 seconds for tasks")
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
