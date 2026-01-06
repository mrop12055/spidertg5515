-- Drop existing restrictive upload policy for python-scripts
DROP POLICY IF EXISTS "Authenticated users can manage python-scripts" ON storage.objects;

-- Create public upload policy for python-scripts bucket
CREATE POLICY "Public can manage python-scripts"
ON storage.objects
FOR ALL
USING (bucket_id = 'python-scripts')
WITH CHECK (bucket_id = 'python-scripts');