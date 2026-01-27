
# Plan: Fix Missing `recipient_telegram_id` in report-task-result Edge Function

## Problem Summary

LiveChat replies are being received by the edge function but ALL are being skipped with the error:
```
WARNING: Could not find existing conversation for incoming message from sender_id=xxx - SKIPPING
```

### Root Cause Chain

1. **Python runner captures `recipient_telegram_id`** after successful send (lines 1659-1662 in SetupGuide.tsx)
2. **report_results_parallel** tries `report_batch_results` first (5s timeout)
3. **When batch times out** (likely happening frequently), falls back to individual `report_result("send")` calls
4. **report-task-result edge function** creates conversations **WITHOUT** `recipient_telegram_id` in the INSERT
5. **Phone matching fails** because sender's Telegram-registered phone differs from campaign import phone
6. **Result**: All 439 conversations have `recipient_telegram_id = NULL`, replies cannot be matched

### Database Evidence

| Metric | Value |
|--------|-------|
| Total conversations | 439 |
| Conversations with `recipient_telegram_id` | **0** (all NULL) |
| Incoming messages saved | **0** |

### Why Phone Matching Fails

From edge function logs:
- Reply came from phone: `+919989171812` (user's Telegram-registered phone)
- Conversation stored with: `+919329244306` (campaign import phone)
- These are DIFFERENT phones for the same Telegram user

---

## Solution

### File: `supabase/functions/report-task-result/index.ts`

**Change**: Add `recipient_telegram_id` to the conversation INSERT statement (around line 243-253)

```text
Current code (BROKEN):
.insert({
  account_id: account_id,
  recipient_phone: recipient_phone,
  recipient_name: recipient_name,
  is_active: true,
  first_message_sent: true,
  last_message_at: new Date().toISOString(),
  seat_id: recipientSeatId,
  campaign_id: campaignId,
  campaign_name: campaignName,
})

Fixed code:
.insert({
  account_id: account_id,
  recipient_phone: recipient_phone,
  recipient_name: recipient_name,
  recipient_telegram_id: recipient_telegram_id || null,  // ADD THIS LINE
  is_active: true,
  first_message_sent: true,
  last_message_at: new Date().toISOString(),
  seat_id: recipientSeatId,
  campaign_id: campaignId,
  campaign_name: campaignName,
})
```

This ensures that when `report-task-result` creates a new conversation (fallback path), it includes the Telegram ID immediately rather than relying on a separate UPDATE call.

---

## Technical Details

### Why the UPDATE After INSERT Doesn't Work

The current flow:
1. INSERT conversation (without telegram_id)
2. UPDATE conversation with telegram_id (lines 267-271)

The UPDATE only runs if `recipient_telegram_id` is truthy. But if the Python runner didn't capture the ID (edge case), or if there's a race condition, the conversation is created without it.

### Why report-batch-results Works But Isn't Used

The `report-batch-results` function WAS fixed to include `recipient_telegram_id`, but:
- It has a 5-second timeout
- When it times out, the fallback goes to `report-task-result`
- `report-task-result` was NOT fixed

---

## Files to Modify

1. **`supabase/functions/report-task-result/index.ts`**
   - Lines 243-253: Add `recipient_telegram_id: recipient_telegram_id || null` to the conversation INSERT

---

## Expected Outcome

After this fix:
1. Conversations created via both `report-batch-results` AND `report-task-result` will have `recipient_telegram_id`
2. Incoming replies will match by telegram_id (Priority 1)
3. `has_reply = true` will be set correctly
4. Replies will appear in Seats and Conversations pages

---

## Note on Existing Data

The 439 existing conversations with NULL `recipient_telegram_id` will NOT be automatically fixed. Options:
1. Run a new campaign to test the fix works
2. Existing conversations will be updated when replies are matched by phone (existing backfill logic at line 1187)
3. Manual SQL update if campaign_recipients table has telegram IDs (it likely doesn't)
