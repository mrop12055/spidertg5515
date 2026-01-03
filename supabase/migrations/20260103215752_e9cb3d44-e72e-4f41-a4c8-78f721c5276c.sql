-- Add column to track which accounts have failed for each recipient
ALTER TABLE campaign_recipients 
ADD COLUMN IF NOT EXISTS failed_account_ids uuid[] DEFAULT '{}';