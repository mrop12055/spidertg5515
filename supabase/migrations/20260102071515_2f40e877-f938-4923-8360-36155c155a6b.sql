-- Drop the SECURITY DEFINER view and recreate without it
DROP VIEW IF EXISTS public.seat_stats;

-- Recreate as a regular view (SECURITY INVOKER is default and safe)
CREATE VIEW public.seat_stats AS
SELECT 
  s.id as seat_id,
  s.name as seat_name,
  COUNT(DISTINCT c.id) as total_conversations,
  COUNT(DISTINCT CASE WHEN m.direction = 'outgoing' AND m.created_at::date = CURRENT_DATE THEN m.id END) as messages_sent_today,
  COUNT(DISTINCT CASE WHEN m.read_at IS NOT NULL THEN m.id END) as messages_read,
  COUNT(DISTINCT CASE WHEN m.direction = 'incoming' THEN m.id END) as responses_received
FROM public.seats s
LEFT JOIN public.conversations c ON c.seat_id = s.id
LEFT JOIN public.messages m ON m.conversation_id = c.id
GROUP BY s.id, s.name;