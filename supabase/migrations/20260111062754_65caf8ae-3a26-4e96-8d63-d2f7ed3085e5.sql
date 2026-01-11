-- Add seat_id to campaign_recipients for per-recipient seat assignment
ALTER TABLE public.campaign_recipients 
ADD COLUMN IF NOT EXISTS seat_id UUID REFERENCES public.seats(id) ON DELETE SET NULL;

-- Create index for efficient seat filtering
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_seat_id ON public.campaign_recipients(seat_id);

-- Add comment explaining the column
COMMENT ON COLUMN public.campaign_recipients.seat_id IS 'The seat assigned to handle this recipient. Allows single campaign to distribute recipients across multiple seats.';