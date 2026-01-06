-- Create VPS commands table for communication
CREATE TABLE public.vps_commands (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vps_id UUID REFERENCES public.vps_connections(id) ON DELETE CASCADE,
  command TEXT NOT NULL, -- start, stop, restart, update, start_runner, stop_runner
  target_runner TEXT, -- null for all, or specific runner name
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
  result TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  processed_at TIMESTAMP WITH TIME ZONE
);

-- Create VPS logs table for viewing runner output
CREATE TABLE public.vps_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  vps_id UUID REFERENCES public.vps_connections(id) ON DELETE CASCADE,
  runner_name TEXT NOT NULL,
  log_level TEXT DEFAULT 'info', -- info, warning, error
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for faster polling
CREATE INDEX idx_vps_commands_pending ON public.vps_commands(vps_id, status) WHERE status = 'pending';
CREATE INDEX idx_vps_logs_vps_runner ON public.vps_logs(vps_id, runner_name, created_at DESC);

-- Enable RLS
ALTER TABLE public.vps_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vps_logs ENABLE ROW LEVEL SECURITY;

-- RLS policies - allow authenticated users
CREATE POLICY "Allow authenticated users to manage vps_commands"
ON public.vps_commands FOR ALL
USING (public.is_authenticated());

CREATE POLICY "Allow authenticated users to view vps_logs"
ON public.vps_logs FOR ALL
USING (public.is_authenticated());

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.vps_commands;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vps_logs;