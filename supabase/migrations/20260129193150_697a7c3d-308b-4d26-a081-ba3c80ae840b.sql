-- Create function to increment unread count atomically
CREATE OR REPLACE FUNCTION public.increment_unread_count(conv_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations 
  SET unread_count = COALESCE(unread_count, 0) + 1
  WHERE id = conv_id;
END;
$$;