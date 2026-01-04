-- Phase A1: Add new columns to conversations table only
ALTER TABLE public.conversations 
ADD COLUMN IF NOT EXISTS last_message_content text,
ADD COLUMN IF NOT EXISTS last_message_direction text,
ADD COLUMN IF NOT EXISTS has_reply boolean DEFAULT false;