
# Fix Campaign Page Real-Time Updates

## Problem
The campaign page shows stale values for pending, sent, and failed counts. The values only update after a full page refresh.

## Root Cause
The UI displays `campaign.sentCount`, `campaign.failedCount`, and `campaign.pendingCount` which come from the `campaigns` table via React Query. However:

1. The `campaigns` table is not added to Supabase realtime publication
2. The existing 3-second polling (`fetchRunningCampaignStats`) stores results in a separate `campaignReports` state map
3. The UI reads from `campaign.sentCount` (React Query cache), not from `campaignReports`
4. The database trigger updates `campaigns` table, but without realtime enabled, React Query never receives the updates

## Solution
Enable realtime on the `campaigns` table so the existing realtime subscription in `useCampaigns` can receive updates when the database trigger syncs the counts.

## Technical Changes

### 1. Enable Realtime for Campaigns Table (Database Migration)

Add the `campaigns` table to the Supabase realtime publication:

```sql
-- Enable realtime for campaigns table so count updates are pushed to UI
ALTER PUBLICATION supabase_realtime ADD TABLE public.campaigns;
```

### 2. Improve useCampaigns Hook to Immediately Refetch After Realtime Update

Currently the realtime subscription in `useCampaigns.ts` (lines 69-90) manually merges partial data from the payload. However, this may miss some fields. Update it to trigger a refetch for the specific campaign to ensure full data sync:

```typescript
// In useCampaigns.ts, around line 69-90
} else if (payload.eventType === 'UPDATE') {
  // For updates to counts, the trigger updates the campaigns table
  // Merge the updated fields into the cache immediately
  const updated = payload.new as any;
  queryClient.setQueryData<Campaign[]>(['campaigns'], (old) => {
    if (!old) return [];
    return old.map(c => {
      if (c.id !== updated.id) return c;
      return {
        ...c,
        name: updated.name,
        messageTemplate: updated.message_template,
        status: updated.status,
        scheduledAt: updated.scheduled_at ? new Date(updated.scheduled_at) : undefined,
        recipientCount: updated.recipient_count ?? c.recipientCount,
        sentCount: updated.sent_count ?? c.sentCount,
        failedCount: updated.failed_count ?? c.failedCount,
        pendingCount: updated.pending_count ?? c.pendingCount,
        replyCount: updated.reply_count ?? c.replyCount,
        updatedAt: new Date(updated.updated_at),
      };
    });
  });
}
```

The current code already does this - the issue is just that realtime isn't enabled on the table.

## Data Flow After Fix

```text
1. Runner sends message → campaign_recipient status changes to 'sent'
2. Database trigger sync_campaign_counts fires → updates campaigns.sent_count
3. Supabase Realtime broadcasts UPDATE event (now enabled)
4. useCampaigns hook receives payload with new sent_count
5. React Query cache updates → UI re-renders with new count
```

## Why This Approach

- Leverages existing infrastructure (trigger already updates counts, hook already has realtime subscription)
- Minimal code changes (just enable realtime publication)
- No additional polling needed
- Instant updates without network overhead of frequent polling

## Testing Checklist

- Start a campaign with recipients
- Observe that sent/failed/pending counts update automatically without page refresh
- Verify counts match after campaign completes
