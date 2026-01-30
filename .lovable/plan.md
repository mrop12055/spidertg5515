

# Plan: Fix Incoming Messages Not Being Received

## Problem Summary

You're sending campaign messages successfully, but **replies from recipients are not appearing in the dashboard**. The issue has two parts:

1. **Live incoming messages** - Real-time replies are not being captured
2. **Unread catch-up** - When the runner restarts, old unread messages are not synced

Both issues stem from the **Python runner not reporting incoming messages** to the backend.

## Evidence

| Metric | Value |
|--------|-------|
| Incoming messages in last 24h | 1 (at 8:07 AM) |
| Total conversations | 70 |
| Conversations with replies (`has_reply=true`) | 1 |
| Edge function logs with `[incoming]` | 0 |
| Database triggers on messages table | None active |

All 64+ recent messages are outgoing (direction: "outgoing"). The backend's `processIncomingMessage()` function is ready but never gets called because the runner isn't sending reports.

---

## Root Cause

The Python runner (`unified_runner.py`) needs to:

1. **Listen for live incoming messages** via Telethon event handlers
2. **Sync unread messages on startup** by scanning recent dialogs
3. **Report all incoming messages** to `/runner-tasks/report`

This is **external code** that runs outside of Lovable - the dashboard backend is correctly configured.

---

## What the Python Runner Must Do

### 1. Live Message Handler (Real-Time)

Register event handlers on each connected Telethon client:

```python
from telethon import events

@client.on(events.NewMessage(incoming=True))
async def handle_incoming(event):
    # Only process private messages (DMs)
    if not event.is_private:
        return
    
    sender = await event.get_sender()
    
    # Report to backend
    await report_incoming_message(
        account_id=account_uuid,  # From your accounts list
        sender_id=sender.id,
        sender_phone=getattr(sender, 'phone', None),
        sender_name=sender.first_name,
        sender_username=sender.username,
        content=event.message.text or "[Media]",
        telegram_message_id=event.message.id,
        media_data=await get_media_base64(event) if event.message.media else None,
        media_type=get_media_type(event.message.media)
    )
    
    # Mark as read on Telegram (optional)
    await event.message.mark_read()
```

### 2. Unread Sync on Startup

When the runner starts and connects accounts, scan for unread messages:

```python
async def sync_unread_messages(client, account_id):
    """Scan dialogs for unread messages and report them."""
    async for dialog in client.iter_dialogs(limit=100):
        # Only private chats with unread messages
        if not dialog.is_user or dialog.unread_count == 0:
            continue
        
        # Get unread messages (limit to last 50 per dialog)
        async for message in client.iter_messages(
            dialog.entity, 
            limit=min(dialog.unread_count, 50)
        ):
            if message.out:  # Skip our own messages
                continue
            
            # Only sync messages from last 24 hours
            if message.date < datetime.utcnow() - timedelta(hours=24):
                break
            
            await report_incoming_message(
                account_id=account_id,
                sender_id=dialog.entity.id,
                sender_phone=getattr(dialog.entity, 'phone', None),
                sender_name=dialog.entity.first_name,
                sender_username=dialog.entity.username,
                content=message.text or "[Media]",
                telegram_message_id=message.id,
                media_data=await get_media_base64(message) if message.media else None,
                media_type=get_media_type(message.media)
            )
        
        # Mark dialog as read after syncing
        await client.send_read_acknowledge(dialog.entity)
```

### 3. Report Function

Send incoming messages to the backend:

```python
async def report_incoming_message(
    account_id, sender_id, sender_phone, sender_name, 
    sender_username, content, telegram_message_id, 
    media_data=None, media_type=None
):
    payload = {
        "task_type": "incoming",
        "result": {
            "account_id": str(account_id),
            "sender_id": sender_id,
            "sender_phone": sender_phone,
            "sender_name": sender_name,
            "sender_username": sender_username,
            "content": content,
            "telegram_message_id": telegram_message_id,
        }
    }
    
    # Add media if present
    if media_data:
        payload["result"]["media_url"] = media_data  # Base64 string
        payload["result"]["media_type"] = media_type  # "image", "video", etc.
    
    async with aiohttp.ClientSession() as session:
        await session.post(
            f"{SUPABASE_URL}/functions/v1/runner-tasks/report",
            json=payload,
            headers={
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "Content-Type": "application/json"
            }
        )
```

---

## Expected Payload Format

The backend expects this exact format on `/runner-tasks/report`:

```json
{
  "task_type": "incoming",
  "result": {
    "account_id": "47ae1ef3-e306-4ec2-bb8e-15895d9b319a",
    "sender_id": 123456789,
    "sender_phone": "+919941111333",
    "sender_name": "Customer Name",
    "sender_username": "customer_username",
    "content": "Yes, I'm interested!",
    "telegram_message_id": 12345,
    "media_url": "data:image/jpeg;base64,/9j/4AAQ...",
    "media_type": "image"
  }
}
```

---

## How It Will Work Once Fixed

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         RUNNER LIFECYCLE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. STARTUP                                                         │
│     └── Connect all accounts                                        │
│     └── FOR EACH account:                                           │
│         └── Register NewMessage event handler (live listening)     │
│         └── Call sync_unread_messages() (catch-up)                 │
│                                                                     │
│  2. RUNNING                                                         │
│     └── Event handlers fire on each incoming private message       │
│     └── Each incoming → POST to /runner-tasks/report               │
│                                                                     │
│  3. BACKEND PROCESSING                                              │
│     └── processIncomingMessage() finds/creates conversation        │
│     └── Inserts message with direction='incoming'                  │
│     └── Sets has_reply=true on conversation                        │
│     └── Increments unread_count                                    │
│                                                                     │
│  4. FRONTEND                                                        │
│     └── Realtime subscription triggers                             │
│     └── Message appears in Conversations page                      │
│     └── Notification sound plays                                   │
│     └── SeatChat updates for assigned seat                         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Verification Steps

After updating the Python runner:

1. **Check edge function logs** for `[incoming]` entries
2. **Query the database**: `SELECT * FROM messages WHERE direction = 'incoming' ORDER BY created_at DESC LIMIT 10`
3. **Check conversations**: `SELECT * FROM conversations WHERE has_reply = true`
4. **Send a test reply** from one of the recipient phones and verify it appears in the dashboard

---

## No Dashboard Changes Needed

The backend and frontend are already correctly configured:
- `processIncomingMessage()` is ready (lines 934-1115 in runner-tasks)
- Realtime subscriptions are active on messages and conversations tables
- Conversations page filters include `first_message_sent OR has_reply`
- SeatChat fetches conversations with `has_reply` correctly

The only fix required is in the **external Python runner**.

