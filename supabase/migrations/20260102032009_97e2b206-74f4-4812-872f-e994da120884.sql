-- Create contact_tags table
CREATE TABLE public.contact_tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;

-- Allow all operations (matching existing pattern)
CREATE POLICY "Allow all operations for contact_tags" 
ON public.contact_tags 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Add tag_id to contacts_data
ALTER TABLE public.contacts_data 
ADD COLUMN tag_id UUID REFERENCES public.contact_tags(id) ON DELETE SET NULL;