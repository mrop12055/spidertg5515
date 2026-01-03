-- Add last_campaign_send_at column to track when each account last sent a campaign message
-- This enables server-side rate limiting to prevent runners from polling too fast

ALTER TABLE public.telegram_accounts 
ADD COLUMN IF NOT EXISTS last_campaign_send_at timestamp with time zone DEFAULT NULL;

-- Add index for efficient querying
CREATE INDEX IF NOT EXISTS idx_telegram_accounts_last_campaign_send_at 
ON public.telegram_accounts(last_campaign_send_at) 
WHERE last_campaign_send_at IS NOT NULL;