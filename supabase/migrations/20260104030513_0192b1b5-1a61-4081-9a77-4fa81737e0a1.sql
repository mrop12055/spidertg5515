-- Update the cleanup trigger to ONLY delete pending recipients when campaign completes successfully
-- NOT when it fails or is paused (so users can retry)

CREATE OR REPLACE FUNCTION public.cleanup_pending_recipients_on_campaign_stop()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only trigger when status changes TO completed (not failed or paused)
  -- This preserves recipients for retry when campaign fails or is paused
  IF NEW.status = 'completed' AND OLD.status = 'running' THEN
    -- Delete pending recipients for this campaign (they shouldn't exist if completed properly)
    DELETE FROM public.campaign_recipients 
    WHERE campaign_id = NEW.id AND status = 'pending';
    
    -- Also cancel any pending messages linked to this campaign's recipients
    UPDATE public.messages 
    SET status = 'cancelled', failed_reason = 'Campaign completed'
    WHERE campaign_recipient_id IN (
      SELECT id FROM public.campaign_recipients WHERE campaign_id = NEW.id
    ) AND status = 'pending';
    
    RAISE LOG 'Cleaned up pending recipients for completed campaign %', NEW.id;
  END IF;
  
  RETURN NEW;
END;
$function$;