-- Create function to sync messages_sent_today from actual message counts
CREATE OR REPLACE FUNCTION public.sync_messages_sent_today()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Update messages_sent_today based on actual outgoing messages created today
  UPDATE telegram_accounts a
  SET messages_sent_today = COALESCE(sub.count, 0)
  FROM (
    SELECT 
      account_id, 
      COUNT(*) as count
    FROM messages 
    WHERE direction = 'outgoing' 
      AND created_at >= CURRENT_DATE
    GROUP BY account_id
  ) sub
  WHERE a.id = sub.account_id;
  
  -- Reset accounts with no messages today to 0
  UPDATE telegram_accounts
  SET messages_sent_today = 0
  WHERE id NOT IN (
    SELECT DISTINCT account_id 
    FROM messages 
    WHERE direction = 'outgoing' 
      AND created_at >= CURRENT_DATE
  );
END;
$$;