-- Add sending_started_at column to track when a recipient was picked up for sending
ALTER TABLE public.campaign_recipients 
ADD COLUMN sending_started_at TIMESTAMPTZ;

-- Create index for efficient stale task queries
CREATE INDEX idx_campaign_recipients_stale_check 
ON public.campaign_recipients (status, sending_started_at) 
WHERE status = 'sending';