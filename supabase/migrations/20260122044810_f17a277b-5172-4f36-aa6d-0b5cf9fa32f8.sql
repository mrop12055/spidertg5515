-- Add build_id column for manufacturer-specific build identifiers
ALTER TABLE public.telegram_accounts 
ADD COLUMN IF NOT EXISTS build_id TEXT;