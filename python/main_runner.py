#!/usr/bin/env python3
"""
TelegramCRM - Main Runner (All-in-One)
========================================
Runs ALL tasks in a single script (like before).
Use this if you don't want to run separate files.

For better control, use the individual runners instead:
- campaign_runner.py - Campaign messages only
- live_chat_listener.py - Incoming messages only  
- account_manager.py - Account tasks only
- warmup_runner.py - Warmup tasks only

Run: python main_runner.py
Stop: Ctrl+C
"""

import asyncio
import signal

from telethon import events

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    send_message, validate_contact, shutdown_all, SESSION_FOLDER
)

# Import account functions
import os
import base64

# ========== GLOBAL STATE ==========
RUNNING = True


def signal_handler(sig, frame):
    global RUNNING
    print("\n⏹ Stop signal received...")
    RUNNING = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ========== ACCOUNT FUNCTIONS ==========
async def check_spambot(client):
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(1)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        
        response_lower = response.lower()
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
        elif "limited" in response_lower or "restricted" in response_lower:
            # Keep active - account can still chat, just campaign-restricted
            return "active", None, response
        elif "banned" in response_lower:
            return "banned", response[:200], response
        return "active", None, response
    except Exception as e:
        return "active", None, f"Error: {e}"


async def change_name(client, first_name: str, last_name: str = ""):
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_base64: str):
    try:
        from telethon.tl.functions.photos import UploadProfilePhotoRequest
        photo_bytes = base64.b64decode(photo_base64)
        temp_path = os.path.join(SESSION_FOLDER, "temp_photo.jpg")
        with open(temp_path, "wb") as f:
            f.write(photo_bytes)
        file = await client.upload_file(temp_path)
        await client(UploadProfilePhotoRequest(file=file))
        os.remove(temp_path)
        return True, None
    except Exception as e:
        return False, str(e)


async def update_privacy(client, hide_phone, hide_last_seen, disable_calls):
    try:
        from telethon.tl.functions.account import SetPrivacyRequest
        from telethon.tl.types import InputPrivacyKeyPhoneNumber, InputPrivacyKeyStatusTimestamp, InputPrivacyKeyPhoneCall
        from telethon.tl.types import InputPrivacyValueDisallowAll
        
        if hide_phone:
            await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneNumber(), rules=[InputPrivacyValueDisallowAll()]))
        if hide_last_seen:
            await client(SetPrivacyRequest(key=InputPrivacyKeyStatusTimestamp(), rules=[InputPrivacyValueDisallowAll()]))
        if disable_calls:
            await client(SetPrivacyRequest(key=InputPrivacyKeyPhoneCall(), rules=[InputPrivacyValueDisallowAll()]))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_password(client, existing_pwd, new_pwd):
    try:
        from telethon.tl.functions.account import UpdatePasswordSettingsRequest, GetPasswordRequest
        from telethon.password import compute_check
        pwd = await client(GetPasswordRequest())
        check = compute_check(pwd, existing_pwd) if pwd.has_password and existing_pwd else None
        from telethon.tl.types.account import PasswordInputSettings
        new_settings = PasswordInputSettings(new_algo=pwd.new_algo, new_password_hash=new_pwd.encode())
        await client(UpdatePasswordSettingsRequest(password=check, new_settings=new_settings))
        return True, None
    except Exception as e:
        return False, str(e)


async def logout_other_sessions(client):
    try:
        from telethon.tl.functions.auth import ResetAuthorizationsRequest
        await client(ResetAuthorizationsRequest())
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_join_channel(client):
    try:
        for channel in ["@telegram", "@durov"]:
            try:
                await client.get_entity(channel)
                await asyncio.sleep(1)
            except:
                pass
        return True, None
    except Exception as e:
        return False, str(e)


async def warmup_view_content(client):
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


# ========== MESSAGE HANDLER ==========
async def setup_message_handler(client, account_id: str):
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if sender:
                content = event.message.text or "[Media message]"
                media_type = "image" if event.message.photo else None
                if event.message.photo:
                    content = "[Photo] " + (event.message.text or "")
                
                await report_result("incoming_message", {
                    "account_id": account_id,
                    "sender_id": sender.id,
                    "sender_name": f"{sender.first_name or ''} {sender.last_name or ''}".strip(),
                    "sender_username": sender.username,
                    "content": content,
                    "media_type": media_type
                })
        except Exception as e:
            print(f"    ⚠ Handler error: {e}")


# ========== MAIN LOOP ==========
async def main_loop():
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Main Runner (All-in-One)")
    print("=" * 60)
    print("  📨 Campaigns | 💬 Live Chat | 🔧 Account | 🔥 Warmup")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting main loop...\n")
    
    while RUNNING:
        try:
            task = await get_next_task()  # No runner filter = all tasks
            task_type = task.get("task", "wait")
            
            if task.get("stop_signal"):
                print("⏹ Stop signal from backend. Pausing...")
                await asyncio.sleep(5)
                continue
            
            if task_type == "wait":
                accounts = task.get("accounts", [])
                for acc in accounts:
                    await get_or_create_client(acc, setup_handler=setup_message_handler)
                await asyncio.sleep(task.get("seconds", 0.05))
            
            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                mode = task.get("mode", "campaign")
                
                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    icon = "⚡" if mode == "live" else "📨"
                    print(f"  {icon} Sending to {recipient}...")
                    success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    await report_result("send", {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account.get("id")
                    })
                    print(f"    {'✓ Sent!' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "validate":
                recipients = task.get("recipients", [])
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  📋 Validating {len(recipients)} recipients...")
                    for r in recipients:
                        if not RUNNING:
                            break
                        exists, name, telegram_id = await validate_contact(client, r["phone_number"])
                        await report_result("validate", {"recipient_id": r["id"], "exists": exists, "name": name, "telegram_id": telegram_id})
            
            elif task_type == "spambot_check":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🤖 SpamBot check for {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
                    print(f"    Result: {status}")
            
            elif task_type == "change_name":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  ✏️ Changing name...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_photo":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  📷 Changing photo...")
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
                    await report_result("change_photo", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "privacy_settings":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔒 Updating privacy...")
                    success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                    await report_result("privacy_settings", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_password":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔐 Changing password...")
                    success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                    await report_result("change_password", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "logout_sessions":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  🚪 Logging out other sessions...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type.startswith("warmup_"):
                account = task.get("account", {})
                warmup_type = task_type.replace("warmup_", "")
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔥 Warmup {warmup_type}...")
                    if warmup_type == "join_channel":
                        success, error = await warmup_join_channel(client)
                    elif warmup_type == "view_content":
                        success, error = await warmup_view_content(client)
                    else:
                        success, error = True, None
                    await report_result(task_type, {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(0.1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Main Runner... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
