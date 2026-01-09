-- Add restricted_until column to telegram_accounts table
ALTER TABLE public.telegram_accounts 
ADD COLUMN IF NOT EXISTS restricted_until TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN public.telegram_accounts.restricted_until IS 'Timestamp until which the account is temporarily restricted from sending messages';