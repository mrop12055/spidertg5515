
-- Add indexes to improve query performance on frequently queried columns
CREATE INDEX IF NOT EXISTS idx_telegram_accounts_status ON public.telegram_accounts(status);
CREATE INDEX IF NOT EXISTS idx_telegram_accounts_created_at ON public.telegram_accounts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON public.campaign_recipients(status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON public.campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON public.messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON public.conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON public.conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxies_status ON public.proxies(status);
