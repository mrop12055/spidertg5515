-- Add api_credential_id to messages table to track which API was actually used
ALTER TABLE public.messages 
ADD COLUMN IF NOT EXISTS api_credential_id uuid REFERENCES public.telegram_api_credentials(id);

-- Add api_credential_id to campaign_recipients table to track which API was used
ALTER TABLE public.campaign_recipients 
ADD COLUMN IF NOT EXISTS api_credential_id uuid REFERENCES public.telegram_api_credentials(id);

-- Create index for efficient querying
CREATE INDEX IF NOT EXISTS idx_messages_api_credential_id ON public.messages(api_credential_id);
CREATE INDEX IF NOT EXISTS idx_recipients_api_credential_id ON public.campaign_recipients(api_credential_id);