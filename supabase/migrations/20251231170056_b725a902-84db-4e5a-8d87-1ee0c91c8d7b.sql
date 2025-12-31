-- Link queued messages to the specific campaign recipient they were created for
ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS campaign_recipient_id uuid REFERENCES public.campaign_recipients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_campaign_recipient_id
ON public.messages (campaign_recipient_id);