
ALTER TABLE public.telegram_accounts 
  ADD COLUMN IF NOT EXISTS locked_by TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Index for quick lookup of locked accounts
CREATE INDEX IF NOT EXISTS idx_telegram_accounts_locked_by ON public.telegram_accounts(locked_by) WHERE locked_by IS NOT NULL;
