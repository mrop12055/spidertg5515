-- Add cooldown_until column to telegram_accounts for tracking account cooldown periods
ALTER TABLE telegram_accounts 
ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;