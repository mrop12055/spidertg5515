-- Drop existing restrictive policies and create public access policies
-- This is safe because the app has its own access code protection at the UI level

-- telegram_accounts
DROP POLICY IF EXISTS "Authenticated users can manage telegram_accounts" ON public.telegram_accounts;
CREATE POLICY "Public access for admin tool" ON public.telegram_accounts FOR ALL USING (true) WITH CHECK (true);

-- proxies
DROP POLICY IF EXISTS "Authenticated users can manage proxies" ON public.proxies;
CREATE POLICY "Public access for admin tool" ON public.proxies FOR ALL USING (true) WITH CHECK (true);

-- campaigns
DROP POLICY IF EXISTS "Authenticated users can manage campaigns" ON public.campaigns;
CREATE POLICY "Public access for admin tool" ON public.campaigns FOR ALL USING (true) WITH CHECK (true);

-- campaign_accounts
DROP POLICY IF EXISTS "Authenticated users can manage campaign_accounts" ON public.campaign_accounts;
CREATE POLICY "Public access for admin tool" ON public.campaign_accounts FOR ALL USING (true) WITH CHECK (true);

-- campaign_recipients
DROP POLICY IF EXISTS "Authenticated users can manage campaign_recipients" ON public.campaign_recipients;
CREATE POLICY "Public access for admin tool" ON public.campaign_recipients FOR ALL USING (true) WITH CHECK (true);

-- conversations
DROP POLICY IF EXISTS "Authenticated users can manage conversations" ON public.conversations;
CREATE POLICY "Public access for admin tool" ON public.conversations FOR ALL USING (true) WITH CHECK (true);

-- messages
DROP POLICY IF EXISTS "Authenticated users can manage messages" ON public.messages;
CREATE POLICY "Public access for admin tool" ON public.messages FOR ALL USING (true) WITH CHECK (true);

-- seats
DROP POLICY IF EXISTS "Authenticated users can manage seats" ON public.seats;
CREATE POLICY "Public access for admin tool" ON public.seats FOR ALL USING (true) WITH CHECK (true);

-- contact_tags
DROP POLICY IF EXISTS "Authenticated users can manage contact_tags" ON public.contact_tags;
CREATE POLICY "Public access for admin tool" ON public.contact_tags FOR ALL USING (true) WITH CHECK (true);

-- contacts_data
DROP POLICY IF EXISTS "Authenticated users can manage contacts_data" ON public.contacts_data;
CREATE POLICY "Public access for admin tool" ON public.contacts_data FOR ALL USING (true) WITH CHECK (true);

-- blocked_contacts
DROP POLICY IF EXISTS "Authenticated users can manage blocked_contacts" ON public.blocked_contacts;
CREATE POLICY "Public access for admin tool" ON public.blocked_contacts FOR ALL USING (true) WITH CHECK (true);

-- account_check_tasks
DROP POLICY IF EXISTS "Authenticated users can manage account_check_tasks" ON public.account_check_tasks;
CREATE POLICY "Public access for admin tool" ON public.account_check_tasks FOR ALL USING (true) WITH CHECK (true);

-- block_contact_tasks
DROP POLICY IF EXISTS "Authenticated users can manage block_contact_tasks" ON public.block_contact_tasks;
CREATE POLICY "Public access for admin tool" ON public.block_contact_tasks FOR ALL USING (true) WITH CHECK (true);

-- contact_import_tasks
DROP POLICY IF EXISTS "Authenticated users can manage contact_import_tasks" ON public.contact_import_tasks;
CREATE POLICY "Public access for admin tool" ON public.contact_import_tasks FOR ALL USING (true) WITH CHECK (true);

-- telegram_api_credentials
DROP POLICY IF EXISTS "Authenticated users can manage telegram_api_credentials" ON public.telegram_api_credentials;
CREATE POLICY "Public access for admin tool" ON public.telegram_api_credentials FOR ALL USING (true) WITH CHECK (true);

-- warmup_sessions
DROP POLICY IF EXISTS "Authenticated users can manage warmup_sessions" ON public.warmup_sessions;
CREATE POLICY "Public access for admin tool" ON public.warmup_sessions FOR ALL USING (true) WITH CHECK (true);

-- warmup_pairs
DROP POLICY IF EXISTS "Authenticated users can manage warmup_pairs" ON public.warmup_pairs;
CREATE POLICY "Public access for admin tool" ON public.warmup_pairs FOR ALL USING (true) WITH CHECK (true);

-- warmup_messages
DROP POLICY IF EXISTS "Authenticated users can manage warmup_messages" ON public.warmup_messages;
CREATE POLICY "Public access for admin tool" ON public.warmup_messages FOR ALL USING (true) WITH CHECK (true);

-- warmup_message_templates
DROP POLICY IF EXISTS "Authenticated users can manage warmup_message_templates" ON public.warmup_message_templates;
CREATE POLICY "Public access for admin tool" ON public.warmup_message_templates FOR ALL USING (true) WITH CHECK (true);

-- warmup_schedule
DROP POLICY IF EXISTS "Authenticated users can manage warmup_schedule" ON public.warmup_schedule;
CREATE POLICY "Public access for admin tool" ON public.warmup_schedule FOR ALL USING (true) WITH CHECK (true);

-- maturation_tasks
DROP POLICY IF EXISTS "Authenticated users can manage maturation_tasks" ON public.maturation_tasks;
CREATE POLICY "Public access for admin tool" ON public.maturation_tasks FOR ALL USING (true) WITH CHECK (true);

-- scheduled_interactions
DROP POLICY IF EXISTS "Authenticated users can manage scheduled_interactions" ON public.scheduled_interactions;
CREATE POLICY "Public access for admin tool" ON public.scheduled_interactions FOR ALL USING (true) WITH CHECK (true);

-- interaction_scheduler
DROP POLICY IF EXISTS "Authenticated users can manage interaction_scheduler" ON public.interaction_scheduler;
CREATE POLICY "Public access for admin tool" ON public.interaction_scheduler FOR ALL USING (true) WITH CHECK (true);

-- runner_heartbeats
DROP POLICY IF EXISTS "Authenticated users can manage runner_heartbeats" ON public.runner_heartbeats;
CREATE POLICY "Public access for admin tool" ON public.runner_heartbeats FOR ALL USING (true) WITH CHECK (true);

-- vps_connections
DROP POLICY IF EXISTS "Authenticated users can manage vps_connections" ON public.vps_connections;
CREATE POLICY "Public access for admin tool" ON public.vps_connections FOR ALL USING (true) WITH CHECK (true);

-- app_settings - make fully public for the admin tool
DROP POLICY IF EXISTS "Admins can manage app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated users can read app_settings" ON public.app_settings;
CREATE POLICY "Public access for admin tool" ON public.app_settings FOR ALL USING (true) WITH CHECK (true);