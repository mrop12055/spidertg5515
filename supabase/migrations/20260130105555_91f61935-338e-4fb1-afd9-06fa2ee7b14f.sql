-- Create RPC function to increment account's daily message counter
CREATE OR REPLACE FUNCTION public.increment_messages_sent_today(acc_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE telegram_accounts 
  SET messages_sent_today = COALESCE(messages_sent_today, 0) + 1,
      last_active = now()
  WHERE id = acc_id;
END;
$$;