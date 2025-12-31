-- Add failed_reason column to messages table
ALTER TABLE public.messages 
ADD COLUMN failed_reason text;