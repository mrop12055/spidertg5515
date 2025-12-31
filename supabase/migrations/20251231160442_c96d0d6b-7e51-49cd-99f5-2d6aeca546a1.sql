-- Add foreign key relationship from account_check_tasks to telegram_accounts
ALTER TABLE public.account_check_tasks
ADD CONSTRAINT account_check_tasks_account_id_fkey
FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;