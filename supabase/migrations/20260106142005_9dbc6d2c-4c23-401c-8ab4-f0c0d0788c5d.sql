-- Enable realtime for vps_logs and vps_connections (vps_commands already added)
ALTER TABLE public.vps_commands REPLICA IDENTITY FULL;
ALTER TABLE public.vps_logs REPLICA IDENTITY FULL;
ALTER TABLE public.vps_connections REPLICA IDENTITY FULL;

-- Add tables to realtime publication (ignore if already exists)
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.vps_logs;
  EXCEPTION WHEN duplicate_object THEN
    -- already exists
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.vps_connections;
  EXCEPTION WHEN duplicate_object THEN
    -- already exists
  END;
END $$;