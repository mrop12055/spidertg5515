-- Add unique constraint on runner_name for upsert to work properly
ALTER TABLE public.runner_heartbeats ADD CONSTRAINT runner_heartbeats_runner_name_key UNIQUE (runner_name);