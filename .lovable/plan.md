
# Plan: Fix Live Chat Message Reception

## Problem Identified

You're not seeing incoming messages in the admin dashboard. After investigation, I found **three issues**:

### Issue 1: Contact Filter is Too Strict

The `on_message()` handler checks `if not getattr(sender, 'contact', False): return`

**Why this fails:**
- When you send a campaign, `ImportContactsRequest` is used to resolve the recipient's phone number
- BUT this is a one-way import - it adds them to YOUR contacts temporarily
- Telegram's `sender.contact` attribute only returns `True` if:
  - They are in YOUR saved contacts AND
  - The contact relationship is recognized by Telegram
- In practice, campaign recipients often have `sender.contact = False` even after you messaged them

**Result:** Most replies from campaign recipients are silently ignored.

### Issue 2: Silent Error Handling (Bare `except: pass`)

```python
async def on_message(event, acc_id: str):
    try:
        # ... handler code
    except:
        pass  # ← ALL ERRORS SILENTLY SWALLOWED
```

This hides ALL errors - if anything fails (network, parsing, reporting), you get no logs.

### Issue 3: No Debug Logging for Skipped Messages

When a message is filtered out (non-contact), there's no log entry. You can't tell if messages are being received and filtered vs. not received at all.

## Solution

### 1. Change Filter Logic: Use Conversation-Based Filtering

Instead of filtering by `sender.contact`, check if a conversation already exists for this sender (meaning you messaged them first via a campaign):

```python
async def on_message(event, acc_id: str):
    """Handle incoming messages - only from users we've messaged first."""
    try:
        if not event.is_private:
            return
        
        sender = await event.get_sender()
        if not sender or not isinstance(sender, User) or getattr(sender, 'bot', False):
            return
        
        sender_id = sender.id
        phone = None
        if hasattr(sender, 'phone') and sender.phone:
            phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
        
        name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
        
        # Always report to backend - let backend filter based on existing conversations
        # This way, only replies to campaign recipients will create/update conversations
        # (Backend already handles: find conversation → if none exists for unknown sender, create it)
        # ...
```

**Alternative approach (stricter):** Check if this sender matches an existing conversation or campaign recipient in the database before processing. This would require an API call to check.

### 2. Add Proper Error Logging

Replace silent `except: pass` with logged errors:

```python
async def on_message(event, acc_id: str):
    try:
        # ... handler code
    except Exception as e:
        acc = accounts.get(acc_id, {})
        phone = acc.get('phone_number', '?')[-4:]
        print(f"  [MSG-ERR] [{phone}] Error handling incoming: {str(e)[:50]}")
```

### 3. Add Debug Logging for Contact Filter

If keeping the contact filter, add visibility:

```python
# Log when we skip non-contacts (so you can see if messages are being received)
if not getattr(sender, 'contact', False):
    acc = accounts.get(acc_id, {})
    phone = acc.get('phone_number', '?')[-4:]
    name = f"{sender.first_name or ''} {sender.last_name or ''}".strip()[:15]
    print(f"  [SKIP] [{phone}] Non-contact: {name} (ID: {sender.id})")
    return
```

### 4. Same Fix for `fetch_unread_messages()`

Apply the same logic to the unread sync function.

## Implementation Summary

| Location | Change |
|----------|--------|
| `on_message()` | Remove contact filter OR add logging for skipped messages |
| `on_message()` exception | Add proper error logging instead of `except: pass` |
| `fetch_unread_messages()` | Same: remove/log contact filter |
| `report()` | Add error logging for failed API calls |

## Recommended Approach

**Option A: Remove contact filter entirely** (simpler)
- All incoming private messages are reported
- Backend already filters/creates conversations
- Non-campaign messages will create new conversations (you can filter in UI)

**Option B: Keep contact filter with debug logging** (current approach)
- Add print statements for skipped messages
- You can see what's being filtered
- Relies on ImportContacts working (may miss replies)

**Option C: Backend-validated filtering** (most accurate)
- Before processing, call backend to check if sender matches existing conversation
- Most accurate but adds latency to every incoming message

I recommend **Option A** (remove contact filter) because:
1. The backend already has conversation logic
2. Conversations are only created for users you messaged first (campaigns)
3. You can always filter "spam" in the UI later
4. It's the simplest fix

## Files to Modify

**File:** `src/pages/SetupGuide.tsx` (the unified_runner.py script)

Lines to change:
- ~850: Remove or modify contact filter in `on_message()`
- ~902-903: Replace `except: pass` with proper logging
- ~937-940: Remove or modify contact filter in `fetch_unread_messages()`
