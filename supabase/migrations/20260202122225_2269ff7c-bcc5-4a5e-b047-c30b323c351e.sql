-- Add indexes on campaign_recipients table for faster queries
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON public.campaign_recipients(status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id_status ON public.campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_sent_by_account_id ON public.campaign_recipients(sent_by_account_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_sending_started ON public.campaign_recipients(sending_started_at);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_seat_id ON public.campaign_recipients(seat_id);

-- Add indexes on messages table for faster queries  
CREATE INDEX IF NOT EXISTS idx_messages_status ON public.messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON public.messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_status_created ON public.messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_account_id_status ON public.messages(account_id, status);

-- Add index on conversations for faster lookups
CREATE INDEX IF NOT EXISTS idx_conversations_account_id ON public.conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON public.conversations(last_message_at);
CREATE INDEX IF NOT EXISTS idx_conversations_seat_id ON public.conversations(seat_id);

-- Add indexes on telegram_accounts for faster status lookups
CREATE INDEX IF NOT EXISTS idx_telegram_accounts_status ON public.telegram_accounts(status);
CREATE INDEX IF NOT EXISTS idx_telegram_accounts_last_active ON public.telegram_accounts(last_active);