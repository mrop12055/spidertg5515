-- Fix race condition by using atomic increment/decrement instead of full recounts
CREATE OR REPLACE FUNCTION public.sync_campaign_counts()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  -- Handle INSERT: new recipient added
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('pending', 'sending', 'queued') THEN
      UPDATE campaigns
      SET pending_count = COALESCE(pending_count, 0) + 1,
          updated_at = now()
      WHERE id = NEW.campaign_id;
    ELSIF NEW.status = 'sent' THEN
      UPDATE campaigns
      SET sent_count = COALESCE(sent_count, 0) + 1,
          updated_at = now()
      WHERE id = NEW.campaign_id;
    ELSIF NEW.status = 'failed' THEN
      UPDATE campaigns
      SET failed_count = COALESCE(failed_count, 0) + 1,
          updated_at = now()
      WHERE id = NEW.campaign_id;
    END IF;
    RETURN NEW;
  END IF;

  -- Handle UPDATE: status changed
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Decrement old status counter
    IF OLD.status IN ('pending', 'sending', 'queued') THEN
      UPDATE campaigns
      SET pending_count = GREATEST(COALESCE(pending_count, 0) - 1, 0),
          updated_at = now()
      WHERE id = NEW.campaign_id;
    ELSIF OLD.status = 'sent' THEN
      UPDATE campaigns
      SET sent_count = GREATEST(COALESCE(sent_count, 0) - 1, 0),
          updated_at = now()
      WHERE id = NEW.campaign_id;
    ELSIF OLD.status = 'failed' THEN
      UPDATE campaigns
      SET failed_count = GREATEST(COALESCE(failed_count, 0) - 1, 0),
          updated_at = now()
      WHERE id = NEW.campaign_id;
    END IF;

    -- Increment new status counter
    IF NEW.status IN ('pending', 'sending', 'queued') THEN
      UPDATE campaigns
      SET pending_count = COALESCE(pending_count, 0) + 1,
          updated_at = now()
      WHERE id = NEW.campaign_id;
    ELSIF NEW.status = 'sent' THEN
      UPDATE campaigns
      SET sent_count = COALESCE(sent_count, 0) + 1,
          updated_at = now()
      WHERE id = NEW.campaign_id;
    ELSIF NEW.status = 'failed' THEN
      UPDATE campaigns
      SET failed_count = COALESCE(failed_count, 0) + 1,
          updated_at = now()
      WHERE id = NEW.campaign_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;