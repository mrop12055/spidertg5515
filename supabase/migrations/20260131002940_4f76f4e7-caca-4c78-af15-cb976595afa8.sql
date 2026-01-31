-- Step 1: Ensure no duplicate triggers exist
DROP TRIGGER IF EXISTS update_conversation_on_new_message ON public.messages;
DROP TRIGGER IF EXISTS on_message_insert ON public.messages;
DROP TRIGGER IF EXISTS trg_update_conversation_on_message ON public.messages;
DROP TRIGGER IF EXISTS trigger_update_conversation_on_message ON public.messages;

-- Step 2: Create the single correct trigger
CREATE TRIGGER update_conversation_on_new_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_details();

-- Step 3: Backfill all conversation summaries from the latest message per conversation
UPDATE public.conversations c
SET 
  last_message_at = latest.created_at,
  last_message_content = latest.content,
  last_message_direction = latest.direction::text,
  has_reply = COALESCE(has_incoming.has_incoming, false),
  updated_at = NOW()
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    created_at,
    content,
    direction
  FROM public.messages
  ORDER BY conversation_id, created_at DESC
) latest
LEFT JOIN (
  SELECT conversation_id, true AS has_incoming
  FROM public.messages
  WHERE direction = 'incoming'
  GROUP BY conversation_id
) has_incoming ON has_incoming.conversation_id = latest.conversation_id
WHERE c.id = latest.conversation_id
  AND (
    c.last_message_at IS NULL
    OR c.last_message_at < latest.created_at
    OR c.last_message_content IS DISTINCT FROM latest.content
    OR c.last_message_direction IS DISTINCT FROM latest.direction::text
  );