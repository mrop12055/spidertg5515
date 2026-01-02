#!/usr/bin/env python3
"""
TelegramCRM - Account Manager
==============================
Handles account management tasks:
- SpamBot check
- Change name
- Change photo
- Privacy settings
- Change password
- Logout other sessions

Run: python account_manager.py
Stop: Ctrl+C
"""

import asyncio
import signal
import os
import base64

from client_manager import (
    get_or_create_client, get_next_task, report_result,
    shutdown_all, SESSION_FOLDER
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


async def check_spambot(client):
    """Check SpamBot for account status"""
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
            return "restricted", None, response
        elif "banned" in response_lower:
            return "banned", response[:200], response
        return "active", None, response
    except Exception as e:
        return "active", None, f"Error: {e}"


async def change_name(client, first_name: str, last_name: str = ""):
    """Change account name on Telegram"""
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_base64: str):
    """Change profile photo on Telegram"""
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


async def update_privacy(client, hide_phone: bool, hide_last_seen: bool, disable_calls: bool):
    """Update privacy settings"""
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


async def change_password(client, existing_pwd: str, new_pwd: str):
    """Change 2FA cloud password"""
    try:
        from telethon.tl.functions.account import UpdatePasswordSettingsRequest, GetPasswordRequest
        from telethon.password import compute_check
        
        pwd = await client(GetPasswordRequest())
        
        if pwd.has_password and existing_pwd:
            check = compute_check(pwd, existing_pwd)
        else:
            check = None
        
        from telethon.tl.types.account import PasswordInputSettings
        new_settings = PasswordInputSettings(new_algo=pwd.new_algo, new_password_hash=new_pwd.encode())
        await client(UpdatePasswordSettingsRequest(password=check, new_settings=new_settings))
        return True, None
    except Exception as e:
        return False, str(e)


async def logout_other_sessions(client):
    """Logout all other sessions"""
    try:
        from telethon.tl.functions.auth import ResetAuthorizationsRequest
        await client(ResetAuthorizationsRequest())
        return True, None
    except Exception as e:
        return False, str(e)


async def main_loop():
    """Main account management loop"""
    global RUNNING
    
    print("=" * 60)
    print("  TelegramCRM - Account Manager")
    print("=" * 60)
    print("  🔧 Handles: SpamBot check, Name change, Photo, Privacy")
    print("  ⏹ Stop: Press Ctrl+C")
    print("=" * 60)
    print("\n✓ Starting account manager...\n")
    
    while RUNNING:
        try:
            # Get next task - ONLY account tasks
            task = await get_next_task(runner="account")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                seconds = task.get("seconds", 5)
                await asyncio.sleep(seconds)
            
            elif task_type == "spambot_check":
                task_id = task.get("task_id")
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  🤖 SpamBot check for {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "status": status,
                        "ban_reason": ban_reason,
                        "response": response
                    })
                    print(f"    Result: {status}")
            
            elif task_type == "change_name":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  ✏️ Changing name for {account.get('phone_number')}...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "first_name": task_data.get("first_name"),
                        "last_name": task_data.get("last_name")
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_photo":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  📷 Changing photo for {account.get('phone_number')}...")
                    success, error = await change_profile_photo(client, task_data.get("photo_base64", ""))
                    await report_result("change_photo", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "privacy_settings":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔒 Updating privacy for {account.get('phone_number')}...")
                    success, error = await update_privacy(
                        client,
                        task_data.get("hidePhone", False),
                        task_data.get("hideLastSeen", False),
                        task_data.get("disableCalls", False)
                    )
                    await report_result("privacy_settings", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "change_password":
                task_id = task.get("task_id")
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  🔐 Changing password for {account.get('phone_number')}...")
                    success, error = await change_password(
                        client,
                        task_data.get("existing_password", ""),
                        task_data.get("new_password", "")
                    )
                    await report_result("change_password", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "logout_sessions":
                task_id = task.get("task_id")
                account = task.get("account", {})
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  🚪 Logging out other sessions for {account.get('phone_number')}...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error
                    })
                    print(f"    {'✓ Done' if success else '✗ Failed: ' + str(error)}")
            
            elif task_type == "sync_profile":
                task_id = task.get("task_id")
                account = task.get("account", {})
                
                print(f"  🔄 Syncing profile for {account.get('phone_number')}...")
                # Force full profile sync including avatar
                client = await get_or_create_client(account, skip_avatar=False, force_profile_sync=True)
                if client:
                    await report_result("sync_profile", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": True
                    })
                    print(f"    ✓ Profile synced")
                else:
                    await report_result("sync_profile", {
                        "task_id": task_id,
                        "account_id": account.get("id"),
                        "success": False,
                        "error": "Could not connect"
                    })
                    print(f"    ✗ Failed to connect")
        
        except Exception as e:
            print(f"  ⚠ Loop error: {e}")
            await asyncio.sleep(1)
    
    print("\n⏹ Account manager stopped.")
    await shutdown_all()


if __name__ == "__main__":
    print("Starting Account Manager... Press Ctrl+C to stop.")
    print("Required: pip install telethon httpx")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        print("\n⏹ Keyboard interrupt.")
    finally:
        print("Goodbye!")
