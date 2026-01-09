-- Add scheduled_at column to campaign_recipients for queue timing
ALTER TABLE campaign_recipients 
ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ DEFAULT NULL;

-- Add index for efficient queue queries
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_queue 
ON campaign_recipients(campaign_id, status, scheduled_at) 
WHERE status IN ('queued', 'pending');

-- Add comment explaining the queue system
COMMENT ON COLUMN campaign_recipients.scheduled_at IS 'Timestamp when recipient was released from queue to pending status';