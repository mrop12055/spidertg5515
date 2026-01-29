
# Plan: Add Missing Account Action Handlers to Python Runner

## Problem
The Python runner shows "Unknown action" errors for these task types:
- `sync_profile` - Fetch profile info from Telegram  
- `privacy_settings` - Configure privacy settings
- `change_password` - Set/change 2FA password
- `logout_sessions` - Terminate other sessions

These actions are created by the Accounts page UI but the runner's `account_action()` function doesn't have handlers for them.

---

## Changes Required

### 1. Add Missing Action Handlers to `account_action()` Function
**File:** `src/pages/SetupGuide.tsx` (inside the Python runner code)

Add these handlers before the "UNKNOWN ACTION" section (~line 607):

```python
# ==========================================================
# SYNC PROFILE
# ==========================================================

elif action == "sync_profile":
    print(f"  [SYNC] [{phone}] Fetching profile from Telegram...")
    me = await asyncio.wait_for(client.get_me(), timeout=15)
    
    if me:
        # Get full user for profile photo
        from telethon.tl.functions.users import GetFullUserRequest
        from telethon.tl.functions.photos import GetUserPhotosRequest
        
        avatar_url = None
        try:
            photos = await client(GetUserPhotosRequest(user_id=me.id, offset=0, max_id=0, limit=1))
            if photos.photos:
                # Download and get photo bytes
                photo = photos.photos[0]
                avatar_url = f"telegram_photo_{me.id}_{photo.id}"  # Placeholder - backend handles actual URL
        except:
            pass
        
        await report("sync_profile", {
            "task_id": task_id,
            "account_id": acc_id,
            "success": True,
            "telegram_id": me.id,
            "first_name": me.first_name,
            "last_name": me.last_name,
            "username": me.username,
            "phone": me.phone,
            "avatar_id": avatar_url
        })
        print(f"  [SYNC] [{phone}] ✓ {me.first_name or ''} {me.last_name or ''} (@{me.username or 'none'})")
        return True, None
    return False, "get_me returned None"

# ==========================================================
# PRIVACY SETTINGS
# ==========================================================

elif action == "privacy_settings":
    from telethon.tl.functions.account import SetPrivacyRequest
    from telethon.tl.types import (
        InputPrivacyKeyPhoneNumber, InputPrivacyKeyStatusTimestamp,
        InputPrivacyKeyPhoneCall, InputPrivacyKeyProfilePhoto,
        InputPrivacyValueAllowAll, InputPrivacyValueAllowContacts,
        InputPrivacyValueDisallowAll
    )
    
    # Parse settings from task_data or result
    settings = td or {}
    if not settings and task.get("result"):
        try:
            import json
            settings = json.loads(task.get("result", "{}"))
        except:
            settings = {}
    
    hide_phone = settings.get("hidePhone", False)
    hide_last_seen = settings.get("hideLastSeen", False)
    disable_calls = settings.get("disableCalls", False)
    hide_photo = settings.get("hideProfilePhoto", False)
    
    print(f"  [PRIVACY] [{phone}] Applying: phone={hide_phone}, lastSeen={hide_last_seen}, calls={disable_calls}, photo={hide_photo}")
    
    # Apply phone visibility
    await client(SetPrivacyRequest(
        key=InputPrivacyKeyPhoneNumber(),
        rules=[InputPrivacyValueDisallowAll()] if hide_phone else [InputPrivacyValueAllowContacts()]
    ))
    
    # Apply last seen visibility
    await client(SetPrivacyRequest(
        key=InputPrivacyKeyStatusTimestamp(),
        rules=[InputPrivacyValueDisallowAll()] if hide_last_seen else [InputPrivacyValueAllowAll()]
    ))
    
    # Apply call settings
    await client(SetPrivacyRequest(
        key=InputPrivacyKeyPhoneCall(),
        rules=[InputPrivacyValueDisallowAll()] if disable_calls else [InputPrivacyValueAllowContacts()]
    ))
    
    # Apply profile photo visibility
    await client(SetPrivacyRequest(
        key=InputPrivacyKeyProfilePhoto(),
        rules=[InputPrivacyValueDisallowAll()] if hide_photo else [InputPrivacyValueAllowAll()]
    ))
    
    await report("privacy_settings", {"task_id": task_id, "account_id": acc_id, "success": True, "settings": settings})
    print(f"  [PRIVACY] [{phone}] ✓ Applied")
    return True, None

# ==========================================================
# CHANGE PASSWORD (2FA)
# ==========================================================

elif action == "change_password":
    from telethon.tl.functions.account import GetPasswordRequest, UpdatePasswordSettingsRequest
    from telethon.tl.types import InputCheckPasswordEmpty
    from telethon.password import compute_check, compute_hash
    
    # Parse password from task_data or result
    settings = td or {}
    if not settings and task.get("result"):
        try:
            import json
            settings = json.loads(task.get("result", "{}"))
        except:
            settings = {}
    
    existing_pw = settings.get("existing_password")
    new_pw = settings.get("new_password")
    
    if not new_pw:
        return False, "No new password provided"
    
    print(f"  [2FA] [{phone}] Setting cloud password...")
    
    try:
        pwd = await client(GetPasswordRequest())
        
        if pwd.has_password and existing_pw:
            # Has existing password, need to verify
            check = compute_check(pwd, existing_pw.encode())
            new_hash = compute_hash(pwd.new_algo, new_pw.encode())
            
            from telethon.tl.types.account import PasswordInputSettings
            await client(UpdatePasswordSettingsRequest(
                password=check,
                new_settings=PasswordInputSettings(
                    new_algo=pwd.new_algo,
                    new_password_hash=new_hash,
                    hint=""
                )
            ))
        elif not pwd.has_password:
            # No existing password, set new one
            new_hash = compute_hash(pwd.new_algo, new_pw.encode())
            
            from telethon.tl.types.account import PasswordInputSettings
            await client(UpdatePasswordSettingsRequest(
                password=InputCheckPasswordEmpty(),
                new_settings=PasswordInputSettings(
                    new_algo=pwd.new_algo,
                    new_password_hash=new_hash,
                    hint=""
                )
            ))
        else:
            return False, "Account has 2FA but no existing password provided"
        
        await report("change_password", {"task_id": task_id, "account_id": acc_id, "success": True})
        print(f"  [2FA] [{phone}] ✓ Password set")
        return True, None
        
    except Exception as e:
        if "PASSWORD_HASH_INVALID" in str(e):
            return False, "Existing password is incorrect"
        raise

# ==========================================================
# LOGOUT OTHER SESSIONS
# ==========================================================

elif action == "logout_sessions":
    from telethon.tl.functions.account import GetAuthorizationsRequest, ResetAuthorizationRequest
    
    print(f"  [LOGOUT] [{phone}] Terminating other sessions...")
    
    auths = await client(GetAuthorizationsRequest())
    current_hash = None
    terminated = 0
    
    for auth in auths.authorizations:
        if auth.current:
            current_hash = auth.hash
        else:
            try:
                await client(ResetAuthorizationRequest(hash=auth.hash))
                terminated += 1
            except:
                pass
    
    await report("logout_sessions", {
        "task_id": task_id, 
        "account_id": acc_id, 
        "success": True, 
        "terminated_count": terminated
    })
    print(f"  [LOGOUT] [{phone}] ✓ Terminated {terminated} session(s)")
    return True, None
```

### 2. Update Task Type Routing in `process_task()` 
**File:** `src/pages/SetupGuide.tsx` (inside the Python runner code)

Add the new task types to the account action routing (around line 966):

```python
# Check actions
elif tt in ("spambot_check", "session_check", "get_me", "sync_profile"):
    await account_action(client, tt, task)

# Privacy/Security actions
elif tt in ("privacy_settings", "change_password", "logout_sessions"):
    await account_action(client, tt, task)
```

---

## Summary of New Actions

| Action | Description | Telegram API Used |
|--------|-------------|-------------------|
| `sync_profile` | Fetch profile (name, username, avatar) | `GetMeRequest`, `GetUserPhotosRequest` |
| `privacy_settings` | Set phone/lastSeen/calls/photo visibility | `SetPrivacyRequest` |
| `change_password` | Set/change 2FA cloud password | `UpdatePasswordSettingsRequest` |
| `logout_sessions` | Terminate all other sessions | `ResetAuthorizationRequest` |

---

## Expected Console Output After Fix

```
[BATCH] 2 tasks: {'sync_profile': 2}

  [SYNC] [6401] Fetching profile from Telegram...
  [SYNC] [6401] ✓ John Doe (@johndoe)

  [SYNC] [9866] Fetching profile from Telegram...
  [SYNC] [9866] ✓ Jane Smith (@janesmith)
```

---

## Technical Notes

1. **Settings Parsing**: Privacy and password tasks store settings in the `result` field as JSON - the runner will parse this
2. **Privacy Rules**: Uses Telegram's privacy rule types (`InputPrivacyValueDisallowAll`, `InputPrivacyValueAllowContacts`, etc.)
3. **2FA Handling**: Properly handles both setting a new password and changing an existing one
4. **Session Safety**: The logout action skips the current session (marked with `auth.current = True`)
