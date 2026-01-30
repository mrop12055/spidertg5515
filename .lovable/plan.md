
# Plan: Fix Campaign Counter Drift and Enforce Batch Size Settings

## Problem Summary

### Issue 1: Campaign Counter Out of Sync
- **Symptom**: You added 36 recipients but see "39 sent, 3 pending, 1 failed"
- **Actual database state**: 35 sent, 1 failed = 36 total (correct)
- **Campaign table shows**: 39 sent (inflated by 4)

**Root cause**: When a `PeerFlood` error occurs, the recipient is reset to "pending" and retried by another account. When it succeeds on retry, `increment_campaign_sent_count` is called again, double-counting the recipient.

### Issue 2: Batch Size Not Applied
- **Your setting**: `batchSize: 10` in Settings
- **Actual behavior**: Runner always uses `batch_size: 100`
- **Root cause**: The Python runner hardcodes `get_tasks(100)` instead of reading from settings

---

## Technical Changes

### Fix 1: Prevent Counter Double-Counting (Edge Function)

**File**: `supabase/functions/runner-tasks/index.ts`

Before incrementing the sent counter, check if this recipient was already counted:

```typescript
// In success handler for campaign sends (line ~628-629)
// Only increment counter if recipient status wasn't already 'sent'
const { data: recipientData } = await supabase
  .from("campaign_recipients")
  .select("status")
  .eq("id", r.campaign_recipient_id)
  .single();

// Only count once per recipient
if (recipientData?.status !== 'sent') {
  await supabase.from("campaign_recipients")
    .update({ status: "sent", sent_at: now, api_credential_id: r.api_credential_id })
    .eq("id", r.campaign_recipient_id);
  await supabase.rpc('increment_campaign_sent_count', { cid: r.campaign_id });
}
```

### Fix 2: Sync Counters with Actual Data (RPC Function)

Create a database function to recalculate and fix drifted counters:

```sql
CREATE OR REPLACE FUNCTION sync_campaign_counters(cid uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_sent int;
  v_failed int;
  v_pending int;
  v_total int;
BEGIN
  SELECT 
    COUNT(*) FILTER (WHERE status = 'sent'),
    COUNT(*) FILTER (WHERE status = 'failed'),
    COUNT(*) FILTER (WHERE status IN ('pending', 'sending')),
    COUNT(*)
  INTO v_sent, v_failed, v_pending, v_total
  FROM campaign_recipients
  WHERE campaign_id = cid;
  
  UPDATE campaigns
  SET 
    sent_count = v_sent,
    failed_count = v_failed,
    pending_count = v_pending,
    recipient_count = v_total,
    updated_at = now()
  WHERE id = cid;
END;
$$;
```

### Fix 3: Make Python Runner Use Batch Size Setting

**File**: `src/pages/SetupGuide.tsx` (Python runner)

The runner should fetch settings and use them:

```python
# In get_tasks function - request settings
async def get_tasks(batch_size: int = 100) -> dict:
    # ... existing code ...

# In main loop - use configured batch size
async def main():
    # ...
    while RUNNING:
        # Fetch with proper batch size from settings response
        batch = await get_tasks(100)  # Initial fetch
        config_batch_size = batch.get("config", {}).get("campaignBatchSize", 100)
        
        # Use configured batch size for subsequent fetches
        batch = await get_tasks(config_batch_size)
```

Also update the Edge Function to return the batch size setting in the response:

```typescript
// In handleGetTasks response (runner-tasks/index.ts)
return jsonResponse({
  tasks,
  accounts: usableAccounts.map(/* ... */),
  delay_after: config.campaignPollingInterval,
  config: {
    campaignBatchSize: config.campaignBatchSize,
    // ... other settings
  }
});
```

---

## Files to Change

| File | Change |
|------|--------|
| `supabase/functions/runner-tasks/index.ts` | Check recipient status before incrementing counter; include batch size in response |
| `src/pages/SetupGuide.tsx` | Read batch size from backend response and use it |
| Database migration | Create `sync_campaign_counters` function to fix existing drift |

---

## Immediate Fix for Your Campaign

After these changes are applied, you can run this SQL to fix the existing campaign's counters:

```sql
SELECT sync_campaign_counters('ed45d690-653b-4741-b5e6-416e3cca6583');
```

---

## Result After Fix

| Aspect | Before | After |
|--------|--------|-------|
| Sent counter | Inflated on retries | Counts each recipient once |
| Batch size | Always 100 | Respects Settings value (10) |
| Counter drift | Accumulates over time | Self-correcting with sync function |
