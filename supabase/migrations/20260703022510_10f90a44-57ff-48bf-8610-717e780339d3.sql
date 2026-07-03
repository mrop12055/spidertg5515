
DROP TRIGGER IF EXISTS trigger_auto_pair_warmup_on_insert ON public.telegram_accounts;
DROP TRIGGER IF EXISTS trigger_auto_pair_warmup_on_update ON public.telegram_accounts;
DROP FUNCTION IF EXISTS public.auto_pair_warmup_accounts() CASCADE;

ALTER TABLE public.telegram_accounts
  DROP COLUMN IF EXISTS warmup_unpaired,
  DROP COLUMN IF EXISTS warmup_pair_id,
  DROP COLUMN IF EXISTS warmup_started_at,
  DROP COLUMN IF EXISTS warmup_phase;

DROP TABLE IF EXISTS public.warmup_errors CASCADE;
DROP TABLE IF EXISTS public.warmup_messages CASCADE;
DROP TABLE IF EXISTS public.warmup_pairs CASCADE;
DROP TABLE IF EXISTS public.warmup_schedule CASCADE;
DROP TABLE IF EXISTS public.warmup_sessions CASCADE;
DROP TABLE IF EXISTS public.warmup_message_templates CASCADE;

DROP TABLE IF EXISTS public.seats CASCADE;
DROP TABLE IF EXISTS public.app_settings CASCADE;
