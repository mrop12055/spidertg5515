-- Add 'cancelled' to message_status enum
ALTER TYPE message_status ADD VALUE IF NOT EXISTS 'cancelled';

-- Create function to cancel pending messages when campaign recipients are deleted
CREATE OR REPLACE FUNCTION cancel_messages_on_recipient_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE messages 
  SET status = 'cancelled', failed_reason = 'Campaign deleted' 
  WHERE campaign_recipient_id = OLD.id AND status = 'pending';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger to auto-cancel messages when recipient is deleted
DROP TRIGGER IF EXISTS before_campaign_recipient_delete ON campaign_recipients;
CREATE TRIGGER before_campaign_recipient_delete
  BEFORE DELETE ON campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION cancel_messages_on_recipient_delete();