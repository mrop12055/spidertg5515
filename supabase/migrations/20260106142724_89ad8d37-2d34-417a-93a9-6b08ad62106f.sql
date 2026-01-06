-- Drop existing restrictive RLS policies on vps_commands
DROP POLICY IF EXISTS "Authenticated users can delete vps_commands" ON public.vps_commands;
DROP POLICY IF EXISTS "Authenticated users can insert vps_commands" ON public.vps_commands;
DROP POLICY IF EXISTS "Authenticated users can read vps_commands" ON public.vps_commands;
DROP POLICY IF EXISTS "Authenticated users can update vps_commands" ON public.vps_commands;

-- Create public access policy matching other admin tables
CREATE POLICY "Public access for admin tool"
ON public.vps_commands
FOR ALL
USING (true)
WITH CHECK (true);