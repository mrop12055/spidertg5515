-- Create storage bucket for Python scripts
INSERT INTO storage.buckets (id, name, public)
VALUES ('python-scripts', 'python-scripts', true)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone to download scripts (public bucket)
CREATE POLICY "Allow public downloads of python scripts"
ON storage.objects FOR SELECT
USING (bucket_id = 'python-scripts');

-- Allow authenticated users to upload/update scripts
CREATE POLICY "Allow authenticated uploads to python scripts"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'python-scripts');

CREATE POLICY "Allow authenticated updates to python scripts"
ON storage.objects FOR UPDATE
USING (bucket_id = 'python-scripts');

CREATE POLICY "Allow authenticated deletes from python scripts"
ON storage.objects FOR DELETE
USING (bucket_id = 'python-scripts');