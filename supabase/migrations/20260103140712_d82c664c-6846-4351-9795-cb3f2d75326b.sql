-- Add 'frozen' to the account_status enum
ALTER TYPE account_status ADD VALUE IF NOT EXISTS 'frozen';