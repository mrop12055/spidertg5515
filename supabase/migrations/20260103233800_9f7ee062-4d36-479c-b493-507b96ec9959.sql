-- Add validation columns to telegram_api_credentials
ALTER TABLE public.telegram_api_credentials 
ADD COLUMN IF NOT EXISTS last_validated_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS validation_error text;