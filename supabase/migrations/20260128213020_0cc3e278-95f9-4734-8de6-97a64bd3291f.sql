-- Add last_offline_at column to runner_heartbeats for accurate message sync
ALTER TABLE runner_heartbeats 
ADD COLUMN IF NOT EXISTS last_offline_at TIMESTAMPTZ;