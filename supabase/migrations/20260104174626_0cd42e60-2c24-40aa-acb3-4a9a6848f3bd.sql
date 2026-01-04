-- Add account health tracking columns
ALTER TABLE telegram_accounts 
ADD COLUMN IF NOT EXISTS success_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS failure_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS success_rate numeric DEFAULT 100,
ADD COLUMN IF NOT EXISTS auto_disabled boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS disabled_reason text;

-- Create function to increment account success
CREATE OR REPLACE FUNCTION increment_account_success(acc_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE telegram_accounts 
  SET success_count = COALESCE(success_count, 0) + 1,
      success_rate = ROUND(
        (COALESCE(success_count, 0) + 1)::numeric / 
        NULLIF(COALESCE(success_count, 0) + 1 + COALESCE(failure_count, 0), 0) * 100, 1
      )
  WHERE id = acc_id;
END;
$$;

-- Create function to increment account failure
CREATE OR REPLACE FUNCTION increment_account_failure(acc_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE telegram_accounts 
  SET failure_count = COALESCE(failure_count, 0) + 1,
      success_rate = ROUND(
        COALESCE(success_count, 0)::numeric / 
        NULLIF(COALESCE(success_count, 0) + COALESCE(failure_count, 0) + 1, 0) * 100, 1
      )
  WHERE id = acc_id;
END;
$$;