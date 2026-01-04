-- Phase A2: Create trigger function for auto-updating conversation details
CREATE OR REPLACE FUNCTION public.update_conversation_details()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET 
    last_message_at = NOW(),
    last_message_content = NEW.content,
    last_message_direction = NEW.direction::text,
    updated_at = NOW(),
    has_reply = CASE 
      WHEN NEW.direction = 'incoming' THEN true 
      ELSE has_reply 
    END,
    unread_count = CASE 
      WHEN NEW.direction = 'incoming' AND NEW.read_at IS NULL THEN COALESCE(unread_count, 0) + 1
      ELSE unread_count
    END
  WHERE id = NEW.conversation_id;
  
  RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS update_conversation_on_new_message ON public.messages;
CREATE TRIGGER update_conversation_on_new_message
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.update_conversation_details();