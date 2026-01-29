-- Add two_fa_password column to telegram_accounts table
-- This stores the 2FA password from JSON metadata for automatic handling
ALTER TABLE public.telegram_accounts ADD COLUMN IF NOT EXISTS two_fa_password text;