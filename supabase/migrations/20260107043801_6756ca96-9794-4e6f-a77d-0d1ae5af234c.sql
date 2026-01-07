-- Create proxy_errors table to track proxy failures
CREATE TABLE public.proxy_errors (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  proxy_id UUID NOT NULL REFERENCES public.proxies(id) ON DELETE CASCADE,
  error_message TEXT,
  error_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.proxy_errors ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users
CREATE POLICY "Allow all operations for authenticated users"
ON public.proxy_errors FOR ALL
USING (true)
WITH CHECK (true);

-- Create index for efficient today's errors query
CREATE INDEX idx_proxy_errors_proxy_created ON public.proxy_errors(proxy_id, created_at DESC);