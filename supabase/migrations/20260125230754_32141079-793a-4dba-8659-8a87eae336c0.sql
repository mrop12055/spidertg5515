-- Phase 1: Create trigger function to sync campaign counts
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

-- Create trigger that fires on recipient status changes
CREATE TRIGGER sync_campaign_counts_trigger
AFTER INSERT OR UPDATE OF status OR DELETE ON campaign_recipients
FOR EACH ROW EXECUTE FUNCTION sync_campaign_counts();

-- Phase 2: One-time sync to fix all existing campaigns
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