
# Plan: Add Auto-Cleanup for Old Conversations Without Replies

## Problem Identified
- **2,935 conversations** older than 5 days exist without any reply (has_reply = false)
- There is NO cleanup mechanism for conversations currently
- The cleanup edge function only handles warmup data, proxy errors, and logs

## Solution

### 1. Add Conversation Cleanup to Utilities Edge Function
**File:** `supabase/functions/utilities/index.ts`

Add cleanup logic to delete old conversations without replies:
- Delete conversations where `created_at < 5 days ago` AND `has_reply = false`
- Also delete associated messages for those conversations

### 2. Keep Conversations With Replies Forever
- Conversations with `has_reply = true` will be preserved
- Only conversations where outreach was sent but no response was received will be cleaned

## Technical Details

```text
Cleanup Criteria:
┌─────────────────────────────────────────────────────┐
│  DELETE conversations WHERE:                        │
│  - created_at < NOW() - 5 days                      │
│  - has_reply = false                                │
│  - first_message_sent = true (optional filter)      │
└─────────────────────────────────────────────────────┘
```

### Files to Modify

1. **supabase/functions/utilities/index.ts**
   - Add conversation + message cleanup in the `/cleanup` route
   - Delete messages first (foreign key), then conversations
   - Add `conversation_cleanup_days` parameter (default: 5)

### Implementation Steps

1. Modify cleanup function to accept `conversation_days` parameter (default 5)
2. Delete messages belonging to old no-reply conversations first
3. Delete the old no-reply conversations
4. Return count of deleted conversations in response

### Expected Impact
- Removes ~2,935 old conversations immediately when cleanup runs
- Keeps all conversations with replies intact
- Reduces database size and improves query performance
