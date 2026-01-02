-- Drop and recreate the trigger function to calculate unread count correctly
CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER AS $$
BEGIN
  -- Update conversation timestamps
  UPDATE public.conversations
  SET 
    updated_at = NOW(),
    last_message_at = NOW(),
    -- Recalculate unread count from actual unread messages (more accurate than increment)
    unread_count = CASE 
      WHEN NEW.direction = 'incoming' THEN (
        SELECT COUNT(*) FROM public.messages 
        WHERE conversation_id = NEW.conversation_id 
        AND direction = 'incoming' 
        AND read_at IS NULL
      )
      ELSE unread_count 
    END
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;