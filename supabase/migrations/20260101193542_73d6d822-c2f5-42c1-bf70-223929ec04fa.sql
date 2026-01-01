-- Phase 1: Multi-API ID Distribution System
CREATE TABLE public.telegram_api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  api_id TEXT NOT NULL,
  api_hash TEXT NOT NULL,
  client_type TEXT NOT NULL CHECK (client_type IN ('android', 'desktop', 'ios', 'macos')),
  accounts_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Pre-populate with official Telegram API credentials
INSERT INTO public.telegram_api_credentials (name, api_id, api_hash, client_type) VALUES
  ('Telegram Android', '6', 'eb06d4abfb49dc3eeb1aeb98ae0f581e', 'android'),
  ('Telegram Desktop', '2040', 'b18441a1ff607e10a989891a5462e627', 'desktop'),
  ('Telegram iOS', '10840', '33c45224029d59cb3ad0c16f4fd5ce47', 'ios'),
  ('Telegram macOS', '2834', '68875f756c9b437a8b916ca3de215571', 'macos');

-- Add API credential reference to accounts
ALTER TABLE public.telegram_accounts 
  ADD COLUMN api_credential_id UUID REFERENCES public.telegram_api_credentials(id);

-- Phase 3: Warm-up System
ALTER TABLE public.telegram_accounts 
  ADD COLUMN warmup_phase INTEGER DEFAULT 0 CHECK (warmup_phase >= 0 AND warmup_phase <= 4),
  ADD COLUMN warmup_started_at TIMESTAMP WITH TIME ZONE;

-- Create warmup schedule table
CREATE TABLE public.warmup_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL CHECK (day_number >= 1 AND day_number <= 14),
  task_type TEXT NOT NULL,
  task_description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Phase 4: SpamBot Health Checks
ALTER TABLE public.telegram_accounts 
  ADD COLUMN spambot_status TEXT DEFAULT 'unknown' CHECK (spambot_status IN ('unknown', 'clean', 'limited', 'restricted'));

-- Phase 6: Geographic IP Consistency
ALTER TABLE public.telegram_accounts 
  ADD COLUMN phone_country TEXT,
  ADD COLUMN geo_mismatch BOOLEAN DEFAULT false;

-- Phase 7: Bidirectional Interaction System
ALTER TABLE public.telegram_accounts 
  ADD COLUMN interaction_pair_id UUID;

CREATE TABLE public.scheduled_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  receiver_account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  message_content TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS on new tables
ALTER TABLE public.telegram_api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warmup_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_interactions ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for new tables
CREATE POLICY "Allow all operations for authenticated" ON public.telegram_api_credentials FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.warmup_schedule FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.scheduled_interactions FOR ALL USING (true);

-- Create function to update API credential account counts
CREATE OR REPLACE FUNCTION public.update_api_credential_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.api_credential_id IS NOT NULL THEN
      UPDATE public.telegram_api_credentials 
      SET accounts_count = (SELECT COUNT(*) FROM public.telegram_accounts WHERE api_credential_id = NEW.api_credential_id)
      WHERE id = NEW.api_credential_id;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.api_credential_id IS NOT NULL AND OLD.api_credential_id != NEW.api_credential_id THEN
      UPDATE public.telegram_api_credentials 
      SET accounts_count = (SELECT COUNT(*) FROM public.telegram_accounts WHERE api_credential_id = OLD.api_credential_id)
      WHERE id = OLD.api_credential_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.api_credential_id IS NOT NULL THEN
      UPDATE public.telegram_api_credentials 
      SET accounts_count = (SELECT COUNT(*) FROM public.telegram_accounts WHERE api_credential_id = OLD.api_credential_id)
      WHERE id = OLD.api_credential_id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER update_api_credential_count_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.telegram_accounts
FOR EACH ROW EXECUTE FUNCTION public.update_api_credential_count();

-- Enable realtime for new tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.telegram_api_credentials;
ALTER PUBLICATION supabase_realtime ADD TABLE public.warmup_schedule;
ALTER PUBLICATION supabase_realtime ADD TABLE public.scheduled_interactions;