-- Add column to track if warmup pair has already exchanged contacts (permanent flag)
ALTER TABLE public.warmup_pairs 
ADD COLUMN IF NOT EXISTS contacts_exchanged boolean DEFAULT false;