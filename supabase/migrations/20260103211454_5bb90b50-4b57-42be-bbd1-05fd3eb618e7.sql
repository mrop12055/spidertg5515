-- Add retry_count column to track how many times a recipient has been retried
ALTER TABLE public.campaign_recipients 
ADD COLUMN IF NOT EXISTS retry_count integer DEFAULT 0;