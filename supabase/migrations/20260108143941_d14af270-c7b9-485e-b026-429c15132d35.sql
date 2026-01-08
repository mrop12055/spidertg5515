-- Add server_id column to track unique server instances
ALTER TABLE public.runner_heartbeats 
ADD COLUMN IF NOT EXISTS server_id TEXT DEFAULT 'legacy';

-- Drop existing unique CONSTRAINT on runner_name (not index)
ALTER TABLE public.runner_heartbeats DROP CONSTRAINT IF EXISTS runner_heartbeats_runner_name_key;

-- Create composite unique index for runner_name + server_id
CREATE UNIQUE INDEX IF NOT EXISTS runner_heartbeats_runner_server_idx 
ON public.runner_heartbeats(runner_name, COALESCE(server_id, 'legacy'));