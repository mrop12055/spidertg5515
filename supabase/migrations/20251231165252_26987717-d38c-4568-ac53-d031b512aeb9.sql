-- Create functions to increment campaign counts atomically
CREATE OR REPLACE FUNCTION public.increment_campaign_sent_count(cid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.campaigns 
  SET sent_count = COALESCE(sent_count, 0) + 1,
      updated_at = now()
  WHERE id = cid;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_campaign_failed_count(cid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.campaigns 
  SET failed_count = COALESCE(failed_count, 0) + 1,
      updated_at = now()
  WHERE id = cid;
END;
$$;