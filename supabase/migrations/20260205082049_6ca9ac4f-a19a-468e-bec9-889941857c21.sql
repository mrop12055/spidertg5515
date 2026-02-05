-- Fix recipient upload failures caused by statement timeouts in per-row counter triggers.
-- Replace per-row triggers with statement-level triggers (one per event type).

-- 1) Drop existing per-row triggers that update campaign counters
DROP TRIGGER IF EXISTS trigger_sync_campaign_counters ON public.campaign_recipients;
DROP TRIGGER IF EXISTS campaign_recipients_sync_counts ON public.campaign_recipients;

-- 2) Create separate statement-level trigger functions for each event type

-- INSERT: sync counters for all newly inserted rows
CREATE OR REPLACE FUNCTION public.sync_campaign_counts_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cid uuid;
BEGIN
  FOR cid IN (SELECT DISTINCT campaign_id FROM new_rows WHERE campaign_id IS NOT NULL)
  LOOP
    PERFORM public.sync_campaign_counters(cid);
  END LOOP;
  RETURN NULL;
END;
$$;

-- DELETE: sync counters for all deleted rows
CREATE OR REPLACE FUNCTION public.sync_campaign_counts_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cid uuid;
BEGIN
  FOR cid IN (SELECT DISTINCT campaign_id FROM old_rows WHERE campaign_id IS NOT NULL)
  LOOP
    PERFORM public.sync_campaign_counters(cid);
  END LOOP;
  RETURN NULL;
END;
$$;

-- UPDATE: sync counters for all updated rows (covers status changes)
CREATE OR REPLACE FUNCTION public.sync_campaign_counts_on_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cid uuid;
BEGIN
  FOR cid IN (
    SELECT DISTINCT campaign_id FROM new_rows WHERE campaign_id IS NOT NULL
    UNION
    SELECT DISTINCT campaign_id FROM old_rows WHERE campaign_id IS NOT NULL
  )
  LOOP
    PERFORM public.sync_campaign_counters(cid);
  END LOOP;
  RETURN NULL;
END;
$$;

-- 3) Create statement-level triggers (one per event, no column list for UPDATE)
CREATE TRIGGER campaign_recipients_sync_insert
AFTER INSERT ON public.campaign_recipients
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_campaign_counts_on_insert();

CREATE TRIGGER campaign_recipients_sync_delete
AFTER DELETE ON public.campaign_recipients
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_campaign_counts_on_delete();

CREATE TRIGGER campaign_recipients_sync_update
AFTER UPDATE ON public.campaign_recipients
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_campaign_counts_on_update();