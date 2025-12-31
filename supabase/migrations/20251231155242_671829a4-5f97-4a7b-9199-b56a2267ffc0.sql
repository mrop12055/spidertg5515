-- Add last_spambot_check column to track when each account was last checked
ALTER TABLE public.telegram_accounts 
ADD COLUMN last_spambot_check timestamp with time zone DEFAULT NULL;