-- Create a table to store lifetime stats that persist even when data is deleted
CREATE TABLE IF NOT EXISTS public.lifetime_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_key text UNIQUE NOT NULL,
  stat_value bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.lifetime_stats ENABLE ROW LEVEL SECURITY;

-- Create policy for admin access
CREATE POLICY "Public access for admin tool" ON public.lifetime_stats
  FOR ALL USING (true) WITH CHECK (true);

-- Insert initial counters (will be populated from existing data)
INSERT INTO public.lifetime_stats (stat_key, stat_value) VALUES
  ('lifetime_unique_recipients_messaged', 0),
  ('lifetime_unique_recipients_replied', 0)
ON CONFLICT (stat_key) DO NOTHING;

-- Initialize with current unique recipient counts from conversations
UPDATE public.lifetime_stats 
SET stat_value = (
  SELECT COUNT(DISTINCT recipient_phone) 
  FROM public.conversations 
  WHERE first_message_sent = true AND recipient_phone IS NOT NULL
),
updated_at = now()
WHERE stat_key = 'lifetime_unique_recipients_messaged';

UPDATE public.lifetime_stats 
SET stat_value = (
  SELECT COUNT(DISTINCT recipient_phone) 
  FROM public.conversations 
  WHERE has_reply = true AND recipient_phone IS NOT NULL
),
updated_at = now()
WHERE stat_key = 'lifetime_unique_recipients_replied';

-- Create function to increment lifetime stats (called when new unique recipient is messaged/replied)
CREATE OR REPLACE FUNCTION increment_lifetime_stat(p_stat_key text, p_increment bigint DEFAULT 1)
RETURNS void AS $$
BEGIN
  UPDATE public.lifetime_stats 
  SET stat_value = stat_value + p_increment, updated_at = now()
  WHERE stat_key = p_stat_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger function to track new unique recipients messaged
CREATE OR REPLACE FUNCTION track_new_recipient_messaged()
RETURNS TRIGGER AS $$
BEGIN
  -- When first_message_sent changes from false to true, increment the counter
  IF (OLD.first_message_sent IS DISTINCT FROM true) AND (NEW.first_message_sent = true) THEN
    -- Check if this phone number was ever messaged before (in any conversation)
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations 
      WHERE recipient_phone = NEW.recipient_phone 
        AND first_message_sent = true 
        AND id != NEW.id
    ) THEN
      PERFORM increment_lifetime_stat('lifetime_unique_recipients_messaged', 1);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger function to track new unique recipients who replied
CREATE OR REPLACE FUNCTION track_new_recipient_replied()
RETURNS TRIGGER AS $$
BEGIN
  -- When has_reply changes from false to true, increment the counter
  IF (OLD.has_reply IS DISTINCT FROM true) AND (NEW.has_reply = true) THEN
    -- Check if this phone number ever replied before (in any conversation)
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations 
      WHERE recipient_phone = NEW.recipient_phone 
        AND has_reply = true 
        AND id != NEW.id
    ) THEN
      PERFORM increment_lifetime_stat('lifetime_unique_recipients_replied', 1);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create triggers on conversations table
DROP TRIGGER IF EXISTS track_recipient_messaged_trigger ON public.conversations;
CREATE TRIGGER track_recipient_messaged_trigger
  AFTER UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION track_new_recipient_messaged();

DROP TRIGGER IF EXISTS track_recipient_replied_trigger ON public.conversations;
CREATE TRIGGER track_recipient_replied_trigger
  AFTER UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION track_new_recipient_replied();

-- Also handle INSERT for new conversations that already have first_message_sent or has_reply
CREATE OR REPLACE FUNCTION track_new_conversation_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if first message was sent and this is a new unique recipient
  IF NEW.first_message_sent = true AND NEW.recipient_phone IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations 
      WHERE recipient_phone = NEW.recipient_phone 
        AND first_message_sent = true 
        AND id != NEW.id
    ) THEN
      PERFORM increment_lifetime_stat('lifetime_unique_recipients_messaged', 1);
    END IF;
  END IF;
  
  -- Check if has_reply and this is a new unique recipient who replied
  IF NEW.has_reply = true AND NEW.recipient_phone IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations 
      WHERE recipient_phone = NEW.recipient_phone 
        AND has_reply = true 
        AND id != NEW.id
    ) THEN
      PERFORM increment_lifetime_stat('lifetime_unique_recipients_replied', 1);
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS track_new_conversation_stats_trigger ON public.conversations;
CREATE TRIGGER track_new_conversation_stats_trigger
  AFTER INSERT ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION track_new_conversation_stats();