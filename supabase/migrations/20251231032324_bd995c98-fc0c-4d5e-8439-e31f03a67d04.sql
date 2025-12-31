-- Create enums for status types
CREATE TYPE public.account_status AS ENUM ('active', 'banned', 'restricted', 'disconnected', 'cooldown');
CREATE TYPE public.proxy_status AS ENUM ('active', 'inactive', 'error');
CREATE TYPE public.proxy_type AS ENUM ('http', 'https', 'socks4', 'socks5');
CREATE TYPE public.message_status AS ENUM ('pending', 'sent', 'delivered', 'read', 'failed');
CREATE TYPE public.message_direction AS ENUM ('incoming', 'outgoing');
CREATE TYPE public.campaign_status AS ENUM ('draft', 'scheduled', 'running', 'paused', 'completed');

-- Telegram Accounts Table
CREATE TABLE public.telegram_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  status account_status DEFAULT 'disconnected',
  proxy_id UUID,
  session_data TEXT, -- Encrypted session string from Telethon
  api_id TEXT,
  api_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_active TIMESTAMPTZ,
  messages_sent_today INTEGER DEFAULT 0,
  daily_limit INTEGER DEFAULT 25,
  maturity_score INTEGER DEFAULT 0,
  maturity_days INTEGER DEFAULT 0,
  restricted_until TIMESTAMPTZ,
  ban_reason TEXT,
  avatar_url TEXT,
  telegram_id BIGINT
);

-- Proxies Table
CREATE TABLE public.proxies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT,
  password TEXT,
  proxy_type proxy_type DEFAULT 'http',
  status proxy_status DEFAULT 'active',
  assigned_account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE SET NULL,
  last_checked TIMESTAMPTZ,
  response_time INTEGER,
  country TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add foreign key for proxy_id after proxies table exists
ALTER TABLE public.telegram_accounts 
  ADD CONSTRAINT fk_proxy FOREIGN KEY (proxy_id) REFERENCES public.proxies(id) ON DELETE SET NULL;

-- Conversations Table
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE CASCADE NOT NULL,
  recipient_phone TEXT,
  recipient_telegram_id BIGINT,
  recipient_name TEXT,
  recipient_username TEXT,
  recipient_avatar TEXT,
  unread_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT false,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Messages Table
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE CASCADE NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE NOT NULL,
  telegram_message_id BIGINT,
  content TEXT NOT NULL,
  direction message_direction NOT NULL,
  status message_status DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);

-- Campaigns Table
CREATE TABLE public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  message_template TEXT NOT NULL,
  status campaign_status DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  recipient_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Campaign Accounts Junction Table
CREATE TABLE public.campaign_accounts (
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, account_id)
);

-- Campaign Recipients Table
CREATE TABLE public.campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE CASCADE NOT NULL,
  phone_number TEXT NOT NULL,
  name TEXT,
  status TEXT DEFAULT 'pending', -- pending, sent, failed, replied
  sent_at TIMESTAMPTZ,
  sent_by_account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE SET NULL
);

-- Maturation Tasks Table
CREATE TABLE public.maturation_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.telegram_accounts(id) ON DELETE CASCADE NOT NULL,
  task_type TEXT NOT NULL, -- join_channel, send_message, view_content, add_contact, profile_update
  status TEXT DEFAULT 'pending', -- pending, in_progress, completed, failed
  scheduled_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- VPS Connection Table (for tracking backend connections)
CREATE TABLE public.vps_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE, -- API key for VPS to authenticate
  last_seen TIMESTAMPTZ,
  status TEXT DEFAULT 'disconnected',
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on all tables (but allow public access for VPS API)
ALTER TABLE public.telegram_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maturation_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vps_connections ENABLE ROW LEVEL SECURITY;

-- Create policies for public access (VPS API will use service role key)
CREATE POLICY "Allow all operations for authenticated" ON public.telegram_accounts FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.proxies FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.conversations FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.messages FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.campaigns FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.campaign_accounts FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.campaign_recipients FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.maturation_tasks FOR ALL USING (true);
CREATE POLICY "Allow all operations for authenticated" ON public.vps_connections FOR ALL USING (true);

-- Enable realtime for messages and conversations
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.telegram_accounts;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at
CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Function to reset daily message counts at midnight
CREATE OR REPLACE FUNCTION public.reset_daily_message_counts()
RETURNS void AS $$
BEGIN
  UPDATE public.telegram_accounts SET messages_sent_today = 0;
END;
$$ LANGUAGE plpgsql;