-- Add pinned and hidden columns to conversations table
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS is_pinned boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS is_hidden boolean DEFAULT false;