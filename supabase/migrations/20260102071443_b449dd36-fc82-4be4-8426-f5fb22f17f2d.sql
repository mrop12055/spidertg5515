-- Create seats table
CREATE TABLE public.seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  access_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  is_active boolean DEFAULT true
);

-- Enable RLS
ALTER TABLE public.seats ENABLE ROW LEVEL SECURITY;

-- Allow all operations (admin access)
CREATE POLICY "Allow all operations for seats"
ON public.seats FOR ALL
USING (true)
WITH CHECK (true);

-- Add seat_id to campaigns table
ALTER TABLE public.campaigns ADD COLUMN seat_id uuid REFERENCES public.seats(id) ON DELETE SET NULL;

-- Add seat_id to conversations table for filtering
ALTER TABLE public.conversations ADD COLUMN seat_id uuid REFERENCES public.seats(id) ON DELETE SET NULL;

-- Create seat_stats view for reporting
CREATE OR REPLACE VIEW public.seat_stats AS
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

-- Enable realtime for seats
ALTER PUBLICATION supabase_realtime ADD TABLE public.seats;