
# Plan: Fetch Unread Messages on Account Reconnection

## Problem
When the Python runner is offline (crashed, closed, or restarted), incoming messages from contacts are missed. Currently, when the runner reconnects, it only starts listening for **new** messages. Any messages received during the downtime are lost.

## Solution
Add a "catch-up" mechanism that runs when each account successfully connects. This will:
1. Fetch all dialogs (chats) for the account
2. Filter to only **contacts** with unread messages
3. Retrieve and report those unread messages to the backend
4. Mark them as read on Telegram to avoid duplicate processing

---

## Changes Required

### 1. Add `fetch_unread_messages()` Function (Python Runner)
**Location:** `src/pages/SetupGuide.tsx` (inside `unifiedRunnerPy`)

Add a new async function that runs after account connection:

```python
async def fetch_unread_messages(client, acc_id: str):
    """Fetch and report unread messages from contacts after reconnection."""
    acc = accounts.get(acc_id, {})
    phone = acc.get("phone_number", "????")[-4:]
    
    try:
        print(f"  [CATCHUP] [{phone}] Fetching unread messages...")
        dialogs = await client.get_dialogs(limit=100)
        
        total_fetched = 0
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
                limit=min(dialog.unread_count, 50)  # Cap at 50 per contact
            )
            
            for msg in reversed(messages):  # Process oldest first
                if not msg.text and not msg.media:
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
            
            # Mark messages as read
            await client.send_read_acknowledge(dialog.entity)
        
        if total_fetched > 0:
            print(f"  [CATCHUP] [{phone}] Synced {total_fetched} missed messages")
        else:
            print(f"  [CATCHUP] [{phone}] No unread messages from contacts")
            
    except Exception as e:
        print(f"  [CATCHUP] [{phone}] Error: {str(e)[:50]}")
```

### 2. Call `fetch_unread_messages()` After Connection
**Location:** `connect_all_from_response()` function

After successfully connecting each account, call the catch-up function:

```python
async def connect_all_from_response(accs: List[dict]) -> int:
    """Connect accounts and fetch missed messages."""
    print("\\n" + "="*50)
    print("  CONNECTING ACCOUNTS")
    print("="*50)
    
    if not accs:
        print("  No accounts in response")
        return 0
    
    print(f"  Found {len(accs)} accounts...\\n")
    results = await asyncio.gather(*[connect(a) for a in accs], return_exceptions=True)
    ok = sum(1 for r in results if isinstance(r, tuple) and r[0])
    print(f"\\n  Connected: {ok}/{len(accs)}")
    
    # Fetch unread messages for newly connected accounts
    for i, acc in enumerate(accs):
        if isinstance(results[i], tuple) and results[i][0]:
            aid = acc.get("id")
            if aid and aid in clients:
                await fetch_unread_messages(clients[aid], aid)
    
    return ok
```

### 3. Backend Already Handles Incoming Messages
The edge function `runner-tasks/report` already has `processIncomingMessage()` which:
- Deduplicates by `telegram_message_id` (prevents duplicates)
- Finds or creates conversations
- Increments unread counts
- Saves messages with `direction: 'incoming'`

No backend changes are required.

---

## Technical Details

| Aspect | Implementation |
|--------|----------------|
| **When it runs** | After each account successfully connects |
| **What it fetches** | Unread messages from **contacts only** (not groups/channels) |
| **Message limit** | 50 messages per contact, 100 dialogs scanned |
| **Deduplication** | Backend rejects messages with same `telegram_message_id` |
| **Read receipts** | Messages are marked as read on Telegram after fetching |
| **Performance** | Runs in parallel with main loop startup |

---

## Flow Diagram

```
Runner Start/Reconnect
        │
        ▼
┌───────────────────────┐
│  Get accounts from    │
│  /runner-tasks/get    │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│  Connect each account │
│  via proxy            │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐    ◄── NEW
│  fetch_unread_messages│
│  for each connected   │
│  account              │
└───────────────────────┘
        │
        ├── Get dialogs (limit 100)
        │
        ├── Filter: is_user AND is_contact AND unread > 0
        │
        ├── Fetch messages (limit 50 per dialog)
        │
        ├── Report to backend (incoming_message)
        │
        ├── Mark as read on Telegram
        │
        ▼
┌───────────────────────┐
│  Setup NewMessage     │
│  handlers for live    │
│  incoming messages    │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│  Enter main task loop │
└───────────────────────┘
```

---

## Summary

The Python runner will be updated to:
1. Add a `fetch_unread_messages()` function that scans contacts for missed messages
2. Call this function immediately after each account connects
3. Report any unread messages to the backend (which already handles them correctly)
4. Mark messages as read to prevent re-fetching on next restart

This ensures no messages are lost during downtime, and the existing backend deduplication prevents duplicates if the runner restarts multiple times.
