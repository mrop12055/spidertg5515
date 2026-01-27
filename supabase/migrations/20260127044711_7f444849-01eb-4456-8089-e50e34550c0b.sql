-- Drop duplicate triggers on messages table to fix unread count sync issues
-- Keep only trg_update_conversation_on_message which uses accurate COUNT() query

-- Drop the redundant triggers that cause conflicting unread_count updates
DROP TRIGGER IF EXISTS on_message_insert ON public.messages;
DROP TRIGGER IF EXISTS trigger_update_conversation_on_message ON public.messages;  
DROP TRIGGER IF EXISTS update_conversation_on_new_message ON public.messages;

-- Note: We are KEEPING trg_update_conversation_on_message (INSERT OR UPDATE)
-- which uses update_conversation_on_message() with accurate COUNT(*) query