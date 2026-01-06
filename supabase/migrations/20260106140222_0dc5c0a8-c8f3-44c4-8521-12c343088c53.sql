-- Create storage bucket for Python scripts (for auto-sync)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('python-scripts', 'python-scripts', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access for Python scripts bucket
CREATE POLICY "Public can read python-scripts" 
ON storage.objects 
FOR SELECT 
USING (bucket_id = 'python-scripts');

-- Allow authenticated users to upload/manage scripts
CREATE POLICY "Authenticated users can manage python-scripts" 
ON storage.objects 
FOR ALL 
USING (bucket_id = 'python-scripts' AND auth.uid() IS NOT NULL)
WITH CHECK (bucket_id = 'python-scripts' AND auth.uid() IS NOT NULL);