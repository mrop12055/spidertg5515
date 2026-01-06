-- Drop existing policies
DROP POLICY IF EXISTS "Allow authenticated users to manage vps_commands" ON public.vps_commands;
DROP POLICY IF EXISTS "Allow authenticated users to view vps_logs" ON public.vps_logs;

-- Create proper policies for vps_commands
CREATE POLICY "Authenticated users can read vps_commands"
ON public.vps_commands
FOR SELECT
USING (is_authenticated());

CREATE POLICY "Authenticated users can insert vps_commands"
ON public.vps_commands
FOR INSERT
WITH CHECK (is_authenticated());

CREATE POLICY "Authenticated users can update vps_commands"
ON public.vps_commands
FOR UPDATE
USING (is_authenticated());

CREATE POLICY "Authenticated users can delete vps_commands"
ON public.vps_commands
FOR DELETE
USING (is_authenticated());

-- Create proper policies for vps_logs
CREATE POLICY "Authenticated users can read vps_logs"
ON public.vps_logs
FOR SELECT
USING (is_authenticated());

CREATE POLICY "Authenticated users can insert vps_logs"
ON public.vps_logs
FOR INSERT
WITH CHECK (is_authenticated());

CREATE POLICY "Authenticated users can delete vps_logs"
ON public.vps_logs
FOR DELETE
USING (is_authenticated());