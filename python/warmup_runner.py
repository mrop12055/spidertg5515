#!/usr/bin/env python3
"""
TelegramCRM - Warmup Runner
============================
Handles 14-day account warm-up tasks:
- Join channels
- View content
- Send reactions
- Profile updates
- Build activity history
- 1-to-1 warmup chat between paired accounts

Run: python warmup_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal
import random

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    shutdown_all
)

# ========== GLOBAL STATE ==========
RUNNING = True

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
    print("\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def join_channel(client, channel_username: str = None):
    """Join a public channel to build history"""
    try:
        from telethon.tl.functions.channels import JoinChannelRequest
        
        # Use provided channel or pick random
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        await client(JoinChannelRequest(entity))
        
        # Small delay to simulate human behavior
        await asyncio.sleep(random.uniform(1, 3))
        
        return True, channel, None
    except Exception as e:
        error_msg = str(e).lower()
        if "already" in error_msg or "participant" in error_msg:
            return True, channel_username, "Already joined"
        return False, channel_username, str(e)


async def view_channel_messages(client, channel_username: str = None):
    """View messages in a channel (marks as read)"""
    try:
        from telethon.tl.functions.messages import GetHistoryRequest, ReadHistoryRequest
        
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        
        # Get recent messages
        history = await client(GetHistoryRequest(
            peer=entity,
            limit=20,
            offset_date=None,
            offset_id=0,
            max_id=0,
            min_id=0,
            add_offset=0,
            hash=0
        ))
        
        if history.messages:
            # Mark as read
            try:
                await client(ReadHistoryRequest(peer=entity, max_id=history.messages[0].id))
            except:
                pass  # Some channels don't support read marking
        
        await asyncio.sleep(random.uniform(2, 5))
        
        return True, channel, len(history.messages) if history.messages else 0
    except Exception as e:
        return False, channel_username, str(e)


async def send_reaction(client, channel_username: str = None):
    """Send a reaction to a message in a channel"""
    try:
        from telethon.tl.functions.messages import SendReactionRequest
        from telethon.tl.types import ReactionEmoji
        
        channel = channel_username or random.choice(WARMUP_CHANNELS)
        entity = await client.get_entity(channel)
        
        # Get recent messages
        messages = await client.get_messages(entity, limit=10)
        
        if messages:
            # Pick a random recent message
            msg = random.choice(messages)
            reaction = random.choice(REACTIONS)
            
            try:
                await client(SendReactionRequest(
                    peer=entity,
                    msg_id=msg.id,
                    reaction=[ReactionEmoji(emoticon=reaction)]
                ))
                await asyncio.sleep(random.uniform(1, 2))
                return True, channel, reaction
            except Exception as e:
                # Reactions might not be allowed
                return True, channel, f"Viewed (reactions disabled: {str(e)[:50]})"
        
        return True, channel, "No messages to react to"
    except Exception as e:
        return False, channel_username, str(e)


async def update_profile_bio(client, bio: str = None):
    """Update profile bio"""
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        
        bios = [
            "✨",
            "🌟",
            "Life is good",
            "Happy days",
            "Living my best life",
            "",  # Clear bio
        ]
        
        new_bio = bio or random.choice(bios)
        await client(UpdateProfileRequest(about=new_bio))
        
        return True, new_bio, None
    except Exception as e:
        return False, None, str(e)


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


async def send_interaction_message(client, recipient_phone: str, message: str):
    """Send a message to another account (bidirectional interaction)"""
    try:
        # Try to find user by phone
        from telethon.tl.functions.contacts import ImportContactsRequest
        from telethon.tl.types import InputPhoneContact
        
        # Import as contact first
        contact = InputPhoneContact(
            client_id=random.randint(0, 999999),
            phone=recipient_phone,
            first_name="Friend",
            last_name=""
        )
        
        result = await client(ImportContactsRequest([contact]))
        
        if result.users:
            user = result.users[0]
            await client.send_message(user, message)
            await asyncio.sleep(random.uniform(1, 3))
            return True, None
        else:
            return False, "Could not find user"
    except Exception as e:
        return False, str(e)


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
        
        # Fallback to phone number - use actual name, not generic placeholder
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
        # Base: 2-4 seconds minimum
        # Plus: ~100ms per character (avg typing speed)
        # Plus: random thinking pause (0-2 seconds)
        base_delay = random.uniform(2, 4)
        typing_delay = len(message) * random.uniform(0.08, 0.15)  # 80-150ms per char
        thinking_pause = random.uniform(0, 2)
        total_typing_time = min(base_delay + typing_delay + thinking_pause, 15)  # Cap at 15s
        
        # Show typing indicator
        async with client.action(user, 'typing'):
            await asyncio.sleep(total_typing_time)
        
        # Send message
        await client.send_message(user, message)
        
        # Small random delay after sending (reading response, etc.)
        await asyncio.sleep(random.uniform(0.5, 2))
        
        return True, None
    except Exception as e:
        return False, str(e)


async def main_loop():
    """Main warmup loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Warmup Runner")
    print("=" * 60)
    print("  🔥 14-Day Account Warm-Up System")
    print("  📌 Tasks: Join channels, View content, React, Profile updates")
    print("  💬 Warmup Chat: 1-to-1 pair conversations")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting warmup runner...\n")
    
    last_runner = "warmup_chat"  # Alternate between runners
    
    while RUNNING:
        try:
            # Alternate between warmup and warmup_chat tasks for fair processing
            runner = "warmup_chat" if last_runner == "warmup" else "warmup_chat"
            last_runner = runner
            
            # Get next task
            task = await get_next_task(runner=runner)
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                # If warmup_chat has nothing, try regular warmup
                if runner == "warmup_chat":
                    task = await get_next_task(runner="warmup")
                    task_type = task.get("task", "wait")
                    if task_type == "wait":
                        seconds = task.get("seconds", 5)
                        await asyncio.sleep(min(seconds, 5))
                        continue
                else:
                    seconds = task.get("seconds", 5)
                    await asyncio.sleep(min(seconds, 5))
                    continue
            
            task_id = task.get("task_id")
            account = task.get("account", {})
            task_data = task.get("task_data", {})
            
            client = await get_or_create_client(account)
            if not client:
                result_type = "warmup_chat" if task_type in ["warmup_chat", "warmup_add_contact"] else "warmup"
                await report_result(result_type, {
                    "task_id": task_id,
                    "success": False,
                    "error": "Could not connect client"
                })
                continue
            
            phone = account.get("phone_number", "Unknown")
            
            if task_type == "warmup_join_channel":
                channel = task_data.get("channel_username") or task.get("channel_username")
                print(f"  📺 Joining channel for {phone}...")
                success, channel_name, error = await join_channel(client, channel)
                await report_result("warmup", {
                    "task_id": task_id,
                    "task_type": "join_channel",
                    "account_id": account.get("id"),
                    "success": success,
                    "channel": channel_name,
                    "error": error
                })
                print(f"    {'✓' if success else '✗'} {channel_name} - {error or 'Joined'}")
            
            elif task_type == "warmup_view_content":
                channel = task_data.get("channel_username") or task.get("channel_username")
                print(f"  👁 Viewing content for {phone}...")
                success, channel_name, count = await view_channel_messages(client, channel)
                await report_result("warmup", {
                    "task_id": task_id,
                    "task_type": "view_content",
                    "account_id": account.get("id"),
                    "success": success,
                    "channel": channel_name,
                    "messages_viewed": count if isinstance(count, int) else 0,
                    "error": count if not isinstance(count, int) else None
                })
                print(f"    {'✓' if success else '✗'} Viewed {count} messages in {channel_name}")
            
            elif task_type == "warmup_send_reaction":
                channel = task_data.get("channel_username") or task.get("channel_username")
                print(f"  ❤️ Sending reaction for {phone}...")
                success, channel_name, reaction = await send_reaction(client, channel)
                await report_result("warmup", {
                    "task_id": task_id,
                    "task_type": "send_reaction",
                    "account_id": account.get("id"),
                    "success": success,
                    "channel": channel_name,
                    "reaction": reaction if success else None,
                    "error": reaction if not success else None
                })
                print(f"    {'✓' if success else '✗'} {reaction}")
            
            elif task_type == "warmup_profile_update":
                bio = task_data.get("bio")
                print(f"  ✏️ Updating profile for {phone}...")
                success, new_bio, error = await update_profile_bio(client, bio)
                await report_result("warmup", {
                    "task_id": task_id,
                    "task_type": "profile_update",
                    "account_id": account.get("id"),
                    "success": success,
                    "bio": new_bio,
                    "error": error
                })
                print(f"    {'✓' if success else '✗'} Bio: {new_bio or 'cleared'}")
            
            elif task_type == "warmup_add_contact":
                target_phone = task_data.get("phone")
                first_name = task_data.get("first_name", "Friend")
                print(f"  👤 Adding contact for {phone}...")
                success, added_phone, error = await add_contact(client, target_phone, first_name)
                await report_result("warmup", {
                    "task_id": task_id,
                    "task_type": "add_contact",
                    "account_id": account.get("id"),
                    "success": success,
                    "contact_phone": added_phone,
                    "error": error
                })
                print(f"    {'✓' if success else '✗'} {added_phone}")
            
            elif task_type == "warmup_interaction":
                # Bidirectional interaction between accounts
                recipient_phone = task_data.get("recipient_phone")
                message = task_data.get("message", "Hey! 👋")
                print(f"  💬 Sending interaction from {phone} to {recipient_phone}...")
                success, error = await send_interaction_message(client, recipient_phone, message)
                await report_result("warmup", {
                    "task_id": task_id,
                    "task_type": "interaction",
                    "account_id": account.get("id"),
                    "recipient_phone": recipient_phone,
                    "success": success,
                    "error": error
                })
                print(f"    {'✓' if success else '✗'} {error or 'Sent'}")
            
            elif task_type == "warmup_add_contact":
                # Save contact before starting warmup chat
                target_phone = task_data.get("phone") or task_data.get("recipient_phone")
                first_name = task_data.get("first_name", "Friend")
                pair_id = task.get("pair_id")
                
                display_phone = target_phone[:8] + "..." if target_phone and len(target_phone) > 8 else target_phone
                print(f"  👤 Saving contact: {phone} adds {display_phone} ({first_name})...")
                
                success, added_phone, error = await add_contact(client, target_phone, first_name)
                await report_result("warmup_chat", {
                    "task_id": task_id,
                    "pair_id": pair_id,
                    "account_id": account.get("id"),
                    "success": success,
                    "error": error,
                    "task_subtype": "add_contact"
                })
                print(f"    {'✓' if success else '✗'} Contact saved")
            
            elif task_type == "warmup_chat":
                # 1-to-1 pair warmup chat with human-like timing
                recipient_phone = task_data.get("recipient_phone")
                recipient_telegram_id = task_data.get("recipient_telegram_id")
                recipient_username = task_data.get("recipient_username")
                recipient_first_name = task_data.get("first_name")  # Use actual name
                message = task_data.get("message", "Hey! 👋")
                pair_id = task.get("pair_id")
                
                display_phone = recipient_phone[:8] + "..." if recipient_phone and len(recipient_phone) > 8 else recipient_phone
                print(f"  🔥 Warmup chat from {phone} to {display_phone}...")
                
                success, error = await send_warmup_chat(
                    client, 
                    recipient_phone, 
                    message, 
                    recipient_telegram_id, 
                    recipient_username,
                    recipient_first_name  # Pass actual name
                )
                await report_result("warmup_chat", {
                    "task_id": task_id,
                    "pair_id": pair_id,
                    "account_id": account.get("id"),
                    "success": success,
                    "error": error
                })
                
                msg_preview = message[:30] + "..." if len(message) > 30 else message
                print(f"    {'✓' if success else '✗'} {msg_preview}")
                
                # Don't add extra delay - the timing is already handled by scheduled_at
            
            else:
                print(f"  ❓ Unknown warmup task: {task_type}")
                await asyncio.sleep(1)
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(2)
    
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
