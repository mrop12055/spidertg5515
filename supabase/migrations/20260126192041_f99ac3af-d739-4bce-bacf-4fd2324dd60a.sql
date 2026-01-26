-- Update the sync_campaign_counts function to include 'queued' status in pending_count
CREATE OR REPLACE FUNCTION public.sync_campaign_counts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Update the campaigns table with fresh counts including pending and queued
  UPDATE campaigns
  SET 
    sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status = 'sent'),
    failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status = 'failed'),
    pending_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = COALESCE(NEW.campaign_id, OLD.campaign_id) AND status IN ('pending', 'sending', 'queued')),
    updated_at = now()
  WHERE id = COALESCE(NEW.campaign_id, OLD.campaign_id);
  
  RETURN COALESCE(NEW, OLD);
END;
$function$;