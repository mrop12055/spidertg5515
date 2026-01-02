-- Create trigger to increment unread count on incoming messages
CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.conversations
  SET 
    updated_at = NOW(),
    last_message_at = NOW(),
    unread_count = CASE 
      WHEN NEW.direction = 'incoming' THEN COALESCE(unread_count, 0) + 1 
      ELSE unread_count 
    END
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create the trigger if it doesn't exist
DROP TRIGGER IF EXISTS on_message_insert ON public.messages;
CREATE TRIGGER on_message_insert
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_on_message();

-- Create contacts_data table for storing phone numbers/usernames for campaigns
CREATE TABLE IF NOT EXISTS public.contacts_data (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL,
  name TEXT,
  username TEXT,
  notes TEXT,
  is_used BOOLEAN DEFAULT false,
  used_in_campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  is_blocked BOOLEAN DEFAULT false,
  blocked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(phone_number)
);

-- Enable RLS
ALTER TABLE public.contacts_data ENABLE ROW LEVEL SECURITY;

-- Create RLS policy
CREATE POLICY "Allow all operations for contacts_data"
  ON public.contacts_data
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create updated_at trigger
CREATE TRIGGER update_contacts_data_updated_at
  BEFORE UPDATE ON public.contacts_data
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create blocked_contacts table for storing blocked phone numbers
CREATE TABLE IF NOT EXISTS public.blocked_contacts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL,
  name TEXT,
  blocked_by_account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(phone_number)
);

-- Enable RLS
ALTER TABLE public.blocked_contacts ENABLE ROW LEVEL SECURITY;

-- Create RLS policy
CREATE POLICY "Allow all operations for blocked_contacts"
  ON public.blocked_contacts
  FOR ALL
  USING (true)
  WITH CHECK (true);