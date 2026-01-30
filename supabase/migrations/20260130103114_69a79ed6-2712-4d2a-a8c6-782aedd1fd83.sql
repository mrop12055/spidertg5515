-- Create sync_campaign_counters function to recalculate campaign statistics
-- This fixes counter drift caused by retry double-counting

CREATE OR REPLACE FUNCTION public.sync_campaign_counters(cid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
    COUNT(*) FILTER (WHERE status IN ('pending', 'sending', 'queued')),
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