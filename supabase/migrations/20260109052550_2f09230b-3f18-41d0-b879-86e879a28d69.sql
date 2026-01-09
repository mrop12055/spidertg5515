-- Fix seat_stats view to count unique conversations, not total messages
CREATE OR REPLACE VIEW public.seat_stats AS
SELECT 
    s.id AS seat_id,
    s.name AS seat_name,
    count(DISTINCT c.id) AS total_conversations,
    count(DISTINCT
        CASE
            WHEN c.first_message_sent = true THEN c.id
            ELSE NULL::uuid
        END) AS conversations_started,
    -- Changed: Count unique conversations messaged today, not total messages
    count(DISTINCT
        CASE
            WHEN m.direction = 'outgoing'::message_direction AND date(m.created_at) = CURRENT_DATE THEN c.id
            ELSE NULL::uuid
        END) AS messages_sent_today,
    count(DISTINCT
        CASE
            WHEN m.direction = 'outgoing'::message_direction AND m.status = 'read'::message_status AND date(m.created_at) = CURRENT_DATE THEN c.id
            ELSE NULL::uuid
        END) AS messages_read,
    count(DISTINCT
        CASE
            WHEN m.direction = 'incoming'::message_direction THEN c.id
            ELSE NULL::uuid
        END) AS responses_received,
    count(DISTINCT
        CASE
            WHEN m.direction = 'incoming'::message_direction AND date(m.created_at) = CURRENT_DATE THEN c.id
            ELSE NULL::uuid
        END) AS responses_today
FROM seats s
LEFT JOIN conversations c ON c.seat_id = s.id
LEFT JOIN messages m ON m.conversation_id = c.id
GROUP BY s.id, s.name;