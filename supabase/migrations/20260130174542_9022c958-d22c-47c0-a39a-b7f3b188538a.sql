-- Enable realtime for campaigns table so count updates are pushed to UI
ALTER PUBLICATION supabase_realtime ADD TABLE public.campaigns;