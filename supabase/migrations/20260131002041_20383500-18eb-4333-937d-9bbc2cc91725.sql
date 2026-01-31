-- Drop redundant triggers that don't update last_message_direction
DROP TRIGGER IF EXISTS on_message_insert ON public.messages;
DROP TRIGGER IF EXISTS trg_update_conversation_on_message ON public.messages;
DROP TRIGGER IF EXISTS trigger_update_conversation_on_message ON public.messages;

-- Drop the function that doesn't update direction (no longer needed)
DROP FUNCTION IF EXISTS public.update_conversation_on_message();

-- Verify: Only update_conversation_on_new_message trigger should remain
-- which calls update_conversation_details() and correctly updates last_message_direction