

# Fix Campaign Tasks Not Being Assigned After Initial Batch

## Problem Summary

Your campaign shows 299 recipients stuck in "sending" status that will never be processed. When the runner initially picked up tasks, it marked them as "sending" but then lost connection before completing them. Since the system only picks up "pending" recipients, these 299 are now permanently stuck.

## Root Cause

The task assignment flow has a vulnerability:

```text
1. Runner calls /get endpoint
2. Edge function marks recipients as "sending" (line 426)
3. Runner crashes/disconnects before reporting results
4. Recipients stay "sending" forever - never picked up again
```

**Current Query (line 274):**
```
.eq("status", "pending")  // Only picks "pending", ignores stuck "sending"
```

## Solution Overview

### 1. Add Stale Task Recovery (Automated)

Add logic to the `utilities` edge function's `/maintenance` endpoint to automatically reset recipients that have been stuck in "sending" for more than 3 minutes back to "pending":

- Check for recipients with `status = 'sending'`
- That were assigned more than 3 minutes ago (need timestamp tracking)
- Reset them to `pending` for retry

### 2. Add Timestamp Tracking

Add a `sending_started_at` column to `campaign_recipients` table to track when a recipient was assigned:

```sql
ALTER TABLE campaign_recipients 
ADD COLUMN sending_started_at TIMESTAMPTZ;
```

### 3. Update Task Assignment

When marking recipients as "sending", also set the timestamp:

```typescript
await supabase.from("campaign_recipients")
  .update({ status: "sending", sending_started_at: nowIso })
  .eq("id", r.id);
```

### 4. Recovery Logic in utilities/maintenance

Add to the maintenance endpoint:

```typescript
// Reset stale "sending" recipients (stuck for > 3 minutes)
const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
const { data: staleRecipients } = await supabase
  .from('campaign_recipients')
  .update({ 
    status: 'pending', 
    sending_started_at: null,
    sent_by_account_id: null 
  })
  .eq('status', 'sending')
  .lt('sending_started_at', threeMinutesAgo)
  .select();

results.stale_recipients_reset = staleRecipients?.length || 0;
```

## Immediate Fix

For your currently stuck campaign, I will immediately reset the 299 stuck recipients back to "pending" so they can be processed.

---

## Files to Modify

| File | Change |
|------|--------|
| Database migration | Add `sending_started_at` column to `campaign_recipients` |
| `supabase/functions/runner-tasks/index.ts` | Set `sending_started_at` when marking as "sending" |
| `supabase/functions/utilities/index.ts` | Add stale recipient recovery in `/maintenance` endpoint |

## Technical Details

### Database Changes
- New column `sending_started_at` (TIMESTAMPTZ, nullable) to track when a recipient entered "sending" status

### Edge Function Changes (runner-tasks)
- Line 426: Add `sending_started_at: nowIso` to the update statement

### Edge Function Changes (utilities)
- Add stale recovery logic after runner offline detection (around line 217)
- Reset recipients where `status = 'sending'` AND `sending_started_at < 3 minutes ago`

### Recovery Behavior
- 3-minute timeout balances between recovery speed and avoiding interrupting legitimate processing
- Resets `sent_by_account_id` and `sending_started_at` for clean retry
- Does NOT increment `retry_count` since the task was never actually attempted

