-- Drop and recreate system_health view with SECURITY INVOKER
DROP VIEW IF EXISTS public.system_health;

CREATE VIEW public.system_health 
WITH (security_invoker = true)
AS
SELECT 
  (SELECT COUNT(*) FROM messages WHERE status = 'sending') as stuck_messages,
  (SELECT COUNT(*) FROM messages WHERE status = 'pending') as pending_messages,
  (SELECT COUNT(*) FROM account_check_tasks WHERE status = 'pending') as pending_account_tasks,
  (SELECT COUNT(*) FROM block_contact_tasks WHERE status = 'pending') as pending_block_tasks,
  (SELECT COUNT(*) FROM contact_import_tasks WHERE status = 'pending') as pending_import_tasks,
  (SELECT COUNT(*) FROM campaign_recipients WHERE status = 'pending') as pending_recipients,
  (SELECT COUNT(*) FROM telegram_accounts WHERE status = 'active') as active_accounts,
  (SELECT COUNT(*) FROM proxies WHERE status = 'active') as active_proxies,
  (SELECT COUNT(*) FROM conversations) as total_conversations,
  now() as checked_at;