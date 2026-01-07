-- Enable REPLICA IDENTITY FULL for proper realtime updates
ALTER TABLE public.vps_logs REPLICA IDENTITY FULL;

-- Also update vps_commands for complete realtime support
ALTER TABLE public.vps_commands REPLICA IDENTITY FULL;