-- Replace trigger function with atomic single-statement updates
CREATE OR REPLACE FUNCTION public.sync_campaign_counts()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  -- Handle INSERT: new recipient added
  IF TG_OP = 'INSERT' THEN
    UPDATE campaigns
    SET 
      pending_count = COALESCE(pending_count, 0) + CASE WHEN NEW.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END,
      sent_count = COALESCE(sent_count, 0) + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
      failed_count = COALESCE(failed_count, 0) + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
      updated_at = now()
    WHERE id = NEW.campaign_id;
    RETURN NEW;
  END IF;

  -- Handle UPDATE: status changed - SINGLE atomic update for both decrement and increment
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE campaigns
    SET 
      pending_count = GREATEST(0, COALESCE(pending_count, 0) 
        - CASE WHEN OLD.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END
        + CASE WHEN NEW.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END),
      sent_count = GREATEST(0, COALESCE(sent_count, 0) 
        - CASE WHEN OLD.status = 'sent' THEN 1 ELSE 0 END
        + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END),
      failed_count = GREATEST(0, COALESCE(failed_count, 0) 
        - CASE WHEN OLD.status = 'failed' THEN 1 ELSE 0 END
        + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END),
      updated_at = now()
    WHERE id = NEW.campaign_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;