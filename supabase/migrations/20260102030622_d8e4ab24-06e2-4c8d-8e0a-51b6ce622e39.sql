-- Create table to queue block tasks for Python runner to execute via Telegram API
CREATE TABLE IF NOT EXISTS public.block_contact_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  target_phone TEXT NOT NULL,
  target_username TEXT,
  target_telegram_id BIGINT,
  action TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'unblock')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Enable RLS
ALTER TABLE public.block_contact_tasks ENABLE ROW LEVEL SECURITY;

-- Allow all operations (internal tool)
CREATE POLICY "Allow all operations for block_contact_tasks"
ON public.block_contact_tasks
FOR ALL
USING (true)
WITH CHECK (true);