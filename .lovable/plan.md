

# Investigation Results: Incoming Messages Not Received

## Summary

After thorough investigation, the issue is confirmed to be on the **Python runner side**, not the dashboard or backend.

## Evidence

### Database Analysis
- Last incoming message: `2026-01-30 08:07:30` (over 3 hours ago)
- All 64+ recent messages are `direction: outgoing`
- All conversations show `has_reply: false`

### Edge Function Logs
- Runner heartbeat: Active (every 5-7 seconds)
- Task fetches: "Returning 0 tasks, 15 accounts" - accounts are loaded correctly
- Report calls: Only for campaign sends (6 calls at 10:52 AM)
- **No incoming message reports at all**

### Verified Working Components
| Component | Status | Evidence |
|-----------|--------|----------|
| Backend `processIncomingMessage()` | Ready | Code at lines 934-1115 handles incoming messages correctly |
| Realtime subscriptions | Working | SeatChat subscribes to messages/conversations tables |
| Frontend query filters | Correct | Shows `first_message_sent OR has_reply` |
| Account status filter | Fixed | Now includes active/cooldown/restricted for listening |

## Root Cause

The Python runner (`unified_runner.py`) is not sending incoming messages to the backend. This is external to the Lovable dashboard.

## What the Python Runner Needs

The runner must:

1. **Register event handlers on all connected Telethon clients:**
```python
@client.on(events.NewMessage(incoming=True))
async def handle_incoming(event):
    # Only process messages from users (not channels/bots)
    if not event.is_private:
        return
    
    sender = await event.get_sender()
    await report_incoming_message(
        account_id=account_uuid,
        sender_id=sender.id,
        sender_phone=sender.phone,
        sender_name=sender.first_name,
        sender_username=sender.username,
        content=event.message.text or "[Media]",
        telegram_message_id=event.message.id,
        media_data=await get_media_base64(event) if event.message.media else None
    )
```

2. **Report to the backend:**
```python
async def report_incoming_message(account_id, sender_id, sender_phone, ...):
    await requests.post(
        f"{SUPABASE_URL}/functions/v1/runner-tasks/report",
        json={
            "task_type": "incoming",
            "result": {
                "account_id": account_id,
                "sender_id": sender_id,
                "sender_phone": sender_phone,
                "sender_name": sender_name,
                "sender_username": sender_username,
                "content": content,
                "telegram_message_id": telegram_message_id,
                "media_url": media_data,  # Base64 if present
                "media_type": media_type   # "image", "video", etc.
            }
        }
    )
```

## Expected Report Format

The backend expects this payload on `/runner-tasks/report`:

```json
{
  "task_type": "incoming",
  "result": {
    "account_id": "uuid-of-receiving-account",
    "sender_id": 123456789,
    "sender_phone": "+919123456789",
    "sender_name": "John",
    "sender_username": "john_doe",
    "content": "Hello, I'm interested!",
    "telegram_message_id": 12345,
    "media_url": "data:image/jpeg;base64,/9j/...",
    "media_type": "image"
  }
}
```

## Action Required

**Update the Python runner** to:
1. Set up `NewMessage` event handlers when connecting accounts
2. Report incoming private messages to `/runner-tasks/report`
3. Include the `telegram_message_id` for deduplication
4. Handle media by converting to base64 (the backend will upload to storage)

Once the runner reports incoming messages, they will:
- Automatically appear in the Conversations page
- Update conversation `has_reply` flag via trigger
- Increment `unread_count` atomically
- Show in SeatChat for the assigned seat
- Trigger notifications via realtime subscriptions

