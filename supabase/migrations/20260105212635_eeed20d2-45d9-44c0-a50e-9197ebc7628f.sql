-- Add task leasing and cycle tracking fields to warmup_messages
ALTER TABLE public.warmup_messages 
ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.warmup_message_templates(id),
ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
ADD COLUMN IF NOT EXISTS claimed_by text,
ADD COLUMN IF NOT EXISTS is_cycle_last boolean DEFAULT false;

-- Add cycle tracking and failure reason to warmup_pairs
ALTER TABLE public.warmup_pairs 
ADD COLUMN IF NOT EXISTS cycles_completed_today integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_cycle_date date,
ADD COLUMN IF NOT EXISTS last_template_id uuid,
ADD COLUMN IF NOT EXISTS failed_reason text;

-- Create index for efficient stuck task detection
CREATE INDEX IF NOT EXISTS idx_warmup_messages_claimed_stuck 
ON public.warmup_messages(claimed_at, status) 
WHERE status = 'sending';

-- Create index for cycle date queries
CREATE INDEX IF NOT EXISTS idx_warmup_pairs_cycle_date 
ON public.warmup_pairs(last_cycle_date);