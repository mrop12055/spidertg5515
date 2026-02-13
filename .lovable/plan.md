

## Fix: Campaign Resume Not Promoting Queued Recipients

### Problem
When you pause a campaign, all pending/sending recipients get reset back to `queued` status. But when you start/resume the campaign, the backend only changes the campaign status to `running` -- it never promotes those `queued` recipients back to `pending`. The runner only picks up `pending` tasks, so the campaign appears stuck.

### Solution
Update the campaign start endpoint to also promote all `queued` recipients to `pending` status whenever a campaign is started or resumed.

### Technical Details

**File:** `supabase/functions/admin-api/index.ts`

In the `/campaigns/start` handler (around line 134), after updating the campaign status to `running`, add a step to bulk-promote all `queued` recipients for that campaign to `pending`:

```
1. Update campaign status to 'running' (existing)
2. NEW: Update all campaign_recipients where campaign_id matches
   and status = 'queued' -> set status = 'pending'
3. Log how many recipients were promoted
4. Return success with promoted count
```

This mirrors what the pause handler does in reverse -- pause demotes `pending` to `queued`, start promotes `queued` to `pending`.

No other files need to change. The edge function will be redeployed automatically.

