

# Fix Campaign Statistics Showing Wrong Values

## Problem Summary

Campaign statistics are displaying incorrect values:
- **Sent count** shows double the actual number (e.g., 1742 instead of 871)
- **Failed count** shows double the actual number (e.g., 612 instead of 306)
- **Pending count** is correct

## Root Cause

The campaign counts were being updated **twice**:
1. Once by the database trigger (`sync_campaign_counts`) when recipient status changes
2. Once by the edge function calling `increment_campaign_sent_count` / `increment_campaign_failed_count`

The edge function fix was applied in the last edit, but existing data still has the doubled values.

## Data That Needs Fixing

| Campaign | Stored Sent | Actual Sent | Stored Failed | Actual Failed |
|----------|-------------|-------------|---------------|---------------|
| asdfsfsewgew | 1742 | 871 | 612 | 306 |
| (other campaigns) | Already correct | - | Already correct | - |

Only **1 campaign** currently has incorrect statistics that need repair.

---

## Solution

### Step 1: Repair Existing Campaign Data

Run a SQL update to recalculate all campaign counters from the actual `campaign_recipients` records:

```sql
UPDATE campaigns c
SET 
  sent_count = sub.actual_sent,
  failed_count = sub.actual_failed,
  pending_count = sub.actual_pending
FROM (
  SELECT 
    campaign_id,
    COUNT(*) FILTER (WHERE status = 'sent') as actual_sent,
    COUNT(*) FILTER (WHERE status = 'failed') as actual_failed,
    COUNT(*) FILTER (WHERE status IN ('pending', 'queued', 'sending')) as actual_pending
  FROM campaign_recipients
  GROUP BY campaign_id
) sub
WHERE c.id = sub.campaign_id;
```

This will fix all campaigns at once, ensuring stored values match actual recipient records.

### Step 2: Verify the Edge Function Fix

The previous edit already removed the duplicate RPC calls from `runner-tasks/index.ts`. This prevents future double-counting - new campaigns will have correct statistics.

---

## Technical Details

**Files to modify:** None (code fix already applied)

**Database changes:**
- Execute data repair query to sync `sent_count`, `failed_count`, and `pending_count` with actual recipient records

**Expected result after fix:**
- Campaign "asdfsfsewgew" will show: Sent=871, Failed=306, Pending=612
- All other campaigns will retain their already-correct values
- Future campaigns will count correctly due to the edge function fix

