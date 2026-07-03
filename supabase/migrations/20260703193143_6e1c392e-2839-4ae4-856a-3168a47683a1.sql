ALTER TABLE public.telegram_accounts REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.telegram_accounts;