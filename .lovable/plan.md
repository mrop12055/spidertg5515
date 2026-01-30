

# Plan: Restore Contact-Only Filter for Incoming Messages

## What You Want

You want the runner to **only process messages from contacts**, not from all users. This makes sense because:

1. All your campaign recipients are first imported as contacts (via `ImportContactsRequest`)
2. You don't want random spam or messages from strangers in your dashboard
3. Only messages from known contacts (campaign recipients) should appear

## Current State

The contact-only filters were **removed** in the previous fix. Now the runner accepts messages from anyone.

## Changes Required

### 1. Restore Contact Filter in Live Message Handler

**File:** `src/pages/SetupGuide.tsx` (line ~848)

Add back the contact check in `on_message()`:

```python
async def on_message(event, acc_id: str):
    """Handle incoming messages - only from contacts."""
    try:
        if not event.is_private:
            return
        
        sender = await event.get_sender()
        if not sender or not isinstance(sender, User) or getattr(sender, 'bot', False):
            return
        
        # Only process messages from contacts (imported campaign recipients)
        if not getattr(sender, 'contact', False):
            return
        
        # ... rest of handler
```

### 2. Restore Contact Filter in Unread Sync

**File:** `src/pages/SetupGuide.tsx` (line ~928)

Add back the contact check in `fetch_unread_messages()`:

```python
for dialog in dialogs:
    if not dialog.is_user:
        continue
    
    entity = dialog.entity
    
    # Only sync messages from contacts (imported campaign recipients)
    if not getattr(entity, 'contact', False):
        continue
    
    # Skip bots
    if getattr(entity, 'bot', False):
        continue
    
    # ... rest of sync logic
```

## How It Works

```text
Campaign Flow:
  1. You send campaign → Runner imports recipient as CONTACT
  2. Message sent successfully
  3. Recipient is now in your contact list

Reply Flow:
  1. Recipient replies to your message
  2. on_message() fires
  3. Checks: Is sender a contact? YES → Process
  4. Reports to backend → Appears in dashboard

Random Person Flow:
  1. Random person messages you
  2. on_message() fires
  3. Checks: Is sender a contact? NO → Ignored
  4. Nothing happens (spam filtered out)
```

## Summary

| Location | What Changes |
|----------|--------------|
| `on_message()` | Add `if not getattr(sender, 'contact', False): return` |
| `fetch_unread_messages()` | Add `if not getattr(entity, 'contact', False): continue` |

After this change, only replies from your campaign recipients (who were imported as contacts) will appear in the dashboard.

