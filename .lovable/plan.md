
# Fix: Campaign Stats Showing Wrong Values Initially

## Problem Identified

When you open the Campaigns page, you see **wrong values for 1-2 seconds** before they update to the correct numbers. This happens because:

**Two different data sources with mismatched values:**

| Source | When Used | Values |
|--------|-----------|--------|
| `campaigns` table (cached) | Initial render | Stale/incorrect counts |
| `campaign_recipients` table (live) | After 1-2 seconds | Accurate counts |

**Example from your database:**
| Campaign | Cached (table) | Actual (recipients) |
|----------|---------------|---------------------|
| test | sent=473, failed=92 | sent=473, failed=**7** |
| asfsadfs | sent=830, failed=14 | sent=830, failed=**470** |
| asfjslfdjsl | sent=252, failed=568 | sent=**208**, failed=**540** |

The `campaigns.sent_count` and `campaigns.failed_count` columns are NOT being properly synced when recipients are processed.

---

## Root Cause

The `campaigns` table stores `sent_count`, `failed_count`, and `recipient_count` as cached columns. These values are supposed to match the actual counts in `campaign_recipients`, but they drift out of sync because:

1. **Batch results don't update the campaigns table** - When `report-batch-results` processes messages, it updates `campaign_recipients.status` but doesn't sync the counts back to the `campaigns` table
2. **No database trigger** to keep them in sync
3. **Fallback logic in UI** shows the stale cached value first, then replaces it with live counts

---

## Solution Options

### Option A: Remove Stale Data Display (Quick Fix)
Only show stats from `campaignReports` (live counts), show a loading skeleton until the real data arrives.

**Pros**: Simple, always shows accurate data  
**Cons**: Brief loading state on page load

### Option B: Add Database Trigger (Permanent Fix)
Create a database trigger that automatically updates `campaigns.sent_count` and `campaigns.failed_count` whenever `campaign_recipients.status` changes.

**Pros**: Cached values always match reality, instant display  
**Cons**: Slight DB overhead

### Option C: Hybrid Approach (Recommended)
1. Add a database trigger to keep counts in sync
2. Fetch live reports immediately on mount (already happening)
3. Trust the cached values only if they match the live counts

---

## Technical Implementation

### Phase 1: Database Trigger (keeps counts in sync)

Create a trigger that updates `campaigns` table whenever a recipient status changes:

```sql
CREATE OR REPLACE FUNCTION sync_campaign_counts()
RETURNS TRIGGER AS $$
BEGIN
  -- Update the campaigns table with fresh counts
  UPDATE campaigns
  SET 
    sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status = 'sent'),
    failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status = 'failed'),
    updated_at = now()
  WHERE id = COALESCE(NEW.campaign_id, OLD.campaign_id);
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_campaign_counts_trigger
AFTER INSERT OR UPDATE OF status OR DELETE ON campaign_recipients
FOR EACH ROW EXECUTE FUNCTION sync_campaign_counts();
```

### Phase 2: Fix Existing Stale Data

Run a one-time sync to fix all campaigns:

```sql
UPDATE campaigns c
SET 
  sent_count = sub.sent,
  failed_count = sub.failed,
  recipient_count = sub.total
FROM (
  SELECT 
    campaign_id,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'sent') as sent,
    COUNT(*) FILTER (WHERE status = 'failed') as failed
  FROM campaign_recipients
  GROUP BY campaign_id
) sub
WHERE c.id = sub.campaign_id;
```

### Phase 3: UI Enhancement (optional)

Show skeleton loader until `campaignReports` is loaded:

```typescript
// In stats display (lines 1835-1869)
const isLoading = !report && campaignReports.size === 0;

if (isLoading) {
  return <Skeleton className="h-6 w-20" />;
}
```

---

## Expected Result

| Scenario | Before Fix | After Fix |
|----------|------------|-----------|
| Page load | Shows stale values → jumps to real values | Shows correct values immediately |
| During campaign run | Counts drift out of sync | Counts stay synchronized |
| Data source | Two sources (mismatched) | Single source of truth |

---

## Summary of Changes

| Component | Change |
|-----------|--------|
| Database | Add `sync_campaign_counts` trigger |
| Database | One-time sync of all existing campaigns |
| UI (optional) | Show skeleton while loading live stats |
