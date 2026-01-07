
-- Drop and recreate the seat_stats view to count outgoing messages read by recipients
DROP VIEW IF EXISTS public.seat_stats;

CREATE VIEW public.seat_stats AS
SELECT 
  s.id AS seat_id,
  s.name AS seat_name,
  COUNT(DISTINCT c.id) AS total_conversations,
  COUNT(DISTINCT CASE WHEN c.first_message_sent = true THEN c.id END) AS conversations_started,
  COUNT(DISTINCT CASE WHEN m.direction = 'outgoing' AND DATE(m.created_at) = CURRENT_DATE THEN m.id END) AS messages_sent_today,
  -- Changed: Count outgoing messages with status='read' (recipient read them) today
  COUNT(DISTINCT CASE WHEN m.direction = 'outgoing' AND m.status = 'read' AND DATE(m.created_at) = CURRENT_DATE THEN m.id END) AS messages_read,
  COUNT(DISTINCT CASE WHEN m.direction = 'incoming' THEN c.id END) AS responses_received,
  COUNT(DISTINCT CASE WHEN m.direction = 'incoming' AND DATE(m.created_at) = CURRENT_DATE THEN c.id END) AS responses_today
FROM seats s
LEFT JOIN conversations c ON c.seat_id = s.id
LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY s.id, s.name;
