-- Batch increment success counts (reduces N RPC calls to 1)
-- Used by report-batch-results for efficient success tracking
CREATE OR REPLACE FUNCTION public.batch_increment_success(updates jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE telegram_accounts a
  SET 
    success_count = COALESCE(a.success_count, 0) + (u->>'delta')::int,
    success_rate = ROUND(
      (COALESCE(a.success_count, 0) + (u->>'delta')::int)::numeric / 
      NULLIF(COALESCE(a.success_count, 0) + (u->>'delta')::int + COALESCE(a.failure_count, 0), 0) * 100, 1
    )
  FROM jsonb_array_elements(updates) AS u
  WHERE a.id = (u->>'id')::uuid;
END;
$$;

-- Atomic increment for API rotation (prevents race conditions)
-- Used by api-helper for thread-safe usage tracking
CREATE OR REPLACE FUNCTION public.increment_api_usage(p_api_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE telegram_api_credentials
  SET 
    usage_count = COALESCE(usage_count, 0) + 1,
    daily_usage = COALESCE(daily_usage, 0) + 1,
    last_used_at = now()
  WHERE id = p_api_id;
END;
$$;