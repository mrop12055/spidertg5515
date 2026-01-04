-- Reset campaign recipients that got stuck in 'sending' when no corresponding message row exists
-- This can happen if a runner crashed mid-send.
UPDATE public.campaign_recipients r
SET status = 'pending'
WHERE r.status = 'sending'
  AND NOT EXISTS (
    SELECT 1
    FROM public.messages m
    WHERE m.campaign_recipient_id = r.id
  );