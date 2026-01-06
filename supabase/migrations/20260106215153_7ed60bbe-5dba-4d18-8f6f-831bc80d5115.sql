DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'telegram_accounts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.telegram_accounts;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'account_check_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.account_check_tasks;
  END IF;
END
$$;