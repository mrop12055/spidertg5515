-- Create user roles enum and table for proper RBAC
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

-- Create user_roles table
CREATE TABLE public.user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    role app_role NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (user_id, role)
);

-- Enable RLS on user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Create security definer function to check roles (prevents RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Create function to check if user is authenticated
CREATE OR REPLACE FUNCTION public.is_authenticated()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
$$;

-- Create function to check if user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'admin')
$$;

-- RLS policy for user_roles - only admins can manage roles, users can read their own
CREATE POLICY "Users can view their own roles"
ON public.user_roles FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all roles"
ON public.user_roles FOR ALL
USING (public.is_admin());

-- Drop existing permissive policies and create secure ones for all tables

-- account_check_tasks
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.account_check_tasks;
CREATE POLICY "Authenticated users can manage account_check_tasks"
ON public.account_check_tasks FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- app_settings
DROP POLICY IF EXISTS "Allow all operations for app_settings" ON public.app_settings;
CREATE POLICY "Authenticated users can read app_settings"
ON public.app_settings FOR SELECT
USING (public.is_authenticated());
CREATE POLICY "Admins can manage app_settings"
ON public.app_settings FOR ALL
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- block_contact_tasks
DROP POLICY IF EXISTS "Allow all operations for block_contact_tasks" ON public.block_contact_tasks;
CREATE POLICY "Authenticated users can manage block_contact_tasks"
ON public.block_contact_tasks FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- blocked_contacts
DROP POLICY IF EXISTS "Allow all operations for blocked_contacts" ON public.blocked_contacts;
CREATE POLICY "Authenticated users can manage blocked_contacts"
ON public.blocked_contacts FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- campaign_accounts
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.campaign_accounts;
CREATE POLICY "Authenticated users can manage campaign_accounts"
ON public.campaign_accounts FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- campaign_recipients
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.campaign_recipients;
CREATE POLICY "Authenticated users can manage campaign_recipients"
ON public.campaign_recipients FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- campaigns
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.campaigns;
CREATE POLICY "Authenticated users can manage campaigns"
ON public.campaigns FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- contact_import_tasks
DROP POLICY IF EXISTS "Allow all operations for contact_import_tasks" ON public.contact_import_tasks;
CREATE POLICY "Authenticated users can manage contact_import_tasks"
ON public.contact_import_tasks FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- contact_tags
DROP POLICY IF EXISTS "Allow all operations for contact_tags" ON public.contact_tags;
CREATE POLICY "Authenticated users can manage contact_tags"
ON public.contact_tags FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- contacts_data
DROP POLICY IF EXISTS "Allow all operations for contacts_data" ON public.contacts_data;
CREATE POLICY "Authenticated users can manage contacts_data"
ON public.contacts_data FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- conversations
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.conversations;
CREATE POLICY "Authenticated users can manage conversations"
ON public.conversations FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- interaction_scheduler
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.interaction_scheduler;
CREATE POLICY "Authenticated users can manage interaction_scheduler"
ON public.interaction_scheduler FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- maturation_tasks
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.maturation_tasks;
CREATE POLICY "Authenticated users can manage maturation_tasks"
ON public.maturation_tasks FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- messages
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.messages;
CREATE POLICY "Authenticated users can manage messages"
ON public.messages FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- proxies
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.proxies;
CREATE POLICY "Authenticated users can manage proxies"
ON public.proxies FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- runner_heartbeats
DROP POLICY IF EXISTS "Allow all operations for runner_heartbeats" ON public.runner_heartbeats;
CREATE POLICY "Authenticated users can manage runner_heartbeats"
ON public.runner_heartbeats FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- scheduled_interactions
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.scheduled_interactions;
CREATE POLICY "Authenticated users can manage scheduled_interactions"
ON public.scheduled_interactions FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- seats
DROP POLICY IF EXISTS "Allow all operations for seats" ON public.seats;
CREATE POLICY "Authenticated users can manage seats"
ON public.seats FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- telegram_accounts
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.telegram_accounts;
CREATE POLICY "Authenticated users can manage telegram_accounts"
ON public.telegram_accounts FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- telegram_api_credentials
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.telegram_api_credentials;
CREATE POLICY "Authenticated users can manage telegram_api_credentials"
ON public.telegram_api_credentials FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- vps_connections
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.vps_connections;
CREATE POLICY "Authenticated users can manage vps_connections"
ON public.vps_connections FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- warmup_message_templates
DROP POLICY IF EXISTS "Allow all operations for warmup_message_templates" ON public.warmup_message_templates;
CREATE POLICY "Authenticated users can manage warmup_message_templates"
ON public.warmup_message_templates FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- warmup_messages
DROP POLICY IF EXISTS "Allow all operations for warmup_messages" ON public.warmup_messages;
CREATE POLICY "Authenticated users can manage warmup_messages"
ON public.warmup_messages FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- warmup_pairs
DROP POLICY IF EXISTS "Allow all operations for warmup_pairs" ON public.warmup_pairs;
CREATE POLICY "Authenticated users can manage warmup_pairs"
ON public.warmup_pairs FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- warmup_schedule
DROP POLICY IF EXISTS "Allow all operations for authenticated" ON public.warmup_schedule;
CREATE POLICY "Authenticated users can manage warmup_schedule"
ON public.warmup_schedule FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- warmup_sessions
DROP POLICY IF EXISTS "Allow all operations for warmup_sessions" ON public.warmup_sessions;
CREATE POLICY "Authenticated users can manage warmup_sessions"
ON public.warmup_sessions FOR ALL
USING (public.is_authenticated())
WITH CHECK (public.is_authenticated());

-- Create trigger to auto-assign admin role to first user
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_count INTEGER;
BEGIN
  -- Count existing users
  SELECT COUNT(*) INTO user_count FROM public.user_roles;
  
  -- First user becomes admin, others get user role
  IF user_count = 0 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger for new user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();