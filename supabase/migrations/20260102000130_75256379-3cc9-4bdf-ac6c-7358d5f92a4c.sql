-- Add failed_reason column to campaign_recipients table
ALTER TABLE public.campaign_recipients 
ADD COLUMN failed_reason TEXT;