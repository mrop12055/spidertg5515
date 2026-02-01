

# Fix Campaign Task Processing Issues

## Problems Identified

### Issue 1: Slow Recipient Assignment
When starting a campaign, recipients are staged in batches (e.g., 350 at a time) from `queued` to `pending`. The user wants all recipients assigned immediately when the campaign starts.

### Issue 2: Runner Not Processing Campaign Tasks
Two sub-problems:
1. **Runner receives but doesn't process tasks**: At 09:32:15, the edge function returned 288 campaign tasks, but they were never processed or reported back
2. **Self-healing recovery bug**: The recovery query has incorrect filter syntax - using `.or()` after `.eq()` creates wrong SQL logic, so 286 recipients stuck in `sending` status are never recovered

## Root Cause Analysis

### Slow Assignment Root Cause
The staged batching system (lines 315-336 in runner-tasks) intentionally promotes only `batch_size` recipients per poll cycle. This prevents dashboard flooding but creates perceived slowness.

### Runner Not Processing Root Cause
Looking at the Python runner (SetupGuide.tsx line 1332):
```python
if tt in ("send", "campaign_send", "livechat_reply", "warmup_chat") or ("send" in tt and "warmup" in tt):
```

The campaign tasks have `task_type: "send"` which SHOULD match. The likely issue is the runner is receiving tasks but silently failing to connect accounts for those tasks, or there's an exception being swallowed.

### Self-Healing Bug Root Cause
Line 303-305 in runner-tasks/index.ts:
```javascript
.eq('status', 'sending')
.or(`sending_started_at.lt.${threeMinutesAgoIso},sending_started_at.is.null`)
```

The `.or()` filter in Supabase creates: `status = 'sending' OR (timestamp condition)` instead of `status = 'sending' AND (timestamp condition)`. The correct syntax requires wrapping the condition or using `.filter()`.

---

## Solution

### Fix 1: Instant Recipient Assignment (Optional)
Add a new endpoint or modify campaign start to promote ALL `queued` recipients to `pending` at once. This is a trade-off: faster start vs. larger dashboard queue.

**File:** `supabase/functions/admin-api/index.ts`

Add to the `/campaigns/start` endpoint after updating status:
```javascript
// Promote ALL queued recipients to pending immediately
await supabase
  .from('campaign_recipients')
  .update({ status: 'pending' })
  .eq('campaign_id', campaign_id)
  .eq('status', 'queued');
```

### Fix 2: Correct Self-Healing Query
**File:** `supabase/functions/runner-tasks/index.ts`

Change lines 303-306 from:
```javascript
.eq('status', 'sending')
.or(`sending_started_at.lt.${threeMinutesAgoIso},sending_started_at.is.null`)
```

To use the correct `.lt()` filter:
```javascript
.eq('status', 'sending')
.lt('sending_started_at', threeMinutesAgoIso)
```

This properly creates: `status = 'sending' AND sending_started_at < threshold`

For the null case, add a separate recovery query for legacy rows with null timestamps.

### Fix 3: Add Runner Logging for Campaign Tasks
**File:** `src/pages/SetupGuide.tsx`

Add explicit logging when processing campaign tasks to identify why they're not being executed:
```python
if task.get("campaign_recipient_id"):
    print(f"  [CAMPAIGN] Processing recipient {task.get('campaign_recipient_id')[:8]}")
```

---

## Technical Implementation

| File | Change |
|------|--------|
| `supabase/functions/admin-api/index.ts` | Add bulk promotion of queued recipients on campaign start |
| `supabase/functions/runner-tasks/index.ts` | Fix `.or()` filter bug in self-healing recovery (line ~305) |
| `src/pages/SetupGuide.tsx` | Add debug logging for campaign task processing |

---

## Immediate Database Fix

Before implementing code changes, run this SQL to unstick the 286 recipients:

```sql
UPDATE campaign_recipients 
SET status = 'pending', sending_started_at = NULL, sent_by_account_id = NULL
WHERE status = 'sending' 
  AND sending_started_at < NOW() - INTERVAL '3 minutes';
```

---

## Why This Fixes Both Issues

1. **Instant assignment**: All recipients become `pending` immediately when campaign starts, so the runner can pick them all up in the next poll
2. **Self-healing works**: The corrected filter properly identifies stale `sending` recipients and resets them to `pending` for retry
3. **Better visibility**: Added logging helps diagnose why tasks aren't being processed

