
# Plan: Upgrade Campaign Runner with Advanced Telethon Code

## Problem Analysis

The current Python runner in `SetupGuide.tsx` is experiencing "Contact not found on Telegram" errors. The root cause appears to be the reliance on basic `ImportContactsRequest` which:
1. Adds contacts to the account's contact list unnecessarily
2. Can trigger rate limits from excessive contact imports
3. Uses basic `send_message(entity, ...)` which triggers internal peer resolution overhead
4. Doesn't cache the `access_hash` for efficient messaging

## Solution Overview

Upgrade all Python templates to use **modern Telethon 2026 best practices**:

1. **ResolvePhoneRequest** - Check if phone exists on Telegram WITHOUT adding to contacts
2. **InputPeerUser with access_hash** - Direct peer addressing for maximum efficiency
3. **Proper retry_contacts handling** - Wait and retry on soft rate limits
4. **GetFullUserRequest** - For comprehensive user validation when needed

---

## Technical Changes

### 1. Update `send_message_to_recipient()` Function (Lines ~960-1118)

**Current Code:**
```python
contact = InputPhoneContact(client_id=random.randint(0, 2**31 - 1), phone=phone, ...)
result = await client(ImportContactsRequest([contact]))
if result.users:
    entity = result.users[0]
```

**New Code - Multi-Strategy Resolution:**
```python
from telethon.functions.contacts import ResolvePhoneRequest, ImportContactsRequest
from telethon.tl.types import InputPeerUser

# Strategy 1: Try cached entity (fastest)
try:
    entity = await client.get_input_entity(phone)
except:
    pass

# Strategy 2: ResolvePhoneRequest (no contact add)
if not entity:
    try:
        result = await client(ResolvePhoneRequest(phone=phone))
        if result.users:
            user = result.users[0]
            entity = InputPeerUser(user_id=user.id, access_hash=user.access_hash)
    except Exception as e:
        if "PHONE_NOT_OCCUPIED" in str(e):
            return False, "User not found on Telegram"

# Strategy 3: ImportContactsRequest fallback (with retry_contacts handling)
if not entity:
    result = await client(ImportContactsRequest([contact]))
    if result.users:
        user = result.users[0]
        entity = InputPeerUser(user_id=user.id, access_hash=user.access_hash)
    elif result.retry_contacts:
        # Telegram says "wait and retry"
        await asyncio.sleep(30)
        result = await client(ImportContactsRequest([contact]))
        if result.users:
            user = result.users[0]
            entity = InputPeerUser(user_id=user.id, access_hash=user.access_hash)
```

### 2. Update `bulk_import_contacts()` Function (Lines ~1165-1255)

**Current Code:**
```python
result = await client(ImportContactsRequest([contact]))
if result.users:
    return (account_id, recipient), result.users[0]
```

**New Code - With InputPeerUser caching:**
```python
from telethon.functions.contacts import ResolvePhoneRequest, ImportContactsRequest
from telethon.tl.types import InputPeerUser

async def import_one(account_id, client, recipient, recipient_name):
    # Try ResolvePhoneRequest first (doesn't add to contacts)
    try:
        result = await asyncio.wait_for(
            client(ResolvePhoneRequest(phone=phone)), timeout=10
        )
        if result.users:
            user = result.users[0]
            # Return InputPeerUser for direct messaging (most efficient)
            return (account_id, recipient), InputPeerUser(
                user_id=user.id, 
                access_hash=user.access_hash
            )
    except Exception as e:
        if "PHONE_NOT_OCCUPIED" in str(e):
            return (account_id, recipient), None
    
    # Fallback: ImportContactsRequest with retry_contacts handling
    result = await client(ImportContactsRequest([contact]))
    if result.users:
        user = result.users[0]
        return (account_id, recipient), InputPeerUser(
            user_id=user.id, 
            access_hash=user.access_hash
        )
    elif result.retry_contacts:
        await asyncio.sleep(30)
        result = await client(ImportContactsRequest([contact]))
        if result.users:
            user = result.users[0]
            return (account_id, recipient), InputPeerUser(
                user_id=user.id, 
                access_hash=user.access_hash
            )
    
    return (account_id, recipient), None
```

### 3. Update `validate_contact()` Function (Lines ~1120-1145)

**Current Code:**
```python
result = await client(ImportContactsRequest([contact]))
if result.users:
    user = result.users[0]
    return True, name, user.id
```

**New Code - Using ResolvePhoneRequest:**
```python
from telethon.functions.contacts import ResolvePhoneRequest

async def validate_contact(client, phone):
    """Validate contact using ResolvePhoneRequest (doesn't add to contacts)."""
    try:
        result = await asyncio.wait_for(
            client(ResolvePhoneRequest(phone=phone)), timeout=15
        )
        if result.users:
            user = result.users[0]
            name = f"{user.first_name or ''} {user.last_name or ''}".strip()
            return True, name, user.id
        return False, None, None
    except Exception as e:
        if "PHONE_NOT_OCCUPIED" in str(e):
            return False, None, None
        # Fallback to ImportContactsRequest for compatibility
        # ... existing code ...
```

### 4. Update `bulk_send_messages()` Function (Lines ~1258-1397)

**Current Code:**
```python
await client.send_message(entity, varied_content, link_preview=True)
```

**New Code - Using SendMessageRequest directly:**
```python
from telethon.functions.messages import SendMessageRequest
from telethon.tl.types import InputPeerUser

# If entity is InputPeerUser (from our improved import), use it directly
if isinstance(entity, InputPeerUser):
    await asyncio.wait_for(
        client(SendMessageRequest(
            peer=entity,
            message=varied_content,
            no_webpage=False,  # Enable link preview
            random_id=random.randint(0, 2**63 - 1)
        )),
        timeout=10
    )
else:
    # Fallback for User objects
    await client.send_message(entity, varied_content, link_preview=True)
```

### 5. Add New Imports to Client Manager

Add these imports to the top of `client_manager.py`:
```python
from telethon.functions.contacts import ResolvePhoneRequest
from telethon.functions.messages import SendMessageRequest
from telethon.tl.types import InputPeerUser
```

### 6. Update Warmup Chat Code

Apply similar changes to the warmup-related functions that import contacts.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/SetupGuide.tsx` | Update all Python templates: `client_manager.py`, `campaign_runner.py`, `send_message_to_recipient()`, `bulk_import_contacts()`, `bulk_send_messages()`, `validate_contact()` |
| `supabase/functions/get-batch-tasks/index.ts` | No changes needed - backend is already correct |
| `supabase/functions/validate-first-message/index.ts` | No changes needed |

---

## Benefits

1. **Faster Contact Resolution**: `ResolvePhoneRequest` is lighter than `ImportContactsRequest`
2. **Cleaner Contact List**: Doesn't add every recipient to account's contacts
3. **Better Rate Limit Handling**: Proper `retry_contacts` response handling with 30s wait
4. **Efficient Messaging**: `InputPeerUser` with cached `access_hash` avoids peer resolution overhead
5. **Reduced API Calls**: Direct peer addressing instead of internal Telethon resolution
6. **Improved Success Rate**: Multi-strategy fallback ensures best possible contact resolution

---

## Implementation Notes

- All changes are in the Python code embedded as strings in `SetupGuide.tsx`
- The Python runner will need to be re-downloaded after these changes
- Existing sessions will continue to work - changes are backwards compatible
- `ResolvePhoneRequest` requires the phone to be in international format (with `+`)
