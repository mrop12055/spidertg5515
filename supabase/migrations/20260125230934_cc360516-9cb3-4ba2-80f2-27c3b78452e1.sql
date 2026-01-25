-- Add pending_count column to campaigns table if it doesn't exist
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS pending_count integer DEFAULT 0;

-- Update trigger to also sync pending_count
CREATE OR REPLACE FUNCTION sync_campaign_counts()
RETURNS TRIGGER AS $$
BEGIN
  -- Update the campaigns table with fresh counts including pending
  UPDATE campaigns
  SET 
    sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status = 'sent'),
    failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status = 'failed'),
    pending_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status IN ('pending', 'sending')),
    updated_at = now()
  WHERE id = COALESCE(NEW.campaign_id, OLD.campaign_id);
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Sync all existing campaigns with correct pending counts
UPDATE campaigns c
SET 
  sent_count = sub.sent,
  failed_count = sub.failed,
  pending_count = sub.pending,
  recipient_count = sub.total
FROM (
  SELECT 
    campaign_id,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'sent') as sent,
    COUNT(*) FILTER (WHERE status = 'failed') as failed,
    COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) as pending
  FROM campaign_recipients
  GROUP BY campaign_id
) sub
WHERE c.id = sub.campaign_id;