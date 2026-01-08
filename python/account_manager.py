#!/usr/bin/env python3
"""
Account Runner - Handles SpamBot, name, photo, privacy, password, contact import
"""
import asyncio
import signal
import os
import base64

from client_manager import (
    get_or_create_client, get_next_task, report_result, shutdown_all, 
    validate_contact, SESSION_FOLDER
)

RUNNING = True

def signal_handler(sig, frame):
    global RUNNING
    print("\n[STOP] Shutting down...")
    RUNNING = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


async def check_spambot(client):
    """Check SpamBot - detects banned, restricted"""
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        messages = await client.get_messages(spambot, limit=1)
        response = messages[0].text if messages else "No response"
        response_lower = response.lower()
        
        # BANNED state  
        if "banned" in response_lower or "deleted" in response_lower or "заблокирован" in response_lower:
            return "banned", response[:200], response
        # LIMITED state (including frozen)
        if "limited" in response_lower or "restricted" in response_lower or "ограничен" in response_lower or "frozen" in response_lower or "заморожен" in response_lower:
            return "restricted", "Limited", response
        # CLEAN state
        if "no limits" in response_lower or "good news" in response_lower:
            return "active", None, response
        return "active", None, response
    except Exception as e:
        error_str = str(e).lower()
        if "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), f"Error: {e}"
        if "auth" in error_str or "session" in error_str:
            return "disconnected", str(e), f"Error: {e}"
        return "active", None, f"Error: {e}"


async def change_name(client, first_name: str, last_name: str = ""):
    try:
        from telethon.tl.functions.account import UpdateProfileRequest
        await client(UpdateProfileRequest(first_name=first_name, last_name=last_name))
        return True, None
    except Exception as e:
        return False, str(e)


async def change_profile_photo(client, photo_source: str):
    """Change profile photo - accepts base64 or URL"""
    try:
        from telethon.tl.functions.photos import UploadProfilePhotoRequest
        import aiohttp
        
        temp_path = os.path.join(SESSION_FOLDER, "temp_photo.jpg")
        
        # Check if it's a URL or base64
        if photo_source.startswith("http://") or photo_source.startswith("https://"):
            # Download from URL
            async with aiohttp.ClientSession() as session:
                async with session.get(photo_source) as resp:
                    if resp.status == 200:
                        photo_bytes = await resp.read()
                        with open(temp_path, "wb") as f:
                            f.write(photo_bytes)
                    else:
                        return False, f"Failed to download image: HTTP {resp.status}"
        else:
            # Assume base64
            photo_bytes = base64.b64decode(photo_source)
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


async def verify_session(client, account_id):
    """Verify if session is active by checking get_me()"""
    try:
        me = await asyncio.wait_for(client.get_me(), timeout=10)
        if me:
            return "active", None, {
                "telegram_id": me.id,
                "username": me.username,
                "first_name": me.first_name,
                "last_name": me.last_name
            }
        return "disconnected", "Could not get user info", None
    except asyncio.TimeoutError:
        return "disconnected", "Connection timeout", None
    except Exception as e:
        error_str = str(e).lower()
        if "auth" in error_str or "session" in error_str or "revoked" in error_str:
            return "disconnected", str(e), None
        elif "banned" in error_str or "deleted" in error_str or "deactivated" in error_str:
            return "banned", str(e), None
        return "disconnected", str(e), None


async def main_loop():
    print("=" * 50)
    print("  Account Runner")
    print("  [SpamBot, Name, Photo, Privacy, Import]")
    print("=" * 50)
    
    while RUNNING:
        try:
            task = await get_next_task(runner="account")
            task_type = task.get("task", "wait")
            
            if task_type == "wait":
                await asyncio.sleep(task.get("seconds", 2))
            
            elif task_type == "spambot_check":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [SPAM] Checking {account.get('phone_number')}...")
                    status, ban_reason, response = await check_spambot(client)
                    await report_result("spambot_check", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "ban_reason": ban_reason, "response": response})
                    print(f"    Result: {status}")
            
            elif task_type == "contact_import":
                account = task.get("account", {})
                task_id = task.get("task_id")
                phone_numbers = task.get("phone_numbers", [])
                valid_numbers = list(task.get("valid_numbers", []))
                invalid_numbers = list(task.get("invalid_numbers", []))
                
                client = await get_or_create_client(account)
                if client:
                    print(f"  [IMPORT] Validating {len(phone_numbers)} contacts...")
                    for phone in phone_numbers:
                        if not RUNNING:
                            break
                        try:
                            exists, name, telegram_id = await validate_contact(client, phone)
                            if exists:
                                valid_numbers.append(phone)
                                print(f"    + {phone} valid")
                            else:
                                invalid_numbers.append(phone)
                                print(f"    - {phone} invalid")
                        except Exception as e:
                            err = str(e).lower()
                            if "flood" in err or "restricted" in err or "banned" in err:
                                remaining = [p for p in phone_numbers if p not in valid_numbers and p not in invalid_numbers]
                                await report_result("contact_import", {
                                    "task_id": task_id,
                                    "success": False,
                                    "account_failed": True,
                                    "failed_account_id": account.get("id"),
                                    "remaining_numbers": remaining,
                                    "valid_numbers": valid_numbers,
                                    "invalid_numbers": invalid_numbers,
                                    "error": str(e)
                                })
                                print(f"  [WARN] Account restricted, switching...")
                                break
                            invalid_numbers.append(phone)
                    else:
                        await report_result("contact_import", {
                            "task_id": task_id,
                            "success": True,
                            "valid_numbers": valid_numbers,
                            "invalid_numbers": invalid_numbers
                        })
                        print(f"  [OK] Import: {len(valid_numbers)} valid, {len(invalid_numbers)} invalid")
            
            elif task_type == "change_name":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [NAME] Changing...")
                    success, error = await change_name(client, task_data.get("first_name", ""), task_data.get("last_name", ""))
                    await report_result("change_name", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error, "first_name": task_data.get("first_name"), "last_name": task_data.get("last_name")})
            
            elif task_type == "change_photo":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PHOTO] Changing...")
                    # Support both photo_url and photo_base64
                    photo_source = task_data.get("photo_url") or task_data.get("photo_base64", "")
                    success, error = await change_profile_photo(client, photo_source)
                    await report_result("change_photo", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "privacy_settings":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PRIVACY] Updating...")
                    success, error = await update_privacy(client, task_data.get("hidePhone", False), task_data.get("hideLastSeen", False), task_data.get("disableCalls", False))
                    await report_result("privacy_settings", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "change_password":
                task_data = task.get("task_data", {})
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [PASS] Changing...")
                    success, error = await change_password(client, task_data.get("existing_password", ""), task_data.get("new_password", ""))
                    await report_result("change_password", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "logout_sessions":
                account = task.get("account", {})
                client = await get_or_create_client(account)
                if client:
                    print(f"  [LOGOUT] Logging out other sessions...")
                    success, error = await logout_other_sessions(client)
                    await report_result("logout_sessions", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": success, "error": error})
            
            elif task_type == "verify_session":
                account = task.get("account", {})
                print(f"  [VERIFY] Checking {account.get('phone_number')}...")
                try:
                    client = await get_or_create_client(account)
                    if client:
                        status, error, user_data = await verify_session(client, account.get("id"))
                        await report_result("verify_session", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": status, "error": error, "user_data": user_data})
                        print(f"    Status: {status}" + (f" ({error})" if error else ""))
                    else:
                        await report_result("verify_session", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": "disconnected", "error": "Could not connect"})
                        print(f"    Could not connect")
                except Exception as e:
                    await report_result("verify_session", {"task_id": task.get("task_id"), "account_id": account.get("id"), "status": "disconnected", "error": str(e)})
                    print(f"    Error: {e}")
            
            elif task_type == "sync_profile":
                account = task.get("account", {})
                print(f"  [SYNC] Syncing profile for {account.get('phone_number')}...")
                try:
                    client = await get_or_create_client(account)
                    if client:
                        me = await client.get_me()
                        if me:
                            # Get profile photo if available
                            avatar_url = None
                            try:
                                photos = await client.get_profile_photos("me", limit=1)
                                if photos:
                                    # Download to bytes and encode
                                    photo_bytes = await client.download_media(photos[0], bytes)
                                    if photo_bytes:
                                        avatar_url = f"data:image/jpeg;base64,{base64.b64encode(photo_bytes).decode()}"
                            except:
                                pass
                            
                            await report_result("sync_profile", {
                                "task_id": task.get("task_id"),
                                "account_id": account.get("id"),
                                "success": True,
                                "first_name": me.first_name,
                                "last_name": me.last_name or "",
                                "username": me.username,
                                "telegram_id": me.id,
                                "avatar_url": avatar_url
                            })
                            print(f"    Synced: {me.first_name} {me.last_name or ''}")
                        else:
                            await report_result("sync_profile", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": False, "error": "Could not get user info"})
                    else:
                        await report_result("sync_profile", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": False, "error": "Could not connect"})
                except Exception as e:
                    await report_result("sync_profile", {"task_id": task.get("task_id"), "account_id": account.get("id"), "success": False, "error": str(e)})
                    print(f"    Error: {e}")
        
        except Exception as e:
            print(f"  [ERROR] {e}")
            await asyncio.sleep(1)
    
    await shutdown_all()


if __name__ == "__main__":
    print("\nInstall: pip install telethon httpx aiohttp\n")
    
    while True:  # FOREVER LOOP WITH CRASH RECOVERY
        try:
            asyncio.run(main_loop())
        except KeyboardInterrupt:
            print("\n⏹ Stopping...")
            break
        except Exception as e:
            print(f"\n⚠ Account Manager crashed: {e}")
            print("  Restarting in 5 seconds...")
            import time
            time.sleep(5)
    
    print("Goodbye!")
