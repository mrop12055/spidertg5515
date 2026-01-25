-- Create function to sync campaign recipient count
CREATE OR REPLACE FUNCTION public.sync_campaign_recipient_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.campaigns 
    SET recipient_count = (
      SELECT COUNT(*) FROM public.campaign_recipients WHERE campaign_id = NEW.campaign_id
    )
    WHERE id = NEW.campaign_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.campaigns 
    SET recipient_count = (
      SELECT COUNT(*) FROM public.campaign_recipients WHERE campaign_id = OLD.campaign_id
    )
    WHERE id = OLD.campaign_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- Create trigger on campaign_recipients table
DROP TRIGGER IF EXISTS sync_recipient_count_trigger ON public.campaign_recipients;
CREATE TRIGGER sync_recipient_count_trigger
AFTER INSERT OR DELETE ON public.campaign_recipients
FOR EACH ROW
EXECUTE FUNCTION public.sync_campaign_recipient_count();

-- Also sync all existing campaigns to fix any current mismatches
UPDATE public.campaigns c
SET recipient_count = (
  SELECT COUNT(*) FROM public.campaign_recipients cr WHERE cr.campaign_id = c.id
);