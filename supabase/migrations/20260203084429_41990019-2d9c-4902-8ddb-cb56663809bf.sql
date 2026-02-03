-- Fix campaign recipient counts by syncing with actual data
-- First, update all campaigns to have correct counts based on actual recipient data

UPDATE campaigns c SET 
  recipient_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id),
  sent_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'sent'),
  failed_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status = 'failed'),
  pending_count = (SELECT COUNT(*) FROM campaign_recipients cr WHERE cr.campaign_id = c.id AND cr.status IN ('pending', 'sending'))
WHERE TRUE;

-- Drop existing trigger if it exists (to prevent double-counting)
DROP TRIGGER IF EXISTS trigger_sync_campaign_counters ON campaign_recipients;
DROP FUNCTION IF EXISTS sync_campaign_counters_on_change();

-- Create improved trigger function that correctly handles INSERT/UPDATE/DELETE
CREATE OR REPLACE FUNCTION sync_campaign_counters_on_change()
RETURNS TRIGGER AS $$
DECLARE
  target_campaign_id uuid;
BEGIN
  -- Determine which campaign to update
  IF TG_OP = 'DELETE' THEN
    target_campaign_id := OLD.campaign_id;
  ELSE
    target_campaign_id := NEW.campaign_id;
  END IF;

  -- Update all counters atomically based on actual data
  UPDATE campaigns SET
    recipient_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = target_campaign_id),
    sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = target_campaign_id AND status = 'sent'),
    failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = target_campaign_id AND status = 'failed'),
    pending_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = target_campaign_id AND status IN ('pending', 'sending')),
    updated_at = now()
  WHERE id = target_campaign_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Create trigger that fires AFTER changes to campaign_recipients
CREATE TRIGGER trigger_sync_campaign_counters
  AFTER INSERT OR UPDATE OR DELETE ON campaign_recipients
  FOR EACH ROW
  EXECUTE FUNCTION sync_campaign_counters_on_change();