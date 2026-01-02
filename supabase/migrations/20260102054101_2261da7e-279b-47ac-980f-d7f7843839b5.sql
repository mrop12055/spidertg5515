-- Add tags column to telegram_accounts table
ALTER TABLE public.telegram_accounts 
ADD COLUMN tags text[] DEFAULT '{}'::text[];

-- Create index for faster tag filtering
CREATE INDEX idx_telegram_accounts_tags ON public.telegram_accounts USING GIN(tags);