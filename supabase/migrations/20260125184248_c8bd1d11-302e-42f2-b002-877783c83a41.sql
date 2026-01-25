-- Add usage tracking columns for round-robin API rotation
ALTER TABLE telegram_api_credentials 
ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS daily_usage INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS daily_usage_reset_at DATE DEFAULT CURRENT_DATE;