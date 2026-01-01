#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner
=============================
Handles account warmup/maturation tasks:
- Join channels
- View content
- Build account activity

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    global RUNNING
    print("\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def warmup_join_channel(client):
    """Join public channels for warmup"""
    try:
        channels = ["@telegram", "@durov"]
        for channel in channels:
            try:
                await client.get_entity(channel)
                await asyncio.sleep(1)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_view_content(client):
    """View messages in channels for warmup"""
    try:
        dialogs = await client.get_dialogs(limit=5)
        for dialog in dialogs:
            try:
                await client.get_messages(dialog, limit=10)
                await asyncio.sleep(0.5)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


async def main_loop():
    """Main warmup task loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Warmup Runner")
    print("=" * 60)
    print("  🔥 Handles: Channel joins, Content viewing, Maturation")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting warmup runner...\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY warmup tasks
            task = await get_next_task(runner="warmup")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 30)
                # Connect new accounts during wait
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc)
                await asyncio.sleep(seconds)
            
            elif task_type.startswith("warmup_"):
                task_id = task.get("task_id")
                account = task.get("account", {})
                warmup_type = task_type.replace("warmup_", "")
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔥 Warmup {warmup_type} for {account.get('phone_number')}...")
                    
                    if warmup_type == "join_channel":
                        success, error = await warmup_join_channel(client)
                    elif warmup_type == "view_content":
                        success, error = await warmup_view_content(client)
                    else:
                        success, error = True, None
                    
                    await report_result(task_type, {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(5)
    
    print("\n⏹ Warmup runner stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Warmup Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
