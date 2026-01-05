#!/usr/bin/env python3
"""
LiveChat Sender - Ultra Fast Message Sending
Uses persistent connections, fast_mode, and minimal latency
"""
import asyncio
import signal

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, shutdown_all, active_clients
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def main_loop():
    print("=" * 50)
    print("  LiveChat Sender (Ultra Fast)")
    print("  [Persistent connections, fast_mode]")
    print("=" * 50)
    
    while RUNNING:
        try:
            task = await get_next_task(runner="livechat_sender")
            task_type = task.get("task", "wait")
            
            if task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                recipient_tid = task.get("recipient_telegram_id")
                account = task.get("account", {})
                account_id = account.get("id")
                
                # Use fast_mode=True for speed - skips profile checks
                # Client is cached after first connection
                client = await get_or_create_client(account, fast_mode=True)
                target = recipient_tid if recipient_tid else recipient
                
                if client and target:
                    content = msg.get("content", "")
                    media_url = msg.get("media_url")
                    
                    # Minimal logging for speed
                    print(f"  [SEND] {recipient}{'...' if media_url else ''}")
                    
                    success, error = await send_message(client, target, content, media_url)
                    
                    # Non-blocking report
                    asyncio.create_task(report_result("send", {
                        "message_id": msg.get("id"), 
                        "success": success, 
                        "error": error, 
                        "account_id": account_id
                    }))
                    
                    print(f"    {'[OK]' if success else '[FAIL] ' + str(error)}")
                else:
                    # Report failure if no client
                    if not client:
                        asyncio.create_task(report_result("send", {
                            "message_id": msg.get("id"),
                            "success": False,
                            "error": "Could not connect account",
                            "account_id": account_id
                        }))
            
            # No delay needed - get_next_task returns immediately if no tasks
            await asyncio.sleep(0.02)
        except Exception as e:
            print(f"  [ERROR] {e}")
            await asyncio.sleep(0.3)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\nInstall: pip install telethon httpx pysocks\n")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\nStopped.")
