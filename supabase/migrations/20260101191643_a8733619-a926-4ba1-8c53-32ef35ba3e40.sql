-- Add device fingerprint columns to telegram_accounts
ALTER TABLE public.telegram_accounts 
ADD COLUMN IF NOT EXISTS device_model text,
ADD COLUMN IF NOT EXISTS system_version text,
ADD COLUMN IF NOT EXISTS app_version text,
ADD COLUMN IF NOT EXISTS lang_code text DEFAULT 'en',
ADD COLUMN IF NOT EXISTS system_lang_code text DEFAULT 'en-US';