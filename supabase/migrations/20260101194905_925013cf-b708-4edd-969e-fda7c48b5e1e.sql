-- Add interaction scheduler table for bidirectional messaging (Phase 7)
CREATE TABLE IF NOT EXISTS public.interaction_scheduler (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  receiver_account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  message_content TEXT NOT NULL,
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  sent_at TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add warmup_schedule improvements for 14-day system (Phase 3)
ALTER TABLE public.warmup_schedule 
ADD COLUMN IF NOT EXISTS channel_username TEXT,
ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;

-- Add first_message_sent flag to track first contact (Phase 5)
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS first_message_sent BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS has_prior_contact BOOLEAN DEFAULT false;

-- Add proxy_country to proxies table (Phase 6)
ALTER TABLE public.proxies
ADD COLUMN IF NOT EXISTS detected_country TEXT;

-- Enable RLS on interaction_scheduler
ALTER TABLE public.interaction_scheduler ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for interaction_scheduler
CREATE POLICY "Allow all operations for authenticated" 
ON public.interaction_scheduler 
FOR ALL 
USING (true);

-- Enable realtime for interaction_scheduler
ALTER PUBLICATION supabase_realtime ADD TABLE public.interaction_scheduler;