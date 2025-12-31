-- Create table for SpamBot check tasks
CREATE TABLE public.account_check_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'spambot_check',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Enable RLS
ALTER TABLE public.account_check_tasks ENABLE ROW LEVEL SECURITY;

-- Create policy for all operations
CREATE POLICY "Allow all operations for authenticated" 
ON public.account_check_tasks 
FOR ALL 
USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.account_check_tasks;