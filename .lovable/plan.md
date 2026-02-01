

# Fix Campaign Task Assignment and Queue Visibility

## Problem Summary

When you start a campaign:
1. **All recipients are set to `pending` at once** - This floods the Dashboard Queue with thousands of entries
2. **The runner picks a batch and marks them `sending`** - Recipients leave the "pending" view
3. **The campaign gets auto-completed prematurely** - Multiple places (frontend, edge function, maintenance) check if `pending + sending + queued == 0` and mark the campaign as `completed`
4. **A database trigger then DELETES all remaining `pending` recipients** - The `cleanup_pending_recipients_on_campaign_stop` trigger fires when status changes from `running` to `completed`

This creates a race condition where the campaign finishes after just one batch.

## Solution Overview

Based on your preferences, implement a **staged batching system**:

1. **Recipients start as `queued`** (backlog) instead of `pending`
2. **Runner-tasks stages only 1 batch** from `queued` to `pending` per request
3. **Dashboard only shows `sending`** recipients (active batch being processed)
4. **Never auto-delete pending recipients** - only update status, keep for audit

## Technical Changes

### 1. Campaign Creation - Insert recipients as `queued`

**File:** `supabase/functions/admin-api/index.ts`

Change the recipient insert logic to use `queued` instead of `pending`:
```text
- status: 'pending'
+ status: 'queued'
```

### 2. Runner-Tasks - Stage batches from `queued` to `pending`

**File:** `supabase/functions/runner-tasks/index.ts`

Before fetching `pending` recipients, promote exactly 1 batch from `queued`:

```text
// Step 1: Promote one batch from queued -> pending
const { data: queuedBatch } = await supabase
  .from('campaign_recipients')
  .select('id, campaigns!inner(status)')
  .eq('status', 'queued')
  .eq('campaigns.status', 'running')
  .order('scheduled_at', { ascending: true, nullsFirst: true })
  .limit(batch_size);

if (queuedBatch?.length > 0) {
  await supabase
    .from('campaign_recipients')
    .update({ status: 'pending' })
    .in('id', queuedBatch.map(r => r.id));
}

// Step 2: Now fetch pending recipients (as before)
```

This ensures only `batch_size` recipients are ever in `pending` at a time.

### 3. Dashboard Queue - Show only `sending` (active batch)

**File:** `src/components/dashboard/TaskQueueCard.tsx`

Update the recipients query to show `sending` instead of `pending`:

```text
- .eq('status', 'pending')
+ .eq('status', 'sending')
```

This shows only recipients currently being processed by the runner.

### 4. Remove auto-delete trigger

**Database Migration**

Drop the dangerous trigger that deletes pending recipients on campaign completion:

```sql
DROP TRIGGER IF EXISTS cleanup_recipients_on_campaign_stop 
  ON public.campaigns;
```

This ensures recipients are never automatically deleted, preserving them for audit.

### 5. Update auto-complete logic to include `queued`

**Files:** 
- `supabase/functions/runner-tasks/index.ts` (lines 1069-1073)
- `supabase/functions/utilities/index.ts` (lines 262-266)
- `src/pages/Campaigns.tsx` (lines 224-228)

Ensure the auto-complete check counts `queued` recipients:

```text
.in('status', ['pending', 'sending', 'queued'])
```

This prevents campaigns from completing while there's still queued work.

### 6. Update `system_health` view

**Database Migration**

Update the view to count `sending` recipients (active batch) instead of `pending`:

```sql
CREATE OR REPLACE VIEW public.system_health AS
SELECT 
  ...
  (SELECT count(*) FROM public.campaign_recipients 
   WHERE status = 'sending') AS pending_recipients,
  ...
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `supabase/functions/admin-api/index.ts` | Insert new recipients as `queued` instead of `pending` |
| `supabase/functions/runner-tasks/index.ts` | Stage 1 batch from `queued` to `pending` before fetching |
| `supabase/functions/runner-tasks/index.ts` | Include `queued` in auto-complete check |
| `supabase/functions/utilities/index.ts` | Include `queued` in auto-complete check |
| `src/pages/Campaigns.tsx` | Include `queued` in remaining work calculation |
| `src/components/dashboard/TaskQueueCard.tsx` | Show `sending` recipients instead of `pending` |
| Database migration | Drop `cleanup_recipients_on_campaign_stop` trigger |
| Database migration | Update `system_health` view to count `sending` |

---

## Technical Details

### Recipient Status Flow

```text
┌──────────┐    Runner stages    ┌──────────┐    Runner claims    ┌──────────┐
│  queued  │ ────────────────►  │  pending │ ────────────────►  │  sending │
│ (backlog)│    (1 batch)       │ (ready)  │    (assigns acct)  │ (active) │
└──────────┘                    └──────────┘                    └──────────┘
                                                                      │
                                      ┌───────────────────────────────┤
                                      ▼                               ▼
                                ┌──────────┐                   ┌──────────┐
                                │   sent   │                   │  failed  │
                                │ (done)   │                   │ (error)  │
                                └──────────┘                   └──────────┘
```

### Dashboard Queue Behavior

- **Shows:** Only recipients with `status = 'sending'` (currently being processed)
- **Count:** Matches the batch_size setting (e.g., 100)
- **Updates:** Refreshes as runner reports results and stages new batches

### Campaign Completion Criteria

A campaign completes ONLY when:
- `pending_count + sending_count + queued_count == 0`
- All recipients are either `sent` or `failed`

### Data Retention

- Recipients are NEVER automatically deleted
- All `sent`, `failed`, and remaining `queued` recipients stay in the database
- Full audit trail preserved for reporting

