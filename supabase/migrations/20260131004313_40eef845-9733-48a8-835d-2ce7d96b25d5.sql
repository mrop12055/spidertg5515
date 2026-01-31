-- Enable realtime broadcasting for messages and conversations tables
-- This is idempotent - will only add if not already present

DO $$
BEGIN
  -- Add messages table to realtime publication if not already added
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.messages';
    RAISE NOTICE 'Added public.messages to supabase_realtime publication';
  ELSE
    RAISE NOTICE 'public.messages already in supabase_realtime publication';
  END IF;

  -- Add conversations table to realtime publication if not already added
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'conversations'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations';
    RAISE NOTICE 'Added public.conversations to supabase_realtime publication';
  ELSE
    RAISE NOTICE 'public.conversations already in supabase_realtime publication';
  END IF;
END $$;