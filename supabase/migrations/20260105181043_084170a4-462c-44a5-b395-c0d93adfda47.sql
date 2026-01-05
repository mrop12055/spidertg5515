-- Enable realtime for warmup tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.warmup_pairs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.warmup_sessions;