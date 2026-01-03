-- Fix existing accounts that have ban_reason but are still 'active'
-- Set accounts with "deleted" or "deactivated" in ban_reason to 'banned'
UPDATE telegram_accounts 
SET status = 'banned'
WHERE status = 'active' 
  AND ban_reason IS NOT NULL 
  AND (
    ban_reason ILIKE '%deleted%' 
    OR ban_reason ILIKE '%deactivated%'
    OR ban_reason ILIKE '%user_deactivated%'
  );

-- Set accounts with "requests", "flood", or "spam" in ban_reason to 'frozen'
UPDATE telegram_accounts 
SET status = 'frozen'
WHERE status = 'active' 
  AND ban_reason IS NOT NULL 
  AND (
    ban_reason ILIKE '%requests%' 
    OR ban_reason ILIKE '%flood%'
    OR ban_reason ILIKE '%spam%'
    OR ban_reason ILIKE '%too many%'
  );