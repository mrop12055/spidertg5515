
CREATE TABLE IF NOT EXISTS public.seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  access_token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.seats TO authenticated;
GRANT SELECT ON public.seats TO anon;
GRANT ALL ON public.seats TO service_role;

ALTER TABLE public.seats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can manage seats" ON public.seats;
CREATE POLICY "Anyone can manage seats" ON public.seats FOR ALL USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_seats_updated_at ON public.seats;
CREATE TRIGGER update_seats_updated_at
  BEFORE UPDATE ON public.seats
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Aggregated stats view used by the Seats page
CREATE OR REPLACE VIEW public.seat_stats
WITH (security_invoker = on) AS
SELECT
  s.id AS seat_id,
  s.name AS seat_name,
  COALESCE(conv.total_conversations, 0)::bigint AS total_conversations,
  COALESCE(msg.messages_sent_today, 0)::bigint AS messages_sent_today,
  COALESCE(msg_read.messages_read, 0)::bigint AS messages_read,
  COALESCE(replies.responses_received, 0)::bigint AS responses_received,
  COALESCE(replies_today.responses_today, 0)::bigint AS responses_today
FROM public.seats s
LEFT JOIN (
  SELECT seat_id, COUNT(*) AS total_conversations
  FROM public.conversations WHERE seat_id IS NOT NULL GROUP BY seat_id
) conv ON conv.seat_id = s.id
LEFT JOIN (
  SELECT c.seat_id, COUNT(*) AS messages_sent_today
  FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
  WHERE m.direction = 'outgoing' AND m.created_at >= CURRENT_DATE AND c.seat_id IS NOT NULL
  GROUP BY c.seat_id
) msg ON msg.seat_id = s.id
LEFT JOIN (
  SELECT c.seat_id, COUNT(*) AS messages_read
  FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
  WHERE m.direction = 'incoming' AND m.read_at IS NOT NULL AND c.seat_id IS NOT NULL
  GROUP BY c.seat_id
) msg_read ON msg_read.seat_id = s.id
LEFT JOIN (
  SELECT seat_id, COUNT(*) AS responses_received
  FROM public.conversations WHERE has_reply = true AND seat_id IS NOT NULL GROUP BY seat_id
) replies ON replies.seat_id = s.id
LEFT JOIN (
  SELECT c.seat_id, COUNT(DISTINCT c.id) AS responses_today
  FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
  WHERE m.direction = 'incoming' AND m.created_at >= CURRENT_DATE AND c.seat_id IS NOT NULL
  GROUP BY c.seat_id
) replies_today ON replies_today.seat_id = s.id;

GRANT SELECT ON public.seat_stats TO authenticated, anon, service_role;

ALTER TABLE public.seats REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.seats;
