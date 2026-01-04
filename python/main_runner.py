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
import random

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
last_campaign_account_id = None  # Track campaign account switches to apply switch delay


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
            return "restricted", None, response
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
async def check_conversation_exists(account_id: str, sender_id: int, sender_username: str = None, sender_phone: str = None) -> bool:
    """
    Check if we have an existing campaign conversation with this sender.
    Uses multi-strategy matching: telegram_id -> username -> phone
    """
    import httpx
    from config import SUPABASE_URL, SUPABASE_KEY
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            # Strategy 1: Match by telegram_id
            response = await http.get(
                f"{SUPABASE_URL}/rest/v1/conversations",
                headers={
                    "apikey": SUPABASE_KEY,
                    "Authorization": f"Bearer {SUPABASE_KEY}"
                },
                params={
                    "account_id": f"eq.{account_id}",
                    "recipient_telegram_id": f"eq.{sender_id}",
                    "first_message_sent": "eq.true",
                    "select": "id"
                }
            )
            if response.status_code == 200 and response.json():
                return True
            
            # Strategy 2: Match by username
            if sender_username:
                username_clean = sender_username.lstrip("@").lower()
                for variant in [f"@{username_clean}", username_clean]:
                    response = await http.get(
                        f"{SUPABASE_URL}/rest/v1/conversations",
                        headers={
                            "apikey": SUPABASE_KEY,
                            "Authorization": f"Bearer {SUPABASE_KEY}"
                        },
                        params={
                            "account_id": f"eq.{account_id}",
                            "recipient_username": f"ilike.{variant}",
                            "first_message_sent": "eq.true",
                            "select": "id"
                        }
                    )
                    if response.status_code == 200 and response.json():
                        return True
            
            # Strategy 3: Match by phone
            if sender_phone:
                import re
                digits = re.sub(r'\D', '', sender_phone)
                for pv in [f"+{digits}", digits, sender_phone]:
                    response = await http.get(
                        f"{SUPABASE_URL}/rest/v1/conversations",
                        headers={
                            "apikey": SUPABASE_KEY,
                            "Authorization": f"Bearer {SUPABASE_KEY}"
                        },
                        params={
                            "account_id": f"eq.{account_id}",
                            "recipient_phone": f"eq.{pv}",
                            "first_message_sent": "eq.true",
                            "select": "id"
                        }
                    )
                    if response.status_code == 200 and response.json():
                        return True
            
            return False
    except Exception as e:
        print(f"    ⚠ Check conversation error: {e}")
        return False


async def setup_message_handler(client, account_id: str):
    """Set up handler for incoming messages - ONLY for campaign-initiated conversations"""
    @client.on(events.NewMessage(incoming=True))
    async def handler(event):
        try:
            sender = await event.get_sender()
            if not sender:
                return
            
            # Skip channel/group messages - only handle private chats
            from telethon.tl.types import User
            if not isinstance(sender, User):
                return

            # Skip bots
            if getattr(sender, 'bot', False):
                return

            # Get sender info for matching
            first_name = getattr(sender, 'first_name', None) or ''
            last_name = getattr(sender, 'last_name', None) or ''
            sender_name = f"{first_name} {last_name}".strip() or str(sender.id)
            sender_username = getattr(sender, 'username', None)
            sender_phone = None
            if hasattr(sender, 'phone') and sender.phone:
                sender_phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone

            # FILTER: Multi-strategy matching for campaign conversations
            conversation_exists = await check_conversation_exists(
                account_id, sender.id, sender_username, sender_phone
            )
            if not conversation_exists:
                import time
                if not hasattr(handler, '_ignored_log') or time.time() - handler._ignored_log.get(sender.id, 0) > 60:
                    if not hasattr(handler, '_ignored_log'):
                        handler._ignored_log = {}
                    handler._ignored_log[sender.id] = time.time()
                    print(f"    [IGNORED] {sender_name} (id={sender.id}): no campaign conversation")
                return
            
            content = event.message.text or "[Media message]"
            media_type = "image" if event.message.photo else None
            if event.message.photo:
                content = "[Photo] " + (event.message.text or "")
            
            print(f"  📥 [IN] From {sender_name}: {content[:50]}...")
            
            await report_result("incoming_message", {
                "account_id": account_id,
                "sender_id": sender.id,
                "sender_name": sender_name,
                "sender_username": getattr(sender, 'username', None),
                "content": content,
                "media_type": media_type
            })
        except Exception as e:
            print(f"    [WARN] Handler error: {e}")


# ========== MAIN LOOP ==========
async def _process_livechat_once() -> bool:
    """While campaign pacing is waiting, keep admin/seat chat instant by processing 1 livechat task."""
    try:
        task = await get_next_task(runner="livechat")
        if task.get("task") != "send":
            return False

        if task.get("mode") != "live":
            return False

        msg = task.get("message", {})
        recipient = task.get("recipient")
        account = task.get("account", {})
        account_id = account.get("id")

        client = await get_or_create_client(account, setup_handler=setup_message_handler)
        if not client or not recipient:
            return False

        print(f"  ⚡ [LIVE] Sending to {recipient}...")
        success, error = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
        await report_result("send", {
            "message_id": msg.get("id"),
            "success": success,
            "error": error,
            "campaign_recipient_id": msg.get("campaign_recipient_id"),
            "account_id": account_id,
        })
        print(f"    {'✓ Sent!' if success else '✗ Failed: ' + str(error)}")
        return True
    except Exception:
        return False


async def _sleep_with_livechat(seconds: float):
    """Sleep, but wake up frequently to process high-priority live chat messages."""
    try:
        seconds = float(seconds)
    except Exception:
        await asyncio.sleep(0)
        return

    if seconds <= 0:
        return

    loop = asyncio.get_event_loop()
    end_at = loop.time() + seconds

    while RUNNING:
        # First, try to process 1 livechat message immediately.
        await _process_livechat_once()

        remaining = end_at - loop.time()
        if remaining <= 0:
            break

        # Sleep in small chunks so admin/seat chat stays responsive.
        await asyncio.sleep(min(0.5, remaining))


async def main_loop():
    global RUNNING, last_campaign_account_id

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
                # IMPORTANT: Respect backend wait time - don't poll faster than the server allows
                wait_seconds = task.get("seconds", 5)
                reason = task.get("reason", "")
                if reason:
                    print(f"  ⏳ {reason}")
                await asyncio.sleep(wait_seconds)

            elif task_type == "send":
                msg = task.get("message", {})
                recipient = task.get("recipient")
                account = task.get("account", {})
                mode = task.get("mode", "campaign")
                settings = task.get("settings", {}) if isinstance(task.get("settings"), dict) else {}
                delay_after = task.get("delay_after")

                account_id = account.get("id")

                # Apply account switch delay for campaign sends (live chat should remain instant)
                if mode == "campaign" and account_id and last_campaign_account_id and last_campaign_account_id != account_id:
                    account_switch_delay = settings.get("accountSwitchDelaySeconds", 30)
                    try:
                        account_switch_delay = float(account_switch_delay)
                    except Exception:
                        account_switch_delay = 30

                    if account_switch_delay > 0:
                        print(f"  🔄 Switching campaign accounts... waiting {account_switch_delay:.1f}s")
                        await _sleep_with_livechat(account_switch_delay)

                client = await get_or_create_client(account, setup_handler=setup_message_handler)
                if client and recipient:
                    icon = "⚡" if mode == "live" else "📨"
                    print(f"  {icon} Sending to {recipient}...")
                    success, error, meta = await send_message(client, recipient, msg.get("content", ""), msg.get("media_url"))
                    payload = {
                        "message_id": msg.get("id"),
                        "success": success,
                        "error": error,
                        "campaign_recipient_id": msg.get("campaign_recipient_id"),
                        "account_id": account_id,
                    }
                    if meta:
                        payload.update(meta)
                    await report_result("send", payload)
                    print(f"    {'✓ Sent!' if success else '✗ Failed: ' + str(error)}")

                    # Apply campaign pacing (but keep livechat responsive during the wait)
                    if RUNNING and mode == "campaign":
                        last_campaign_account_id = account_id

                        delay_seconds: float | None = None
                        if delay_after is not None:
                            try:
                                delay_seconds = float(delay_after)
                            except Exception:
                                delay_seconds = None

                        if delay_seconds is None:
                            min_delay = settings.get("minDelaySeconds", 5)
                            max_delay = settings.get("maxDelaySeconds", 15)
                            try:
                                min_delay = float(min_delay)
                                max_delay = float(max_delay)
                            except Exception:
                                min_delay, max_delay = 5.0, 15.0
                            delay_seconds = random.uniform(min_delay, max_delay)

                        if delay_seconds and delay_seconds > 0:
                            print(f"    ⏳ Waiting {delay_seconds:.1f}s before next campaign message...")
                            await _sleep_with_livechat(delay_seconds)

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
            
            elif task_type == "contact_import":
                # New contact import with account fallback
                task_id = task.get("task_id")
                tag_id = task.get("tag_id")
                phone_numbers = task.get("phone_numbers", [])
                valid_numbers = list(task.get("valid_numbers", []))
                invalid_numbers = list(task.get("invalid_numbers", []))
                failed_account_ids = list(task.get("failed_account_ids", []))
                account = task.get("account", {})
                
                print(f"  📋 Contact import: {len(phone_numbers)} numbers with {account.get('phone_number')}")
                
                client = await get_or_create_client(account)
                if not client:
                    # Can't connect - mark account as failed
                    await report_result("contact_import", {
                        "task_id": task_id,
                        "success": False,
                        "account_failed": True,
                        "failed_account_id": account.get("id"),
                        "remaining_numbers": phone_numbers,
                        "valid_numbers": valid_numbers,
                        "invalid_numbers": invalid_numbers,
                        "error": "Could not connect to account"
                    })
                    continue
                
                # Process each phone number
                processed = 0
                for phone in phone_numbers:
                    if not RUNNING:
                        break
                    
                    try:
                        exists, name, telegram_id = await validate_contact(client, phone)
                        if exists:
                            valid_numbers.append(phone)
                            print(f"    ✓ {phone} - valid ({name})")
                        else:
                            invalid_numbers.append(phone)
                            print(f"    ✗ {phone} - not on Telegram")
                        processed += 1
                    except Exception as e:
                        error_str = str(e).lower()
                        # Check if account is restricted/banned
                        if any(x in error_str for x in ['flood', 'restricted', 'banned', 'wait', 'auth_key']):
                            print(f"    ⚠ Account restricted: {e}")
                            # Report partial progress with account failure
                            remaining = phone_numbers[processed:]
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
                            break
                        else:
                            # Other error - count as invalid
                            invalid_numbers.append(phone)
                            print(f"    ✗ {phone} - error: {e}")
                            processed += 1
                else:
                    # All done successfully
                    await report_result("contact_import", {
                        "task_id": task_id,
                        "success": True,
                        "valid_numbers": valid_numbers,
                        "invalid_numbers": invalid_numbers
                    })
                    print(f"    ✓ Import complete: {len(valid_numbers)} valid, {len(invalid_numbers)} invalid")
            
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
            
            elif task_type == "block_contact":
                # Block/unblock a contact
                account = task.get("account", {})
                target = task.get("target", {})
                action = task.get("action", "block")
                client = await get_or_create_client(account)
                if client:
                    print(f"  🚫 {action.capitalize()} contact...")
                    try:
                        from telethon.tl.functions.contacts import BlockRequest, UnblockRequest
                        # Get entity by username or phone
                        target_id = target.get("telegram_id") or target.get("username") or target.get("phone")
                        if target_id:
                            entity = await client.get_entity(target_id)
                            if action == "block":
                                await client(BlockRequest(id=entity))
                            else:
                                await client(UnblockRequest(id=entity))
                            success, error = True, None
                        else:
                            success, error = False, "No target identifier"
                    except Exception as e:
                        success, error = False, str(e)
                    await report_result("block_contact", {
                        "task_id": task.get("task_id"),
                        "account_id": account.get("id"),
                        "success": success,
                        "error": error,
                        "action": action
                    })
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
