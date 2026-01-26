-- Enable realtime for error-related tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.vps_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.warmup_errors;
ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_recipients;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.account_check_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.telegram_accounts;