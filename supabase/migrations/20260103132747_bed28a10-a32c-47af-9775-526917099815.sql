-- Create function to auto-cleanup pending recipients when campaign is paused/failed/completed
CREATE OR REPLACE FUNCTION public.cleanup_pending_recipients_on_campaign_stop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only trigger when status changes TO paused, failed, or completed
  IF NEW.status IN ('paused', 'failed', 'completed') AND OLD.status = 'running' THEN
    -- Delete pending recipients for this campaign
    DELETE FROM public.campaign_recipients 
    WHERE campaign_id = NEW.id AND status = 'pending';
    
    -- Also cancel any pending messages linked to this campaign's recipients
    UPDATE public.messages 
    SET status = 'cancelled', failed_reason = 'Campaign stopped'
    WHERE campaign_recipient_id IN (
      SELECT id FROM public.campaign_recipients WHERE campaign_id = NEW.id
    ) AND status = 'pending';
    
    RAISE LOG 'Cleaned up pending recipients for campaign %', NEW.id;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Create trigger on campaigns table
DROP TRIGGER IF EXISTS cleanup_recipients_on_campaign_stop ON public.campaigns;
CREATE TRIGGER cleanup_recipients_on_campaign_stop
  AFTER UPDATE ON public.campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_pending_recipients_on_campaign_stop();

-- Also add index to speed up recipient queries by campaign status
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_status 
ON public.campaign_recipients(campaign_id, status);

-- Add index for faster message cancellation lookups
CREATE INDEX IF NOT EXISTS idx_messages_campaign_recipient_status 
ON public.messages(campaign_recipient_id, status) WHERE campaign_recipient_id IS NOT NULL;