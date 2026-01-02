-- Add priority column to messages table for queue prioritization
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS priority integer DEFAULT 0;

-- Create index for faster priority-based queries
CREATE INDEX IF NOT EXISTS idx_messages_priority_status ON public.messages (priority DESC, status) WHERE status = 'pending';

-- Comment explaining priority values
COMMENT ON COLUMN public.messages.priority IS 'Message priority: 10=live chat (highest), 5=campaign, 0=other';