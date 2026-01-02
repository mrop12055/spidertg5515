-- Add fields to track remaining numbers and failed accounts for retry logic
ALTER TABLE public.contact_import_tasks
ADD COLUMN IF NOT EXISTS remaining_numbers text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS failed_account_ids uuid[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS current_account_id uuid REFERENCES public.telegram_accounts(id);