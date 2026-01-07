-- Create function to auto-detect and set frozen status
CREATE OR REPLACE FUNCTION public.auto_detect_frozen_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- If ban_reason contains "frozen account" error, set status to frozen
  IF NEW.ban_reason IS NOT NULL AND (
    NEW.ban_reason ILIKE '%frozen account%' OR
    NEW.ban_reason ILIKE '%not available for frozen%'
  ) THEN
    NEW.status := 'frozen';
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger to run on insert or update
DROP TRIGGER IF EXISTS trigger_auto_detect_frozen ON public.telegram_accounts;
CREATE TRIGGER trigger_auto_detect_frozen
  BEFORE INSERT OR UPDATE ON public.telegram_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_detect_frozen_accounts();

-- Also fix existing accounts that have frozen error but wrong status
UPDATE public.telegram_accounts
SET status = 'frozen'
WHERE ban_reason ILIKE '%frozen account%' 
   OR ban_reason ILIKE '%not available for frozen%';