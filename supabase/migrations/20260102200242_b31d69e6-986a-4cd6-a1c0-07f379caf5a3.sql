-- Add indexes to speed up conversation queries
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON public.conversations (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_conversations_account_id ON public.conversations (account_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON public.conversations (created_at DESC);