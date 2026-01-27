

# Plan: Fix Message Reply Sync - Save `recipient_telegram_id` in Edge Function

## Confirmed Problem

After deep investigation, I've confirmed **the problem is 100% real**. Here's the evidence:

| Database Check | Result |
|----------------|--------|
| Total conversations | 439 |
| Conversations with `recipient_telegram_id` | **0** (all NULL) |
| Incoming messages saved | **0** |
| Conversations with `has_reply = true` | **0** |

### The Failure Flow

1. **Campaign sends message** → Python runner captures `recipient_telegram_id`
2. **report-batch-results creates conversation** → **BUT ignores the telegram_id** (the bug)
3. **Recipient replies** → LiveChat runner receives it (passes `is_contact` filter)
4. **report-task-result tries to match** → Tries telegram_id first (all NULL), then phone (format mismatch)
5. **Result**: "Could not find existing conversation - SKIPPING" → Message lost

### Why Phone Matching Fails

The edge function logs show:
- We sent to: `+919329159376` (campaign import phone)
- Reply came from: `+916380709474` (user's Telegram registered phone)

These are **different phones for the same user**. Without `recipient_telegram_id`, we can't link them.

---

## Solution

### File 1: `supabase/functions/report-batch-results/index.ts`

#### Change 1: Add `recipient_telegram_id` to New Conversations (lines 215-225)

```typescript
const newConv = {
  account_id: r.account_id,
  recipient_phone: r.recipient_phone,
  recipient_name: r.recipient_name,
  recipient_telegram_id: r.recipient_telegram_id || null,  // ADD THIS LINE
  is_active: true,
  first_message_sent: true,
  last_message_at: now,
  seat_id: r.campaign_seat_id,
  campaign_id: r.campaign_id,
  campaign_name: r.campaign_name,
};
```

#### Change 2: Update Existing Conversations with telegram_id (after line 212)

When a result matches an existing conversation that doesn't have a telegram_id yet, update it:

```typescript
// Track conversations needing telegram_id update
const convUpdatePromises: Promise<any>[] = [];

for (const r of successResults) {
  const key = `${r.account_id}:${r.recipient_phone}`;
  const existingId = convLookup.get(key);

  if (existingId && existingId !== "pending" && r.recipient_telegram_id) {
    // Update existing conversation with telegram_id for future reply matching
    convUpdatePromises.push(
      supabase
        .from("conversations")
        .update({ recipient_telegram_id: r.recipient_telegram_id })
        .eq("id", existingId)
        .is("recipient_telegram_id", null)
    );
  }
  // ... rest of existing logic
}

// Execute telegram_id updates in parallel
if (convUpdatePromises.length > 0) {
  await Promise.all(convUpdatePromises);
  console.log(`[report-batch-results] Updated ${convUpdatePromises.length} conversations with telegram_id`);
}
```

#### Change 3: Add Debug Logging

```typescript
console.log(`[report-batch-results] Processing ${successResults.length} results, ` +
            `${successResults.filter(r => r.recipient_telegram_id).length} have telegram_id`);
```

---

## Expected Outcome

After this fix:

| Step | Before | After |
|------|--------|-------|
| Campaign send | `recipient_telegram_id = NULL` | `recipient_telegram_id = 5077515613` |
| Reply matching | Fails (all NULL, phone mismatch) | Matches by telegram_id |
| Message saved | Lost (0 incoming) | Saved to messages table |
| `has_reply` flag | Always false | Set to true by trigger |
| UI display | No replies shown | Replies appear in Seats/Conversations |

---

## Files to Modify

1. **`supabase/functions/report-batch-results/index.ts`**
   - Lines 215-225: Add `recipient_telegram_id` to new conversation creation
   - After line 212: Add logic to update existing conversations with telegram_id
   - Add logging for debugging

---

## Note on Existing Data

The 439 existing conversations with NULL `recipient_telegram_id` will be updated automatically when:
1. The LiveChat runner syncs any activity from those users (existing flow at line 1187 of report-task-result)
2. OR a new campaign message is sent to them (new flow above)

No manual database migration is required.

