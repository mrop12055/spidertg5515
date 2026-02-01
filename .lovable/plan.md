

# Fix: Runner Not Processing Send Message Tasks

## Problem Identified

The runner is **not processing livechat send message tasks** because of a **race condition and incorrect self-healing logic**:

1. Admin sends messages from the chat UI → messages are created with `status = 'pending'`
2. Edge function `/get` endpoint marks them as `sending` when fetched (line 619)
3. The runner either crashes, is slow, or another request fetched them first
4. Messages get stuck in `sending` status
5. The self-healing code (lines 176-194) incorrectly marks stale `sending` messages as **`sent`** instead of **`pending`**
6. Messages are never actually processed but appear as "sent"

Currently stuck: **4 messages** in `sending` status that will never be processed.

## Solution

Update the self-healing logic for messages to mirror the campaign recipient logic:
- Reset stale `sending` messages back to `pending` (not `sent`)
- This allows the runner to pick them up on the next poll

### File: `supabase/functions/runner-tasks/index.ts`

**Current behavior (lines 176-194):**
```javascript
// Self-healing: messages can get stuck in `sending` if the runner crashes before reporting.
// Mark them as `sent` after 3 minutes so dashboards/queues don't get polluted indefinitely.
const { data: recoveredMsgs } = await supabase
  .from('messages')
  .update({ status: 'sent', delivered_at: nowIso })  // ❌ WRONG: marks as sent
  .eq('status', 'sending')
  .eq('direction', 'outgoing')
  .lt('created_at', threeMinutesAgoIso)
  .select('id');
```

**New behavior:**
```javascript
// Self-healing: messages can get stuck in `sending` if the runner crashes before reporting.
// Reset them to `pending` after 3 minutes so the runner can retry.
const { data: recoveredMsgs } = await supabase
  .from('messages')
  .update({ status: 'pending' })  // ✅ CORRECT: reset to pending for retry
  .eq('status', 'sending')
  .eq('direction', 'outgoing')
  .lt('created_at', threeMinutesAgoIso)
  .select('id');
```

---

## Summary

| Change | Description |
|--------|-------------|
| Line ~183 | Change `{ status: 'sent', delivered_at: nowIso }` to `{ status: 'pending' }` |
| Line ~190 | Update log message to say "sending → pending" |

---

## Why This Fixes the Issue

1. **Stale messages get retried**: Instead of being falsely marked as "sent", they return to the queue
2. **Consistent with campaign logic**: Campaign recipients already use this pattern (lines 294-313)
3. **No message loss**: Messages will be picked up on the next runner poll cycle
4. **Self-correcting**: Even if multiple race conditions occur, messages eventually get processed

---

## Alternative Considered

Could add a `retry_count` column to prevent infinite retry loops, but:
- Current system rarely has this issue
- Campaign recipients don't have retry limits either
- Keeping it simple for now

