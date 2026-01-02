-- Create table for contact import/validation tasks
CREATE TABLE public.contact_import_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.telegram_accounts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.contact_tags(id) ON DELETE CASCADE,
  phone_numbers TEXT[] NOT NULL,
  valid_numbers TEXT[] DEFAULT '{}',
  invalid_numbers TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.contact_import_tasks ENABLE ROW LEVEL SECURITY;

-- Allow all operations
CREATE POLICY "Allow all operations for contact_import_tasks" 
ON public.contact_import_tasks 
FOR ALL 
USING (true) 
WITH CHECK (true);