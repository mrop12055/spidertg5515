-- Add campaign reference to conversations for history preservation
ALTER TABLE public.conversations 
ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS campaign_name text;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_conversations_campaign_id ON public.conversations(campaign_id) WHERE campaign_id IS NOT NULL;

-- Add comment explaining the purpose
COMMENT ON COLUMN public.conversations.campaign_id IS 'Reference to originating campaign (set to NULL when campaign is deleted)';
COMMENT ON COLUMN public.conversations.campaign_name IS 'Preserved campaign name for history display after campaign deletion';