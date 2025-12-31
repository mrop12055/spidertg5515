-- Add 'sending' status to message_status enum
ALTER TYPE message_status ADD VALUE IF NOT EXISTS 'sending' AFTER 'pending';