-- Add ON DELETE SET NULL to foreign keys so API credentials can be deleted when accounts are deleted

-- Drop existing constraints if they exist
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_api_credential_id_fkey;
ALTER TABLE campaign_recipients DROP CONSTRAINT IF EXISTS campaign_recipients_api_credential_id_fkey;

-- Recreate with ON DELETE SET NULL
ALTER TABLE messages 
  ADD CONSTRAINT messages_api_credential_id_fkey 
  FOREIGN KEY (api_credential_id) 
  REFERENCES telegram_api_credentials(id) 
  ON DELETE SET NULL;

ALTER TABLE campaign_recipients 
  ADD CONSTRAINT campaign_recipients_api_credential_id_fkey 
  FOREIGN KEY (api_credential_id) 
  REFERENCES telegram_api_credentials(id) 
  ON DELETE SET NULL;