-- Fix vps_logs RLS so the (non-Supabase-authenticated) admin UI + VPS agent can write/read logs

-- Ensure RLS is enabled (it already is, but keep idempotent)
ALTER TABLE public.vps_logs ENABLE ROW LEVEL SECURITY;

-- Remove Supabase-auth based policies that block anon/service integrations
DROP POLICY IF EXISTS "Authenticated users can read vps_logs" ON public.vps_logs;
DROP POLICY IF EXISTS "Authenticated users can insert vps_logs" ON public.vps_logs;
DROP POLICY IF EXISTS "Authenticated users can delete vps_logs" ON public.vps_logs;

-- Ensure a permissive policy exists (matches vps_connections / vps_commands pattern)
DROP POLICY IF EXISTS "Public access for admin tool" ON public.vps_logs;
CREATE POLICY "Public access for admin tool"
ON public.vps_logs
AS PERMISSIVE
FOR ALL
TO public
USING (true)
WITH CHECK (true);
