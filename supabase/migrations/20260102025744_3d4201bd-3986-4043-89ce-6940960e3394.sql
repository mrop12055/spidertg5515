-- Ensure conversation unread counts stay accurate

-- Recreate trigger function (idempotent)
CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.conversations
  SET 
    updated_at = NOW(),
    last_message_at = NOW(),
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

-- Create trigger on messages table if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trg_update_conversation_on_message'
  ) THEN
    CREATE TRIGGER trg_update_conversation_on_message
    AFTER INSERT OR UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.update_conversation_on_message();
  END IF;
END;
$$;

-- One-time repair: sync unread_count with actual unread messages
UPDATE public.conversations c
SET unread_count = (
  SELECT COUNT(*) FROM public.messages m
  WHERE m.conversation_id = c.id
    AND m.direction = 'incoming'
    AND m.read_at IS NULL
);
