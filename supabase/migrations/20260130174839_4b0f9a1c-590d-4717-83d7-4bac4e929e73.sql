-- Fix: Make sync_campaign_counts trigger fire on UPDATE (not just INSERT)
-- This is needed because when runner changes status from 'pending' to 'sent', it's an UPDATE

-- Drop the existing trigger
DROP TRIGGER IF EXISTS sync_campaign_counts_trigger ON public.campaign_recipients;

-- Recreate with INSERT and UPDATE events
CREATE TRIGGER sync_campaign_counts_trigger
  AFTER INSERT OR UPDATE OF status ON public.campaign_recipients
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_campaign_counts();