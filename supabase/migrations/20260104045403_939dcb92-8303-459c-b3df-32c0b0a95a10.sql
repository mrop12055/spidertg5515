-- Phase A3: Add performance indexes
CREATE INDEX IF NOT EXISTS idx_conversations_first_message_sent ON public.conversations(first_message_sent);
CREATE INDEX IF NOT EXISTS idx_conversations_seat_last_message ON public.conversations(seat_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_account_updated ON public.conversations(account_id, updated_at DESC);