

# Plan: Fix Incoming Message Matching for Seats

## Root Cause Identified

When the Campaign Runner sends messages, it creates conversations with **only** `recipient_phone` populated. All other matching fields are NULL:

| Field | Current Value | Impact |
|-------|--------------|--------|
| `recipient_telegram_id` | NULL | Can't match by Telegram ID |
| `recipient_username` | NULL | Can't match by username |
| `recipient_name` | NULL | No display name |

When someone replies on Telegram, the `report-task-result` edge function tries to match the incoming message to an existing conversation using:

1. **Priority 1**: Match by `sender_id` (telegram_id) → FAILS (all NULL)
2. **Priority 2**: Match by `sender_username` → FAILS (all NULL)
3. **Priority 3**: Match by `sender_phone` → MAY FAIL (Telegram often doesn't expose phone)

Because the matching fails, incoming messages are **skipped** with the warning:
```
Could not find existing conversation for incoming message - SKIPPING
```

---

## Solution

Update the **Campaign Runner** in `SetupGuide.tsx` to capture the recipient's Telegram ID when a message is successfully sent, and report it back to the database.

### Part 1: Capture telegram_id on Successful Send

**File**: `src/pages/SetupGuide.tsx`

**Location**: Campaign Runner send success handler (around line 4370-4450)

When `SendMessageRequest` returns successfully, the `access_hash` and `user_id` are available from the resolved entity. We need to:

1. Extract the recipient's `telegram_id` from the `InputPeerUser`
2. Include it in the `report_result("send_success", ...)` call
3. Update `report-task-result` to save it to the conversation

**Current Code** (simplified):
```python
sent_message = await client(SendMessageRequest(peer=input_peer, message=final_message))
# Only reports success, but doesn't capture recipient's telegram_id
await report_result("send_success", {
    "campaign_recipient_id": recipient_id,
    "message_id": pending_msg_id,
    ...
})
```

**Updated Code**:
```python
sent_message = await client(SendMessageRequest(peer=input_peer, message=final_message))

# Capture recipient's telegram_id from the input_peer (available after resolution)
recipient_telegram_id = None
if hasattr(input_peer, 'user_id'):
    recipient_telegram_id = input_peer.user_id

await report_result("send_success", {
    "campaign_recipient_id": recipient_id,
    "message_id": pending_msg_id,
    "recipient_telegram_id": recipient_telegram_id,  # NEW FIELD
    ...
})
```

### Part 2: Update Edge Function to Save telegram_id

**File**: `supabase/functions/report-task-result/index.ts`

**Location**: `send_success` handler (around line 400-500)

Add logic to update the conversation's `recipient_telegram_id` when receiving the new field:

```typescript
// In send_success handler, after marking message as sent:
if (result.recipient_telegram_id && conversationId) {
  await supabase
    .from("conversations")
    .update({ recipient_telegram_id: result.recipient_telegram_id })
    .eq("id", conversationId)
    .is("recipient_telegram_id", null);  // Only update if not already set
}
```

### Part 3: Improve Phone Matching (Fallback Fix)

**File**: `supabase/functions/report-task-result/index.ts`

**Location**: `incoming_message` handler, Priority 3 phone matching (line 1119-1144)

Currently the phone matching doesn't normalize formats properly. Add more aggressive normalization:

```typescript
// Enhanced phone matching - strip ALL non-digits for comparison
if (!convId && sender_phone) {
  const normalizedPhone = sender_phone.replace(/\D/g, '');  // Keep only digits
  
  // Try to find by normalized phone (last 10 digits)
  const last10 = normalizedPhone.slice(-10);
  
  const { data: phoneConv } = await supabase
    .from("conversations")
    .select("*")
    .eq("account_id", account_id)
    .filter("recipient_phone", "like", `%${last10}`);  // Match last 10 digits
    
  if (phoneConv && phoneConv.length > 0) {
    convId = phoneConv[0].id;
  }
}
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | Extract `recipient_telegram_id` from `InputPeerUser` after successful send |
| `src/pages/SetupGuide.tsx` | Include `recipient_telegram_id` in `report_result("send_success", ...)` |
| `supabase/functions/report-task-result/index.ts` | Save `recipient_telegram_id` to conversation on send success |
| `supabase/functions/report-task-result/index.ts` | Improve phone matching fallback with digit-only normalization |

---

## Expected Outcome

```text
Campaign Send:
  → Message sent to +919329159376
  → Resolved to telegram_id: 123456789
  → Conversation updated: recipient_telegram_id = 123456789

User Reply:
  → Incoming message from telegram_id: 123456789
  → Priority 1 match: FOUND conversation by telegram_id ✓
  → Message saved, has_reply = true, unread_count++
  → Admin sees reply in Seats page ✓
```

---

## Technical Details

The Telethon `InputPeerUser` object after resolution contains:
- `user_id`: The recipient's Telegram ID (int64)
- `access_hash`: For future API calls (already being used)

The Campaign Runner already resolves contacts to get the `access_hash`, so extracting `user_id` requires no additional API calls.

