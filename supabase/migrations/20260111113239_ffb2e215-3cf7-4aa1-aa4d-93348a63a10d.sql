-- Add failed_api_ids column to track which APIs have failed for a recipient
-- This enables smart API rotation when "Too many requests" or "Privacy restricted" errors occur

ALTER TABLE public.campaign_recipients 
ADD COLUMN IF NOT EXISTS failed_api_ids uuid[] DEFAULT '{}';

-- Add comment for documentation
COMMENT ON COLUMN public.campaign_recipients.failed_api_ids IS 'Array of API credential IDs that have failed for this recipient, used to avoid retrying with the same API';