-- Add composite index for fast seat chat queries (filters has_reply + sorts by last_message_at)
CREATE INDEX IF NOT EXISTS idx_conversations_seat_reply_time 
ON public.conversations (seat_id, has_reply, last_message_at DESC)
WHERE seat_id IS NOT NULL;