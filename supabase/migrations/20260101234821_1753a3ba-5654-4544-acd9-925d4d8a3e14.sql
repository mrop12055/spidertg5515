-- Create a table to store app-wide settings
CREATE TABLE public.app_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key text NOT NULL UNIQUE,
  value jsonb NOT NULL,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Allow all operations (single-user app)
CREATE POLICY "Allow all operations for app_settings" 
ON public.app_settings 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Trigger for updated_at
CREATE TRIGGER update_app_settings_updated_at
BEFORE UPDATE ON public.app_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default settings
INSERT INTO public.app_settings (key, value, description) VALUES
('message_timing', '{"minDelaySeconds": 5, "maxDelaySeconds": 15, "accountSwitchDelaySeconds": 30}', 'Delay settings between messages'),
('scheduler', '{"enabled": true, "maxMessagesBeforeRotation": 10, "cooldownDuration": 300, "prioritizeHighMaturity": true, "autoSkipRestricted": true, "balanceLoad": true}', 'Account rotation scheduler settings'),
('account_limits', '{"dailyMessageLimit": 25, "warmupDays": 14, "messagesPerAccount": 10}', 'Account daily limits and warmup'),
('safety', '{"autoRestartBanned": true, "proxyRotation": false}', 'Safety and proxy settings'),
('cleanup', '{"autoCleanup": true, "retentionDays": 30}', 'Auto cleanup settings');
