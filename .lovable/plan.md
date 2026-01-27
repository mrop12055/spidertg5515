
# Plan: Fix LiveChat Message Sync and Reply Reception

## Problem Summary

Your requirement is to receive messages **only from contacts**. The issue is a **mismatch** between:
1. How campaigns send messages (without adding to contacts)
2. How LiveChat filters messages (requires sender to be in contacts)

### Database Evidence

| Metric | Current Value | Problem |
|--------|--------------|---------|
| Total messages | 439 | All outgoing |
| Incoming messages | 0 | Zero replies recorded |
| Conversations with `has_reply` | 0 | No replies flagged |
| Conversations with `recipient_telegram_id` | 0 | Can't match replies by Telegram ID |

---

## Root Causes

### Issue 1: Campaign Sends Don't Add Recipients to Contacts

The campaign runner uses `ResolvePhoneRequest` as the **first priority** for contact resolution (lines 1442-1454). This method:
- Resolves the phone number to a Telegram user ✓
- Allows sending messages ✓
- Does **NOT** add the user to contacts ✗

The fallback `ImportContactsRequest` **does** add contacts, but it's only used when `ResolvePhoneRequest` fails.

**Result:** Campaign recipients are never added to the sender's contact list.

### Issue 2: LiveChat Filters Out Non-Contact Messages

The LiveChat runner has a strict "contacts only" filter (lines 3198-3202):

```python
is_contact = getattr(sender, 'contact', False)
if not is_contact:
    return  # Message discarded
```

Since campaign recipients aren't contacts, ALL their replies are silently discarded.

### Issue 3: `recipient_telegram_id` Not Captured

Even if messages got through, the `send_one` function (lines 1562-1639) never extracts the Telegram user ID from the resolved entity. Without this ID saved to the database, the edge function can't reliably match incoming replies.

---

## Solution

To maintain your "contacts only" policy while receiving campaign replies, we need to:

1. **Add recipients to contacts immediately after successful send** - This ensures replies pass the filter
2. **Capture `recipient_telegram_id` from the entity** - This enables reliable reply matching

### Changes Required

#### File: `src/pages/SetupGuide.tsx`

**Change 1: Extract `recipient_telegram_id` after successful send (lines 1611-1639)**

After `result["success"] = True`, add:
```python
# Capture telegram_id for reply matching
if isinstance(entity, InputPeerUser):
    result["recipient_telegram_id"] = entity.user_id
elif hasattr(entity, 'id'):
    result["recipient_telegram_id"] = entity.id
```

**Change 2: Add recipient to contacts after successful send (lines 1637-1639)**

After message send succeeds, add the recipient to contacts so their replies pass the `is_contact` filter:

```python
result["success"] = True

# Extract telegram_id for database matching
if isinstance(entity, InputPeerUser):
    result["recipient_telegram_id"] = entity.user_id
elif hasattr(entity, 'id'):
    result["recipient_telegram_id"] = entity.id

# Add to contacts so replies pass the "contacts only" filter
try:
    contact = InputPhoneContact(
        client_id=random.randint(0, 2**31 - 1),
        phone=recipient,
        first_name=task.get("recipient_name") or recipient.replace("+", ""),
        last_name=""
    )
    await asyncio.wait_for(client(ImportContactsRequest([contact])), timeout=5)
except Exception:
    pass  # Don't fail send if contact add fails
```

**Change 3: Update build version (line ~3475)**

```python
print("  BUILD: 2026-01-27-contact-sync-fix")
```

---

## Technical Summary

| Before | After |
|--------|-------|
| `ResolvePhoneRequest` used first | Still used (faster) |
| Recipient not in contacts | Contact added after send |
| `is_contact = False` for replies | `is_contact = True` for replies |
| `recipient_telegram_id = NULL` | Captured from entity |
| Replies discarded at filter | Replies pass filter and sync |

---

## Files to Modify

1. **`src/pages/SetupGuide.tsx`**
   - Lines 1611-1613: Add telegram_id extraction for media sends
   - Lines 1637-1639: Add telegram_id extraction and contact add for text sends
   - Line ~3475: Update build version

---

## Expected Outcome

After this fix:
1. Campaign sends complete successfully ✓
2. Recipient added to contacts immediately after ✓
3. `recipient_telegram_id` saved to database ✓
4. Recipient replies → `is_contact = True` ✓
5. Reply passes filter → reaches edge function ✓
6. Edge function matches by `telegram_id` or `phone` ✓
7. Reply saved to messages table ✓
8. `has_reply = true` and `unread_count` updated ✓
9. Replies appear in Seats and Conversations pages ✓

---

## Note on Database Trigger

The existing `update_conversation_on_message` trigger already updates `has_reply` and `last_message_content` for incoming messages. Once replies start reaching the edge function, these fields will update correctly.
