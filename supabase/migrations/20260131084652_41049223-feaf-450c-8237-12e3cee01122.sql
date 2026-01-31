-- Fix duplicated campaign counter triggers (they were firing twice and inflating pending/sent/failed)

-- 1) Remove both existing sync triggers (we will recreate exactly one)
DROP TRIGGER IF EXISTS sync_campaign_counts_trigger ON public.campaign_recipients;
DROP TRIGGER IF EXISTS campaign_recipients_sync_counts ON public.campaign_recipients;

-- 2) Create a single optimized trigger that fires only when it matters
--    (INSERT/DELETE always affect totals; UPDATE only when status changes)
CREATE TRIGGER campaign_recipients_sync_counts
AFTER INSERT OR DELETE OR UPDATE OF status ON public.campaign_recipients
FOR EACH ROW
EXECUTE FUNCTION public.sync_campaign_counts();

-- 3) Remove redundant recipient_count sync trigger (recipient_count is already maintained by sync_campaign_counts)
DROP TRIGGER IF EXISTS sync_recipient_count_trigger ON public.campaign_recipients;

-- 4) One-time repair: recompute counters from source-of-truth (campaign_recipients)
WITH agg AS (
  SELECT
    campaign_id,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE status IN ('pending','sending','queued'))::int AS pending,
    COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
  FROM public.campaign_recipients
  GROUP BY campaign_id
)
UPDATE public.campaigns c
SET
  recipient_count = COALESCE(a.total, 0),
  pending_count   = COALESCE(a.pending, 0),
  sent_count      = COALESCE(a.sent, 0),
  failed_count    = COALESCE(a.failed, 0),
  updated_at      = now()
FROM agg a
WHERE c.id = a.campaign_id;

-- Campaigns with zero recipients
UPDATE public.campaigns c
SET
  recipient_count = 0,
  pending_count   = 0,
  sent_count      = 0,
  failed_count    = 0,
  updated_at      = now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaign_recipients r WHERE r.campaign_id = c.id
);
