-- Function to auto-pair new accounts with waiting unpaired accounts
CREATE OR REPLACE FUNCTION public.auto_pair_warmup_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  unpaired_account RECORD;
BEGIN
  -- Only run when account becomes active with a valid session
  IF NEW.status = 'active' AND NEW.session_data IS NOT NULL THEN
    -- Check if there's an unpaired account waiting
    SELECT * INTO unpaired_account
    FROM public.telegram_accounts
    WHERE warmup_unpaired = true
      AND status = 'active'
      AND session_data IS NOT NULL
      AND id != NEW.id
    ORDER BY created_at ASC
    LIMIT 1;
    
    -- If found, pair them together
    IF unpaired_account.id IS NOT NULL THEN
      -- Update the previously unpaired account
      UPDATE public.telegram_accounts
      SET warmup_unpaired = false,
          warmup_pair_id = NEW.id
      WHERE id = unpaired_account.id;
      
      -- Update the new account
      NEW.warmup_unpaired := false;
      NEW.warmup_pair_id := unpaired_account.id;
      
      RAISE LOG 'Auto-paired accounts: % with %', unpaired_account.phone_number, NEW.phone_number;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Create trigger for new account inserts
DROP TRIGGER IF EXISTS trigger_auto_pair_warmup_on_insert ON public.telegram_accounts;
CREATE TRIGGER trigger_auto_pair_warmup_on_insert
  BEFORE INSERT ON public.telegram_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_pair_warmup_accounts();

-- Create trigger for account updates (when status changes to active)
DROP TRIGGER IF EXISTS trigger_auto_pair_warmup_on_update ON public.telegram_accounts;
CREATE TRIGGER trigger_auto_pair_warmup_on_update
  BEFORE UPDATE ON public.telegram_accounts
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.session_data IS DISTINCT FROM NEW.session_data)
  EXECUTE FUNCTION public.auto_pair_warmup_accounts();