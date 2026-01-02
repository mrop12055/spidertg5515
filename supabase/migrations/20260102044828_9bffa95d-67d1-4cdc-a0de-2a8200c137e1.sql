-- Create a table to track runner heartbeats
CREATE TABLE public.runner_heartbeats (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  runner_name text NOT NULL UNIQUE,
  last_seen timestamp with time zone NOT NULL DEFAULT now(),
  ip_address text,
  status text DEFAULT 'online',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.runner_heartbeats ENABLE ROW LEVEL SECURITY;

-- Create policy for all operations
CREATE POLICY "Allow all operations for runner_heartbeats" 
ON public.runner_heartbeats 
FOR ALL 
USING (true)
WITH CHECK (true);