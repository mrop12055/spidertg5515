-- Drop and recreate seat_stats view with conversations_started count
DROP VIEW IF EXISTS public.seat_stats;

CREATE VIEW public.seat_stats AS
SELECT 
  s.id AS seat_id,
  s.name AS seat_name,
  count(DISTINCT c.id) AS total_conversations,
  count(DISTINCT 
    CASE 
      WHEN c.first_message_sent = true THEN c.id 
      ELSE NULL 
    END
  ) AS conversations_started,
  count(DISTINCT 
    CASE 
      WHEN m.direction = 'outgoing'::message_direction 
        AND m.created_at::date = CURRENT_DATE THEN m.id 
      ELSE NULL 
    END
  ) AS messages_sent_today,
  count(DISTINCT 
    CASE 
      WHEN m.read_at IS NOT NULL THEN m.id 
      ELSE NULL 
    END
  ) AS messages_read,
  count(DISTINCT 
    CASE 
      WHEN m.direction = 'incoming'::message_direction THEN c.id 
      ELSE NULL 
    END
  ) AS responses_received
FROM seats s
LEFT JOIN conversations c ON c.seat_id = s.id
LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY s.id, s.name;