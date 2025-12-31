-- Add media_url column to messages table
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_url text;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_type text;

-- Create storage bucket for message attachments
INSERT INTO storage.buckets (id, name, public) 
VALUES ('message-attachments', 'message-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone to read from the bucket (public)
CREATE POLICY "Public read access for message attachments"
ON storage.objects FOR SELECT
USING (bucket_id = 'message-attachments');

-- Allow authenticated users to upload
CREATE POLICY "Allow upload to message attachments"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'message-attachments');

-- Allow users to delete their own uploads
CREATE POLICY "Allow delete from message attachments"
ON storage.objects FOR DELETE
USING (bucket_id = 'message-attachments');