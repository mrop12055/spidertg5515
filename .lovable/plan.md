

# Fix Campaign Count Accuracy Issue

## Problem Analysis

The campaign counts (`sent_count`, `pending_count`, `failed_count`) in the `campaigns` table are completely inaccurate compared to the actual `campaign_recipients` data:

**Current Database State:**
- `campaigns` table shows: sent=378, pending=300, failed=22 (total: 700)
- `campaign_recipients` actual data: sent=189, sending=81, pending=219, failed=11 (total: 500)

The counts are nearly **double** what they should be, indicating the trigger is firing multiple times or the increment/decrement logic is not atomic.

## Root Cause

The current trigger function `sync_campaign_counts()` executes **two separate UPDATE statements** when a status changes:
1. First UPDATE to decrement the old status counter
2. Second UPDATE to increment the new status counter

Under high concurrency (which occurs during bulk campaign sends), these separate statements allow race conditions where:
- Multiple transactions read stale values between the decrement and increment
- Updates interleave and cause over-counting

## Solution

Replace the trigger with a single **atomic UPDATE statement** that modifies multiple counters in one operation. This prevents any transaction from reading intermediate states.

## Technical Changes

### 1. Replace Trigger Function with Atomic Updates

Create a new version of `sync_campaign_counts()` that uses a single UPDATE statement with computed expressions:

```sql
CREATE OR REPLACE FUNCTION public.sync_campaign_counts()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  -- Handle INSERT: new recipient added
  IF TG_OP = 'INSERT' THEN
    UPDATE campaigns
    SET 
      pending_count = pending_count + CASE WHEN NEW.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END,
      sent_count = sent_count + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
      failed_count = failed_count + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
      updated_at = now()
    WHERE id = NEW.campaign_id;
    RETURN NEW;
  END IF;

  -- Handle UPDATE: status changed - SINGLE atomic update for both decrement and increment
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE campaigns
    SET 
      pending_count = GREATEST(0, pending_count 
        - CASE WHEN OLD.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END
        + CASE WHEN NEW.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END),
      sent_count = GREATEST(0, sent_count 
        - CASE WHEN OLD.status = 'sent' THEN 1 ELSE 0 END
        + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END),
      failed_count = GREATEST(0, failed_count 
        - CASE WHEN OLD.status = 'failed' THEN 1 ELSE 0 END
        + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END),
      updated_at = now()
    WHERE id = NEW.campaign_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
```

### 2. Reset Corrupted Counts for Running Campaigns

The current counts are wrong. Run a one-time sync to fix them:

```sql
-- Sync all campaign counters from actual recipient data
UPDATE campaigns c
SET 
  sent_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'sent'),
  failed_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'failed'),
  pending_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status IN ('pending', 'sending', 'queued')),
  recipient_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id);
```

## Why This Works

By combining the decrement and increment into a **single UPDATE statement**, PostgreSQL guarantees that:
1. The entire operation is atomic - no other transaction can see intermediate states
2. The row-level lock is held for the minimum time
3. All counter changes happen together, preventing race conditions

## Implementation Steps

1. Deploy the new trigger function (single atomic UPDATE)
2. Execute the one-time sync to fix corrupted counts
3. Verify counts update correctly during a running campaign

