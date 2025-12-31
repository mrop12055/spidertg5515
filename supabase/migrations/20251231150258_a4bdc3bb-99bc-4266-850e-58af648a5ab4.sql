-- Add blocked_by_recipient to conversations
ALTER TABLE conversations ADD COLUMN blocked_by_recipient boolean DEFAULT false;