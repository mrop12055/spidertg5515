

# Fix: Campaign Resume Not Working After Pause

## Problem Identified
When resuming a paused campaign, the recipients remain in `queued` status instead of being promoted to `pending`. The Python runner only processes recipients with `status = 'pending'`, so the campaign appears stuck.

**Current State of "AP MIX data" Campaign:**
- Campaign Status: `running` (correct)
- Recipients: 3,566 in `queued` status (should be `pending`)
- The runner is looking for `pending` recipients but finding none

## Root Cause
The pause endpoint correctly moves recipients from `pending/sending` → `queued`, but the start/resume logic only updates the campaign status without promoting recipients back from `queued` → `pending`.

## Solution
Modify the `/campaigns/start` endpoint in `admin-api` to bulk-promote all `queued` recipients to `pending` when starting/resuming a campaign.

---

## Technical Details

### File: `supabase/functions/admin-api/index.ts`

**Current Start Logic (lines 134-147):**
```typescript
if (path === '/campaigns/start' && method === 'POST') {
  const { campaign_id } = body;
  if (!campaign_id) return jsonResponse({ error: "campaign_id required" }, 400);

  const { data, error } = await supabase
    .from('campaigns')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', campaign_id)
    .select()
    .single();

  if (error) throw error;
  return jsonResponse({ success: true, campaign: data });
}
```

**Updated Start Logic:**
```typescript
if (path === '/campaigns/start' && method === 'POST') {
  const { campaign_id } = body;
  if (!campaign_id) return jsonResponse({ error: "campaign_id required" }, 400);

  // Step 1: Update campaign status to running
  const { data, error } = await supabase
    .from('campaigns')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', campaign_id)
    .select()
    .single();

  if (error) throw error;

  // Step 2: Promote all 'queued' recipients to 'pending' so runner can pick them up
  const { data: promotedRecipients, error: promoteError } = await supabase
    .from('campaign_recipients')
    .update({ status: 'pending' })
    .eq('campaign_id', campaign_id)
    .eq('status', 'queued')
    .select('id');

  const promotedCount = promotedRecipients?.length || 0;
  console.log(`[admin-api] Started campaign ${campaign_id}, promoted ${promotedCount} queued→pending`);

  return jsonResponse({ success: true, campaign: data, promoted_count: promotedCount });
}
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `supabase/functions/admin-api/index.ts` | Add recipient promotion (`queued` → `pending`) when starting a campaign |

## After Implementation
1. Edge function will be auto-deployed
2. Clicking "Start" on a paused campaign will promote all queued recipients to pending
3. The runner will immediately start picking up the 3,566 recipients

