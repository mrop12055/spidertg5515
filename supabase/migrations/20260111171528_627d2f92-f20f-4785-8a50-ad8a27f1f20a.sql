
-- Add unique constraint to prevent duplicate campaign messages per conversation
-- Each campaign_recipient should only have one message per conversation
CREATE UNIQUE INDEX IF NOT EXISTS messages_unique_campaign_recipient 
ON messages (conversation_id, campaign_recipient_id) 
WHERE campaign_recipient_id IS NOT NULL;
