-- Ensure campaign counters stay mathematically correct by syncing campaigns table
-- whenever campaign_recipients rows are inserted/updated/deleted.

-- 1) Update/extend trigger function to handle INSERT/UPDATE/DELETE (including recipient_count)
CREATE OR REPLACE FUNCTION public.sync_campaign_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Handle INSERT: new recipient added
  IF TG_OP = 'INSERT' THEN
    UPDATE public.campaigns
    SET 
      recipient_count = COALESCE(recipient_count, 0) + 1,
      pending_count = COALESCE(pending_count, 0) + CASE WHEN NEW.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END,
      sent_count = COALESCE(sent_count, 0) + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
      failed_count = COALESCE(failed_count, 0) + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
      updated_at = now()
    WHERE id = NEW.campaign_id;

    RETURN NEW;
  END IF;

  -- Handle DELETE: recipient removed
  IF TG_OP = 'DELETE' THEN
    UPDATE public.campaigns
    SET 
      recipient_count = GREATEST(0, COALESCE(recipient_count, 0) - 1),
      pending_count = GREATEST(0, COALESCE(pending_count, 0) - CASE WHEN OLD.status IN ('pending', 'sending', 'queued') THEN 1 ELSE 0 END),
      sent_count = GREATEST(0, COALESCE(sent_count, 0) - CASE WHEN OLD.status = 'sent' THEN 1 ELSE 0 END),
      failed_count = GREATEST(0, COALESCE(failed_count, 0) - CASE WHEN OLD.status = 'failed' THEN 1 ELSE 0 END),
      updated_at = now()
    WHERE id = OLD.campaign_id;

    RETURN OLD;
  END IF;

  -- Handle UPDATE: status changed - SINGLE atomic update for both decrement and increment
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.campaigns
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
$$;

-- 2) Create the trigger on campaign_recipients
DROP TRIGGER IF EXISTS campaign_recipients_sync_counts ON public.campaign_recipients;
CREATE TRIGGER campaign_recipients_sync_counts
AFTER INSERT OR UPDATE OR DELETE ON public.campaign_recipients
FOR EACH ROW
EXECUTE FUNCTION public.sync_campaign_counts();

-- 3) One-time repair: resync all existing campaigns (fixes any drift)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN (SELECT id FROM public.campaigns) LOOP
    PERFORM public.sync_campaign_counters(r.id);
  END LOOP;
END $$;