

# Plan: Add 24-Hour Time Window Filter to Catch-Up Sync

## Overview

Modify the `fetch_unread_messages` function in the Python runner to only synchronize messages from the last 24 hours during offline catch-up. This prevents syncing old messages when the runner reconnects after extended downtime.

---

## Current Behavior

The catch-up sync currently:
1. Gets dialogs with unread messages
2. Fetches ALL unread messages from contacts
3. Reports them to the backend
4. Marks as read on Telegram

**Problem**: If the runner was offline for days, it would sync ALL accumulated messages, including very old ones.

---

## New Behavior

After the change:
1. Gets dialogs with unread messages
2. Filters messages to only include those from the **last 24 hours**
3. Skips older messages but still marks the dialog as read
4. Reports only recent messages to the backend

---

## Technical Changes

### File: `src/pages/SetupGuide.tsx`

**Location**: Lines 852-913 (`fetch_unread_messages` function)

**Changes**:

1. Import `datetime` and `timedelta` at the top of the Python script (add to imports around line 34-46)

2. Modify the message filtering logic to check message timestamps:

```python
async def fetch_unread_messages(client, acc_id: str):
    """Fetch and report unread messages from contacts after reconnection (24h window)."""
    acc = accounts.get(acc_id, {})
    phone = acc.get("phone_number", "????")[-4:]
    
    # 24-hour cutoff for message sync
    from datetime import datetime, timedelta, timezone
    cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
    
    try:
        print(f"  [CATCHUP] [{phone}] Fetching unread messages (last 24h)...")
        dialogs = await client.get_dialogs(limit=100)
        
        total_fetched = 0
        skipped_old = 0
        
        for dialog in dialogs:
            # Only process direct user chats (not groups/channels)
            if not dialog.is_user:
                continue
            
            # Only process contacts
            entity = dialog.entity
            if not getattr(entity, 'contact', False):
                continue
            
            # Skip if no unread messages
            if dialog.unread_count == 0:
                continue
            
            # Fetch unread messages from this contact
            messages = await client.get_messages(
                dialog.entity, 
                limit=min(dialog.unread_count, 50)
            )
            
            for msg in reversed(messages):  # Process oldest first
                if not msg.text and not msg.media:
                    continue
                
                # SKIP messages older than 24 hours
                if msg.date and msg.date < cutoff_time:
                    skipped_old += 1
                    continue
                    
                sender_phone = None
                if hasattr(entity, 'phone') and entity.phone:
                    sender_phone = f"+{entity.phone}" if not entity.phone.startswith('+') else entity.phone
                
                name = f"{entity.first_name or ''} {entity.last_name or ''}".strip() or str(entity.id)
                content = msg.text or "[Media]"
                
                await report("incoming_message", {
                    "account_id": acc_id,
                    "sender_id": entity.id,
                    "sender_name": name,
                    "sender_username": getattr(entity, 'username', None),
                    "sender_phone": sender_phone,
                    "content": content,
                    "telegram_message_id": msg.id
                })
                total_fetched += 1
            
            # Always mark messages as read (even old ones)
            await client.send_read_acknowledge(dialog.entity)
        
        if total_fetched > 0 or skipped_old > 0:
            print(f"  [CATCHUP] [{phone}] Synced {total_fetched} messages (skipped {skipped_old} older than 24h)")
        else:
            print(f"  [CATCHUP] [{phone}] No recent unread messages from contacts")
            
    except Exception as e:
        print(f"  [CATCHUP] [{phone}] Error: {str(e)[:50]}")
```

---

## Key Improvements

| Aspect | Before | After |
|--------|--------|-------|
| Time filter | None | 24 hours |
| Old messages | Synced | Skipped (but marked read) |
| Logging | Basic count | Shows synced + skipped counts |
| Timezone | Not handled | Uses UTC-aware comparison |

---

## Summary

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | Update `fetch_unread_messages` to filter messages older than 24 hours |

