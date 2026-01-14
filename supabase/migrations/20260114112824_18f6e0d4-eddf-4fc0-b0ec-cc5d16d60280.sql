-- Add last_category_used column to warmup_pairs for better script rotation
ALTER TABLE public.warmup_pairs 
ADD COLUMN IF NOT EXISTS last_category_used text;

-- Add used_categories array to track history of used categories (for longer rotation)
ALTER TABLE public.warmup_pairs 
ADD COLUMN IF NOT EXISTS used_categories text[] DEFAULT '{}';

-- Create index for faster category lookups
CREATE INDEX IF NOT EXISTS idx_warmup_templates_category ON public.warmup_message_templates(category);