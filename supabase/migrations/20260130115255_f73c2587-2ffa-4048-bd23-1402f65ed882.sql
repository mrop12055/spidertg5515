-- Backfill seat_id for existing conversations that have campaign_recipients but no seat_id
-- This covers campaign-initiated conversations that weren't properly linked
UPDATE conversations c
SET seat_id = (
  SELECT COALESCE(cr.seat_id, camp.seat_id)
  FROM campaign_recipients cr
  JOIN campaigns camp ON camp.id = cr.campaign_id
  WHERE (
    cr.phone_number = c.recipient_phone 
    OR cr.phone_number = CONCAT('+', REGEXP_REPLACE(c.recipient_phone, '[^0-9]', '', 'g'))
    OR REGEXP_REPLACE(cr.phone_number, '[^0-9]', '', 'g') = REGEXP_REPLACE(c.recipient_phone, '[^0-9]', '', 'g')
  )
  AND cr.status = 'sent'
  ORDER BY cr.sent_at DESC
  LIMIT 1
)
WHERE c.seat_id IS NULL
  AND c.first_message_sent = true;