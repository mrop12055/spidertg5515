CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pg_graphql";
CREATE EXTENSION IF NOT EXISTS "pg_net";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "plpgsql";
CREATE EXTENSION IF NOT EXISTS "supabase_vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";
BEGIN;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: account_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_status AS ENUM (
    'active',
    'banned',
    'restricted',
    'disconnected',
    'cooldown',
    'frozen'
);


--
-- Name: app_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_role AS ENUM (
    'admin',
    'user'
);


--
-- Name: campaign_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.campaign_status AS ENUM (
    'draft',
    'scheduled',
    'running',
    'paused',
    'completed',
    'failed'
);


--
-- Name: message_direction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.message_direction AS ENUM (
    'incoming',
    'outgoing'
);


--
-- Name: message_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.message_status AS ENUM (
    'pending',
    'sending',
    'sent',
    'delivered',
    'read',
    'failed',
    'cancelled'
);


--
-- Name: proxy_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.proxy_status AS ENUM (
    'active',
    'inactive',
    'error'
);


--
-- Name: proxy_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.proxy_type AS ENUM (
    'http',
    'https',
    'socks4',
    'socks5'
);


--
-- Name: auto_detect_frozen_accounts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_detect_frozen_accounts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- If ban_reason contains "frozen account" error, set status to frozen
  IF NEW.ban_reason IS NOT NULL AND (
    NEW.ban_reason ILIKE '%frozen account%' OR
    NEW.ban_reason ILIKE '%not available for frozen%'
  ) THEN
    NEW.status := 'frozen';
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: auto_pair_warmup_accounts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_pair_warmup_accounts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  unpaired_account RECORD;
BEGIN
  -- Only run when account becomes active with a valid session
  IF NEW.status = 'active' AND NEW.session_data IS NOT NULL THEN
    -- Check if there's an unpaired account waiting
    SELECT * INTO unpaired_account
    FROM public.telegram_accounts
    WHERE warmup_unpaired = true
      AND status = 'active'
      AND session_data IS NOT NULL
      AND id != NEW.id
    ORDER BY created_at ASC
    LIMIT 1;
    
    -- If found, pair them together
    IF unpaired_account.id IS NOT NULL THEN
      -- Update the previously unpaired account
      UPDATE public.telegram_accounts
      SET warmup_unpaired = false,
          warmup_pair_id = NEW.id
      WHERE id = unpaired_account.id;
      
      -- Update the new account
      NEW.warmup_unpaired := false;
      NEW.warmup_pair_id := unpaired_account.id;
      
      RAISE LOG 'Auto-paired accounts: % with %', unpaired_account.phone_number, NEW.phone_number;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: cancel_messages_on_recipient_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_messages_on_recipient_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE messages 
  SET status = 'cancelled', failed_reason = 'Campaign deleted' 
  WHERE campaign_recipient_id = OLD.id AND status = 'pending';
  RETURN OLD;
END;
$$;


--
-- Name: cleanup_pending_recipients_on_campaign_stop(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_pending_recipients_on_campaign_stop() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Only trigger when status changes TO completed (not failed or paused)
  -- This preserves recipients for retry when campaign fails or is paused
  IF NEW.status = 'completed' AND OLD.status = 'running' THEN
    -- Delete pending recipients for this campaign (they shouldn't exist if completed properly)
    DELETE FROM public.campaign_recipients 
    WHERE campaign_id = NEW.id AND status = 'pending';
    
    -- Also cancel any pending messages linked to this campaign's recipients
    UPDATE public.messages 
    SET status = 'cancelled', failed_reason = 'Campaign completed'
    WHERE campaign_recipient_id IN (
      SELECT id FROM public.campaign_recipients WHERE campaign_id = NEW.id
    ) AND status = 'pending';
    
    RAISE LOG 'Cleaned up pending recipients for completed campaign %', NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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


--
-- Name: has_role(uuid, public.app_role); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;


--
-- Name: increment_account_failure(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_account_failure(acc_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE telegram_accounts 
  SET failure_count = COALESCE(failure_count, 0) + 1,
      success_rate = ROUND(
        COALESCE(success_count, 0)::numeric / 
        NULLIF(COALESCE(success_count, 0) + COALESCE(failure_count, 0) + 1, 0) * 100, 1
      )
  WHERE id = acc_id;
END;
$$;


--
-- Name: increment_account_success(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_account_success(acc_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE telegram_accounts 
  SET success_count = COALESCE(success_count, 0) + 1,
      success_rate = ROUND(
        (COALESCE(success_count, 0) + 1)::numeric / 
        NULLIF(COALESCE(success_count, 0) + 1 + COALESCE(failure_count, 0), 0) * 100, 1
      )
  WHERE id = acc_id;
END;
$$;


--
-- Name: increment_campaign_failed_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_campaign_failed_count(cid uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.campaigns 
  SET failed_count = COALESCE(failed_count, 0) + 1,
      updated_at = now()
  WHERE id = cid;
END;
$$;


--
-- Name: increment_campaign_sent_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_campaign_sent_count(cid uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.campaigns 
  SET sent_count = COALESCE(sent_count, 0) + 1,
      updated_at = now()
  WHERE id = cid;
END;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.has_role(auth.uid(), 'admin')
$$;


--
-- Name: is_authenticated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_authenticated() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT auth.uid() IS NOT NULL
$$;


--
-- Name: reset_daily_message_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_daily_message_counts() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.telegram_accounts SET messages_sent_today = 0;
END;
$$;


--
-- Name: update_account_check_tasks_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_account_check_tasks_updated_at() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_api_credential_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_api_credential_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.api_credential_id IS NOT NULL THEN
      UPDATE public.telegram_api_credentials 
      SET accounts_count = (SELECT COUNT(*) FROM public.telegram_accounts WHERE api_credential_id = NEW.api_credential_id)
      WHERE id = NEW.api_credential_id;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.api_credential_id IS NOT NULL AND OLD.api_credential_id != NEW.api_credential_id THEN
      UPDATE public.telegram_api_credentials 
      SET accounts_count = (SELECT COUNT(*) FROM public.telegram_accounts WHERE api_credential_id = OLD.api_credential_id)
      WHERE id = OLD.api_credential_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.api_credential_id IS NOT NULL THEN
      UPDATE public.telegram_api_credentials 
      SET accounts_count = (SELECT COUNT(*) FROM public.telegram_accounts WHERE api_credential_id = OLD.api_credential_id)
      WHERE id = OLD.api_credential_id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_conversation_details(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_conversation_details() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.conversations
  SET 
    last_message_at = NOW(),
    last_message_content = NEW.content,
    last_message_direction = NEW.direction::text,
    updated_at = NOW(),
    has_reply = CASE 
      WHEN NEW.direction = 'incoming' THEN true 
      ELSE has_reply 
    END,
    unread_count = CASE 
      WHEN NEW.direction = 'incoming' AND NEW.read_at IS NULL THEN COALESCE(unread_count, 0) + 1
      ELSE unread_count
    END
  WHERE id = NEW.conversation_id;
  
  RETURN NEW;
END;
$$;


--
-- Name: update_conversation_on_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_conversation_on_message() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.conversations
  SET 
    updated_at = NOW(),
    last_message_at = NOW(),
    unread_count = CASE 
      WHEN NEW.direction = 'incoming' THEN (
        SELECT COUNT(*) FROM public.messages 
        WHERE conversation_id = NEW.conversation_id 
          AND direction = 'incoming' 
          AND read_at IS NULL
      )
      ELSE unread_count
    END
  WHERE id = NEW.conversation_id;

  RETURN NEW;
END;
$$;


--
-- Name: update_material_tag_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_material_tag_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.material_tags SET item_count = item_count + 1 WHERE id = NEW.tag_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.material_tags SET item_count = item_count - 1 WHERE id = OLD.tag_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_table_access_method = heap;

--
-- Name: account_check_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_check_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    task_type text DEFAULT 'spambot_check'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    result text,
    created_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: block_contact_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_contact_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    target_phone text NOT NULL,
    target_username text,
    target_telegram_id bigint,
    action text DEFAULT 'block'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    result text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT block_contact_tasks_action_check CHECK ((action = ANY (ARRAY['block'::text, 'unblock'::text]))),
    CONSTRAINT block_contact_tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: blocked_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_number text NOT NULL,
    name text,
    blocked_by_account_id uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: campaign_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_accounts (
    campaign_id uuid NOT NULL,
    account_id uuid NOT NULL
);


--
-- Name: campaign_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    phone_number text NOT NULL,
    name text,
    status text DEFAULT 'pending'::text,
    sent_at timestamp with time zone,
    sent_by_account_id uuid,
    failed_reason text,
    retry_count integer DEFAULT 0,
    failed_account_ids uuid[] DEFAULT '{}'::uuid[],
    api_credential_id uuid,
    scheduled_at timestamp with time zone,
    seat_id uuid,
    failed_api_ids uuid[] DEFAULT '{}'::uuid[]
);


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    message_template text NOT NULL,
    status public.campaign_status DEFAULT 'draft'::public.campaign_status,
    scheduled_at timestamp with time zone,
    recipient_count integer DEFAULT 0,
    sent_count integer DEFAULT 0,
    failed_count integer DEFAULT 0,
    reply_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    seat_id uuid,
    batch_size integer DEFAULT 50
);


--
-- Name: contact_import_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_import_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    phone_numbers text[] NOT NULL,
    valid_numbers text[] DEFAULT '{}'::text[],
    invalid_numbers text[] DEFAULT '{}'::text[],
    status text DEFAULT 'pending'::text NOT NULL,
    result text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    remaining_numbers text[] DEFAULT '{}'::text[],
    failed_account_ids uuid[] DEFAULT '{}'::uuid[],
    current_account_id uuid
);


--
-- Name: contact_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contacts_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts_data (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_number text NOT NULL,
    name text,
    username text,
    notes text,
    is_used boolean DEFAULT false,
    used_in_campaign_id uuid,
    used_at timestamp with time zone,
    is_blocked boolean DEFAULT false,
    blocked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tag_id uuid
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    recipient_phone text,
    recipient_telegram_id bigint,
    recipient_name text,
    recipient_username text,
    recipient_avatar text,
    unread_count integer DEFAULT 0,
    is_active boolean DEFAULT false,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    blocked_by_recipient boolean DEFAULT false,
    first_message_sent boolean DEFAULT false,
    has_prior_contact boolean DEFAULT false,
    seat_id uuid,
    is_pinned boolean DEFAULT false,
    is_hidden boolean DEFAULT false,
    last_message_content text,
    last_message_direction text,
    has_reply boolean DEFAULT false,
    campaign_id uuid,
    campaign_name text
);


--
-- Name: interaction_scheduler; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interaction_scheduler (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sender_account_id uuid NOT NULL,
    receiver_account_id uuid NOT NULL,
    message_content text NOT NULL,
    scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: material_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_data (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tag_id uuid NOT NULL,
    phone_number text,
    username text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: material_names; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_names (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tag_id uuid NOT NULL,
    first_name text NOT NULL,
    last_name text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: material_pictures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_pictures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tag_id uuid NOT NULL,
    file_url text NOT NULL,
    file_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: material_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    item_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT material_tags_type_check CHECK ((type = ANY (ARRAY['data'::text, 'pictures'::text, 'names'::text])))
);


--
-- Name: maturation_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maturation_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    task_type text NOT NULL,
    status text DEFAULT 'pending'::text,
    scheduled_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    description text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    telegram_message_id bigint,
    content text NOT NULL,
    direction public.message_direction NOT NULL,
    status public.message_status DEFAULT 'pending'::public.message_status,
    created_at timestamp with time zone DEFAULT now(),
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    failed_reason text,
    media_url text,
    media_type text,
    campaign_recipient_id uuid,
    priority integer DEFAULT 0,
    api_credential_id uuid
);


--
-- Name: proxies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proxies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    username text,
    password text,
    proxy_type public.proxy_type DEFAULT 'http'::public.proxy_type,
    status public.proxy_status DEFAULT 'active'::public.proxy_status,
    assigned_account_id uuid,
    last_checked timestamp with time zone,
    response_time integer,
    country text,
    created_at timestamp with time zone DEFAULT now(),
    detected_country text
);


--
-- Name: proxy_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proxy_errors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proxy_id uuid NOT NULL,
    error_message text,
    error_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: runner_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runner_heartbeats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    runner_name text NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    status text DEFAULT 'online'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    server_id text DEFAULT 'legacy'::text
);


--
-- Name: scheduled_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sender_account_id uuid NOT NULL,
    receiver_account_id uuid NOT NULL,
    message_content text NOT NULL,
    status text DEFAULT 'pending'::text,
    scheduled_at timestamp with time zone DEFAULT now(),
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT scheduled_interactions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: seats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    access_token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true
);


--
-- Name: seat_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.seat_stats AS
 SELECT s.id AS seat_id,
    s.name AS seat_name,
    count(DISTINCT c.id) AS total_conversations,
    count(DISTINCT
        CASE
            WHEN (c.first_message_sent = true) THEN c.id
            ELSE NULL::uuid
        END) AS conversations_started,
    count(DISTINCT
        CASE
            WHEN ((m.direction = 'outgoing'::public.message_direction) AND (date(m.created_at) = CURRENT_DATE)) THEN c.id
            ELSE NULL::uuid
        END) AS messages_sent_today,
    count(DISTINCT
        CASE
            WHEN ((m.direction = 'outgoing'::public.message_direction) AND (m.status = 'read'::public.message_status) AND (date(m.created_at) = CURRENT_DATE)) THEN c.id
            ELSE NULL::uuid
        END) AS messages_read,
    count(DISTINCT
        CASE
            WHEN (m.direction = 'incoming'::public.message_direction) THEN c.id
            ELSE NULL::uuid
        END) AS responses_received,
    count(DISTINCT
        CASE
            WHEN ((m.direction = 'incoming'::public.message_direction) AND (date(m.created_at) = CURRENT_DATE)) THEN c.id
            ELSE NULL::uuid
        END) AS responses_today
   FROM ((public.seats s
     LEFT JOIN public.conversations c ON ((c.seat_id = s.id)))
     LEFT JOIN public.messages m ON ((m.conversation_id = c.id)))
  GROUP BY s.id, s.name;


--
-- Name: telegram_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_number text NOT NULL,
    username text,
    first_name text,
    last_name text,
    status public.account_status DEFAULT 'disconnected'::public.account_status,
    proxy_id uuid,
    session_data text,
    api_id text,
    api_hash text,
    created_at timestamp with time zone DEFAULT now(),
    last_active timestamp with time zone,
    messages_sent_today integer DEFAULT 0,
    daily_limit integer DEFAULT 25,
    maturity_score integer DEFAULT 0,
    maturity_days integer DEFAULT 0,
    restricted_until timestamp with time zone,
    ban_reason text,
    avatar_url text,
    telegram_id bigint,
    last_spambot_check timestamp with time zone,
    device_model text,
    system_version text,
    app_version text,
    lang_code text DEFAULT 'en'::text,
    system_lang_code text DEFAULT 'en-US'::text,
    api_credential_id uuid,
    warmup_phase integer DEFAULT 0,
    warmup_started_at timestamp with time zone,
    spambot_status text DEFAULT 'unknown'::text,
    phone_country text,
    geo_mismatch boolean DEFAULT false,
    interaction_pair_id uuid,
    tags text[] DEFAULT '{}'::text[],
    last_campaign_send_at timestamp with time zone,
    success_count integer DEFAULT 0,
    failure_count integer DEFAULT 0,
    success_rate numeric DEFAULT 100,
    auto_disabled boolean DEFAULT false,
    disabled_reason text,
    warmup_pair_id uuid,
    warmup_unpaired boolean DEFAULT false,
    CONSTRAINT telegram_accounts_spambot_status_check CHECK ((spambot_status = ANY (ARRAY['unknown'::text, 'clean'::text, 'limited'::text, 'restricted'::text]))),
    CONSTRAINT telegram_accounts_warmup_phase_check CHECK (((warmup_phase >= 0) AND (warmup_phase <= 4)))
);


--
-- Name: system_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.system_health WITH (security_invoker='true') AS
 SELECT ( SELECT count(*) AS count
           FROM public.messages
          WHERE (messages.status = 'sending'::public.message_status)) AS stuck_messages,
    ( SELECT count(*) AS count
           FROM public.messages
          WHERE (messages.status = 'pending'::public.message_status)) AS pending_messages,
    ( SELECT count(*) AS count
           FROM public.account_check_tasks
          WHERE (account_check_tasks.status = 'pending'::text)) AS pending_account_tasks,
    ( SELECT count(*) AS count
           FROM public.block_contact_tasks
          WHERE (block_contact_tasks.status = 'pending'::text)) AS pending_block_tasks,
    ( SELECT count(*) AS count
           FROM public.contact_import_tasks
          WHERE (contact_import_tasks.status = 'pending'::text)) AS pending_import_tasks,
    ( SELECT count(*) AS count
           FROM public.campaign_recipients
          WHERE (campaign_recipients.status = 'pending'::text)) AS pending_recipients,
    ( SELECT count(*) AS count
           FROM public.telegram_accounts
          WHERE (telegram_accounts.status = 'active'::public.account_status)) AS active_accounts,
    ( SELECT count(*) AS count
           FROM public.proxies
          WHERE (proxies.status = 'active'::public.proxy_status)) AS active_proxies,
    ( SELECT count(*) AS count
           FROM public.conversations) AS total_conversations,
    now() AS checked_at;


--
-- Name: telegram_api_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_api_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    api_id text NOT NULL,
    api_hash text NOT NULL,
    client_type text NOT NULL,
    accounts_count integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    last_validated_at timestamp with time zone,
    validation_error text,
    CONSTRAINT telegram_api_credentials_client_type_check CHECK ((client_type = ANY (ARRAY['android'::text, 'desktop'::text, 'ios'::text, 'macos'::text])))
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role public.app_role NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: vps_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vps_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vps_id uuid,
    command text NOT NULL,
    target_runner text,
    status text DEFAULT 'pending'::text NOT NULL,
    result text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);

ALTER TABLE ONLY public.vps_commands REPLICA IDENTITY FULL;


--
-- Name: vps_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vps_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    api_key text NOT NULL,
    last_seen timestamp with time zone,
    status text DEFAULT 'disconnected'::text,
    ip_address text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.vps_connections REPLICA IDENTITY FULL;


--
-- Name: vps_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vps_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vps_id uuid,
    runner_name text NOT NULL,
    log_level text DEFAULT 'info'::text,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.vps_logs REPLICA IDENTITY FULL;


--
-- Name: warmup_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_errors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    account_id uuid,
    pair_id uuid,
    error_message text NOT NULL,
    error_type text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: warmup_message_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_message_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_order integer NOT NULL,
    sender_position text NOT NULL,
    message_text text NOT NULL,
    is_question boolean DEFAULT false,
    category text DEFAULT 'casual'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: warmup_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pair_id uuid NOT NULL,
    sender_account_id uuid NOT NULL,
    receiver_account_id uuid NOT NULL,
    message_content text NOT NULL,
    message_type text DEFAULT 'text'::text,
    scheduled_at timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    status text DEFAULT 'pending'::text,
    reply_delay_seconds integer,
    created_at timestamp with time zone DEFAULT now(),
    error_message text,
    template_id uuid,
    claimed_at timestamp with time zone,
    claimed_by text,
    is_cycle_last boolean DEFAULT false
);


--
-- Name: warmup_pairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_a_id uuid NOT NULL,
    account_b_id uuid NOT NULL,
    session_id uuid NOT NULL,
    messages_exchanged integer DEFAULT 0,
    last_message_at timestamp with time zone,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    contacts_exchanged boolean DEFAULT false,
    cycles_completed_today integer DEFAULT 0,
    last_cycle_date date,
    last_template_id uuid,
    failed_reason text,
    last_category_used text,
    used_categories text[] DEFAULT '{}'::text[]
);


--
-- Name: warmup_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_schedule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    day_number integer NOT NULL,
    task_type text NOT NULL,
    task_description text,
    status text DEFAULT 'pending'::text,
    scheduled_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    channel_username text,
    priority integer DEFAULT 0,
    CONSTRAINT warmup_schedule_day_number_check CHECK (((day_number >= 1) AND (day_number <= 14))),
    CONSTRAINT warmup_schedule_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: warmup_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warmup_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'active'::text,
    total_pairs integer DEFAULT 0,
    messages_per_pair_min integer DEFAULT 5,
    messages_per_pair_max integer DEFAULT 10,
    started_at timestamp with time zone DEFAULT now(),
    stopped_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: account_check_tasks account_check_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_check_tasks
    ADD CONSTRAINT account_check_tasks_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_key_key UNIQUE (key);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);


--
-- Name: block_contact_tasks block_contact_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_contact_tasks
    ADD CONSTRAINT block_contact_tasks_pkey PRIMARY KEY (id);


--
-- Name: blocked_contacts blocked_contacts_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_contacts
    ADD CONSTRAINT blocked_contacts_phone_number_key UNIQUE (phone_number);


--
-- Name: blocked_contacts blocked_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_contacts
    ADD CONSTRAINT blocked_contacts_pkey PRIMARY KEY (id);


--
-- Name: campaign_accounts campaign_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_accounts
    ADD CONSTRAINT campaign_accounts_pkey PRIMARY KEY (campaign_id, account_id);


--
-- Name: campaign_recipients campaign_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: contact_import_tasks contact_import_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_import_tasks
    ADD CONSTRAINT contact_import_tasks_pkey PRIMARY KEY (id);


--
-- Name: contact_tags contact_tags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_tags
    ADD CONSTRAINT contact_tags_name_key UNIQUE (name);


--
-- Name: contact_tags contact_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_tags
    ADD CONSTRAINT contact_tags_pkey PRIMARY KEY (id);


--
-- Name: contacts_data contacts_data_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts_data
    ADD CONSTRAINT contacts_data_phone_number_key UNIQUE (phone_number);


--
-- Name: contacts_data contacts_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts_data
    ADD CONSTRAINT contacts_data_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: interaction_scheduler interaction_scheduler_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_scheduler
    ADD CONSTRAINT interaction_scheduler_pkey PRIMARY KEY (id);


--
-- Name: material_data material_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_data
    ADD CONSTRAINT material_data_pkey PRIMARY KEY (id);


--
-- Name: material_names material_names_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_names
    ADD CONSTRAINT material_names_pkey PRIMARY KEY (id);


--
-- Name: material_pictures material_pictures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_pictures
    ADD CONSTRAINT material_pictures_pkey PRIMARY KEY (id);


--
-- Name: material_tags material_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_tags
    ADD CONSTRAINT material_tags_pkey PRIMARY KEY (id);


--
-- Name: maturation_tasks maturation_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maturation_tasks
    ADD CONSTRAINT maturation_tasks_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: proxies proxies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxies
    ADD CONSTRAINT proxies_pkey PRIMARY KEY (id);


--
-- Name: proxy_errors proxy_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxy_errors
    ADD CONSTRAINT proxy_errors_pkey PRIMARY KEY (id);


--
-- Name: runner_heartbeats runner_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_heartbeats
    ADD CONSTRAINT runner_heartbeats_pkey PRIMARY KEY (id);


--
-- Name: runner_heartbeats runner_heartbeats_runner_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runner_heartbeats
    ADD CONSTRAINT runner_heartbeats_runner_name_key UNIQUE (runner_name);


--
-- Name: scheduled_interactions scheduled_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_interactions
    ADD CONSTRAINT scheduled_interactions_pkey PRIMARY KEY (id);


--
-- Name: seats seats_access_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seats
    ADD CONSTRAINT seats_access_token_key UNIQUE (access_token);


--
-- Name: seats seats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seats
    ADD CONSTRAINT seats_pkey PRIMARY KEY (id);


--
-- Name: telegram_accounts telegram_accounts_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_accounts
    ADD CONSTRAINT telegram_accounts_phone_number_key UNIQUE (phone_number);


--
-- Name: telegram_accounts telegram_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_accounts
    ADD CONSTRAINT telegram_accounts_pkey PRIMARY KEY (id);


--
-- Name: telegram_api_credentials telegram_api_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_api_credentials
    ADD CONSTRAINT telegram_api_credentials_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_user_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);


--
-- Name: vps_commands vps_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vps_commands
    ADD CONSTRAINT vps_commands_pkey PRIMARY KEY (id);


--
-- Name: vps_connections vps_connections_api_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vps_connections
    ADD CONSTRAINT vps_connections_api_key_key UNIQUE (api_key);


--
-- Name: vps_connections vps_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vps_connections
    ADD CONSTRAINT vps_connections_pkey PRIMARY KEY (id);


--
-- Name: vps_logs vps_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vps_logs
    ADD CONSTRAINT vps_logs_pkey PRIMARY KEY (id);


--
-- Name: warmup_errors warmup_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_errors
    ADD CONSTRAINT warmup_errors_pkey PRIMARY KEY (id);


--
-- Name: warmup_message_templates warmup_message_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_message_templates
    ADD CONSTRAINT warmup_message_templates_pkey PRIMARY KEY (id);


--
-- Name: warmup_messages warmup_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_messages
    ADD CONSTRAINT warmup_messages_pkey PRIMARY KEY (id);


--
-- Name: warmup_pairs warmup_pairs_account_a_id_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_pairs
    ADD CONSTRAINT warmup_pairs_account_a_id_session_id_key UNIQUE (account_a_id, session_id);


--
-- Name: warmup_pairs warmup_pairs_account_b_id_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_pairs
    ADD CONSTRAINT warmup_pairs_account_b_id_session_id_key UNIQUE (account_b_id, session_id);


--
-- Name: warmup_pairs warmup_pairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_pairs
    ADD CONSTRAINT warmup_pairs_pkey PRIMARY KEY (id);


--
-- Name: warmup_schedule warmup_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_schedule
    ADD CONSTRAINT warmup_schedule_pkey PRIMARY KEY (id);


--
-- Name: warmup_sessions warmup_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_sessions
    ADD CONSTRAINT warmup_sessions_pkey PRIMARY KEY (id);


--
-- Name: idx_accounts_api_credential_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_api_credential_id ON public.telegram_accounts USING btree (api_credential_id);


--
-- Name: idx_accounts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_created_at ON public.telegram_accounts USING btree (created_at DESC);


--
-- Name: idx_accounts_proxy_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_proxy_id ON public.telegram_accounts USING btree (proxy_id);


--
-- Name: idx_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_status ON public.telegram_accounts USING btree (status);


--
-- Name: idx_accounts_status_proxy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_status_proxy ON public.telegram_accounts USING btree (status, proxy_id) WHERE (status = 'active'::public.account_status);


--
-- Name: idx_accounts_warmup_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_warmup_pair ON public.telegram_accounts USING btree (warmup_pair_id) WHERE (warmup_pair_id IS NOT NULL);


--
-- Name: idx_campaign_recipients_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_campaign_id ON public.campaign_recipients USING btree (campaign_id);


--
-- Name: idx_campaign_recipients_campaign_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_campaign_status ON public.campaign_recipients USING btree (campaign_id, status);


--
-- Name: idx_campaign_recipients_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_queue ON public.campaign_recipients USING btree (campaign_id, status, scheduled_at) WHERE (status = ANY (ARRAY['queued'::text, 'pending'::text]));


--
-- Name: idx_campaign_recipients_seat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_seat_id ON public.campaign_recipients USING btree (seat_id);


--
-- Name: idx_campaign_recipients_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_status ON public.campaign_recipients USING btree (status);


--
-- Name: idx_conversations_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_account_id ON public.conversations USING btree (account_id);


--
-- Name: idx_conversations_account_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_account_updated ON public.conversations USING btree (account_id, updated_at DESC);


--
-- Name: idx_conversations_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_campaign_id ON public.conversations USING btree (campaign_id) WHERE (campaign_id IS NOT NULL);


--
-- Name: idx_conversations_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_created_at ON public.conversations USING btree (created_at DESC);


--
-- Name: idx_conversations_first_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_first_message ON public.conversations USING btree (first_message_sent) WHERE (first_message_sent = true);


--
-- Name: idx_conversations_first_message_sent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_first_message_sent ON public.conversations USING btree (first_message_sent);


--
-- Name: idx_conversations_has_reply; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_has_reply ON public.conversations USING btree (has_reply) WHERE (has_reply = true);


--
-- Name: idx_conversations_last_message_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_last_message_at ON public.conversations USING btree (last_message_at DESC);


--
-- Name: idx_conversations_outbound_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_outbound_active ON public.conversations USING btree (account_id, last_message_at DESC) WHERE ((first_message_sent = true) AND (last_message_at IS NOT NULL));


--
-- Name: idx_conversations_seat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_seat_id ON public.conversations USING btree (seat_id) WHERE (seat_id IS NOT NULL);


--
-- Name: idx_conversations_seat_last_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_seat_last_message ON public.conversations USING btree (seat_id, last_message_at DESC);


--
-- Name: idx_conversations_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_updated_at ON public.conversations USING btree (updated_at DESC);


--
-- Name: idx_material_data_tag_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_data_tag_id ON public.material_data USING btree (tag_id);


--
-- Name: idx_material_names_tag_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_names_tag_id ON public.material_names USING btree (tag_id);


--
-- Name: idx_material_pictures_tag_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_pictures_tag_id ON public.material_pictures USING btree (tag_id);


--
-- Name: idx_material_tags_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_material_tags_type ON public.material_tags USING btree (type);


--
-- Name: idx_messages_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_account_id ON public.messages USING btree (account_id);


--
-- Name: idx_messages_api_credential_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_api_credential_id ON public.messages USING btree (api_credential_id);


--
-- Name: idx_messages_campaign_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_campaign_recipient ON public.messages USING btree (campaign_recipient_id) WHERE (campaign_recipient_id IS NOT NULL);


--
-- Name: idx_messages_campaign_recipient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_campaign_recipient_id ON public.messages USING btree (campaign_recipient_id);


--
-- Name: idx_messages_campaign_recipient_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_campaign_recipient_status ON public.messages USING btree (campaign_recipient_id, status) WHERE (campaign_recipient_id IS NOT NULL);


--
-- Name: idx_messages_conversation_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conversation_created ON public.messages USING btree (conversation_id, created_at DESC);


--
-- Name: idx_messages_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conversation_id ON public.messages USING btree (conversation_id);


--
-- Name: idx_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_created_at ON public.messages USING btree (created_at DESC);


--
-- Name: idx_messages_direction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_direction ON public.messages USING btree (direction);


--
-- Name: idx_messages_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_pending ON public.messages USING btree (status, priority DESC, created_at) WHERE (status = 'pending'::public.message_status);


--
-- Name: idx_messages_priority_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_priority_status ON public.messages USING btree (priority DESC, status) WHERE (status = 'pending'::public.message_status);


--
-- Name: idx_messages_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_status ON public.messages USING btree (status);


--
-- Name: idx_proxies_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proxies_assigned ON public.proxies USING btree (assigned_account_id) WHERE (assigned_account_id IS NOT NULL);


--
-- Name: idx_proxies_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proxies_status ON public.proxies USING btree (status);


--
-- Name: idx_proxy_errors_proxy_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proxy_errors_proxy_created ON public.proxy_errors USING btree (proxy_id, created_at DESC);


--
-- Name: idx_recipients_api_credential_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_api_credential_id ON public.campaign_recipients USING btree (api_credential_id);


--
-- Name: idx_recipients_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_campaign_id ON public.campaign_recipients USING btree (campaign_id);


--
-- Name: idx_recipients_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_pending ON public.campaign_recipients USING btree (campaign_id, status) WHERE (status = 'pending'::text);


--
-- Name: idx_recipients_seat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_seat_id ON public.campaign_recipients USING btree (seat_id) WHERE (seat_id IS NOT NULL);


--
-- Name: idx_recipients_sent_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_sent_by ON public.campaign_recipients USING btree (sent_by_account_id) WHERE (sent_by_account_id IS NOT NULL);


--
-- Name: idx_recipients_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipients_status ON public.campaign_recipients USING btree (status);


--
-- Name: idx_telegram_accounts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_accounts_created_at ON public.telegram_accounts USING btree (created_at DESC);


--
-- Name: idx_telegram_accounts_last_campaign_send_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_accounts_last_campaign_send_at ON public.telegram_accounts USING btree (last_campaign_send_at) WHERE (last_campaign_send_at IS NOT NULL);


--
-- Name: idx_telegram_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_accounts_status ON public.telegram_accounts USING btree (status);


--
-- Name: idx_telegram_accounts_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telegram_accounts_tags ON public.telegram_accounts USING gin (tags);


--
-- Name: idx_vps_commands_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vps_commands_pending ON public.vps_commands USING btree (vps_id, status) WHERE (status = 'pending'::text);


--
-- Name: idx_vps_logs_vps_runner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vps_logs_vps_runner ON public.vps_logs USING btree (vps_id, runner_name, created_at DESC);


--
-- Name: idx_warmup_messages_claimed_stuck; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_messages_claimed_stuck ON public.warmup_messages USING btree (claimed_at, status) WHERE (status = 'sending'::text);


--
-- Name: idx_warmup_messages_scheduled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_messages_scheduled_at ON public.warmup_messages USING btree (scheduled_at);


--
-- Name: idx_warmup_messages_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_messages_status ON public.warmup_messages USING btree (status);


--
-- Name: idx_warmup_pairs_cycle_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_pairs_cycle_date ON public.warmup_pairs USING btree (last_cycle_date);


--
-- Name: idx_warmup_pairs_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_pairs_session_id ON public.warmup_pairs USING btree (session_id);


--
-- Name: idx_warmup_templates_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_templates_category ON public.warmup_message_templates USING btree (category);


--
-- Name: messages_unique_campaign_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_unique_campaign_recipient ON public.messages USING btree (conversation_id, campaign_recipient_id) WHERE (campaign_recipient_id IS NOT NULL);


--
-- Name: runner_heartbeats_runner_server_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runner_heartbeats_runner_server_idx ON public.runner_heartbeats USING btree (runner_name, COALESCE(server_id, 'legacy'::text));


--
-- Name: campaign_recipients before_campaign_recipient_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER before_campaign_recipient_delete BEFORE DELETE ON public.campaign_recipients FOR EACH ROW EXECUTE FUNCTION public.cancel_messages_on_recipient_delete();


--
-- Name: campaigns cleanup_recipients_on_campaign_stop; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cleanup_recipients_on_campaign_stop AFTER UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.cleanup_pending_recipients_on_campaign_stop();


--
-- Name: messages on_message_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_message_insert AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.update_conversation_on_message();


--
-- Name: messages trg_update_conversation_on_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_conversation_on_message AFTER INSERT OR UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.update_conversation_on_message();


--
-- Name: telegram_accounts trigger_auto_detect_frozen; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_auto_detect_frozen BEFORE INSERT OR UPDATE ON public.telegram_accounts FOR EACH ROW EXECUTE FUNCTION public.auto_detect_frozen_accounts();


--
-- Name: telegram_accounts trigger_auto_pair_warmup_on_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_auto_pair_warmup_on_insert BEFORE INSERT ON public.telegram_accounts FOR EACH ROW EXECUTE FUNCTION public.auto_pair_warmup_accounts();


--
-- Name: telegram_accounts trigger_auto_pair_warmup_on_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_auto_pair_warmup_on_update BEFORE UPDATE ON public.telegram_accounts FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR (old.session_data IS DISTINCT FROM new.session_data))) EXECUTE FUNCTION public.auto_pair_warmup_accounts();


--
-- Name: messages trigger_update_conversation_on_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_conversation_on_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.update_conversation_on_message();


--
-- Name: account_check_tasks update_account_check_tasks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_account_check_tasks_updated_at BEFORE UPDATE ON public.account_check_tasks FOR EACH ROW EXECUTE FUNCTION public.update_account_check_tasks_updated_at();


--
-- Name: telegram_accounts update_api_credential_count_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_api_credential_count_trigger AFTER INSERT OR DELETE OR UPDATE ON public.telegram_accounts FOR EACH ROW EXECUTE FUNCTION public.update_api_credential_count();


--
-- Name: app_settings update_app_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_app_settings_updated_at BEFORE UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: campaigns update_campaigns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: contacts_data update_contacts_data_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_contacts_data_updated_at BEFORE UPDATE ON public.contacts_data FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: messages update_conversation_on_new_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_conversation_on_new_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.update_conversation_details();


--
-- Name: conversations update_conversations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: material_data update_data_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_data_count AFTER INSERT OR DELETE ON public.material_data FOR EACH ROW EXECUTE FUNCTION public.update_material_tag_count();


--
-- Name: material_names update_names_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_names_count AFTER INSERT OR DELETE ON public.material_names FOR EACH ROW EXECUTE FUNCTION public.update_material_tag_count();


--
-- Name: material_pictures update_pictures_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_pictures_count AFTER INSERT OR DELETE ON public.material_pictures FOR EACH ROW EXECUTE FUNCTION public.update_material_tag_count();


--
-- Name: account_check_tasks account_check_tasks_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_check_tasks
    ADD CONSTRAINT account_check_tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: block_contact_tasks block_contact_tasks_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_contact_tasks
    ADD CONSTRAINT block_contact_tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: blocked_contacts blocked_contacts_blocked_by_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_contacts
    ADD CONSTRAINT blocked_contacts_blocked_by_account_id_fkey FOREIGN KEY (blocked_by_account_id) REFERENCES public.telegram_accounts(id) ON DELETE SET NULL;


--
-- Name: campaign_accounts campaign_accounts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_accounts
    ADD CONSTRAINT campaign_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: campaign_accounts campaign_accounts_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_accounts
    ADD CONSTRAINT campaign_accounts_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaign_recipients campaign_recipients_api_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_api_credential_id_fkey FOREIGN KEY (api_credential_id) REFERENCES public.telegram_api_credentials(id);


--
-- Name: campaign_recipients campaign_recipients_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaign_recipients campaign_recipients_seat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_seat_id_fkey FOREIGN KEY (seat_id) REFERENCES public.seats(id) ON DELETE SET NULL;


--
-- Name: campaign_recipients campaign_recipients_sent_by_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_sent_by_account_id_fkey FOREIGN KEY (sent_by_account_id) REFERENCES public.telegram_accounts(id) ON DELETE SET NULL;


--
-- Name: campaigns campaigns_seat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_seat_id_fkey FOREIGN KEY (seat_id) REFERENCES public.seats(id) ON DELETE SET NULL;


--
-- Name: contact_import_tasks contact_import_tasks_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_import_tasks
    ADD CONSTRAINT contact_import_tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: contact_import_tasks contact_import_tasks_current_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_import_tasks
    ADD CONSTRAINT contact_import_tasks_current_account_id_fkey FOREIGN KEY (current_account_id) REFERENCES public.telegram_accounts(id);


--
-- Name: contact_import_tasks contact_import_tasks_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_import_tasks
    ADD CONSTRAINT contact_import_tasks_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.contact_tags(id) ON DELETE CASCADE;


--
-- Name: contacts_data contacts_data_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts_data
    ADD CONSTRAINT contacts_data_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.contact_tags(id) ON DELETE SET NULL;


--
-- Name: contacts_data contacts_data_used_in_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts_data
    ADD CONSTRAINT contacts_data_used_in_campaign_id_fkey FOREIGN KEY (used_in_campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_seat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_seat_id_fkey FOREIGN KEY (seat_id) REFERENCES public.seats(id) ON DELETE SET NULL;


--
-- Name: telegram_accounts fk_proxy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_accounts
    ADD CONSTRAINT fk_proxy FOREIGN KEY (proxy_id) REFERENCES public.proxies(id) ON DELETE SET NULL;


--
-- Name: interaction_scheduler interaction_scheduler_receiver_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_scheduler
    ADD CONSTRAINT interaction_scheduler_receiver_account_id_fkey FOREIGN KEY (receiver_account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: interaction_scheduler interaction_scheduler_sender_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interaction_scheduler
    ADD CONSTRAINT interaction_scheduler_sender_account_id_fkey FOREIGN KEY (sender_account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: material_data material_data_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_data
    ADD CONSTRAINT material_data_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.material_tags(id) ON DELETE CASCADE;


--
-- Name: material_names material_names_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_names
    ADD CONSTRAINT material_names_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.material_tags(id) ON DELETE CASCADE;


--
-- Name: material_pictures material_pictures_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_pictures
    ADD CONSTRAINT material_pictures_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.material_tags(id) ON DELETE CASCADE;


--
-- Name: maturation_tasks maturation_tasks_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maturation_tasks
    ADD CONSTRAINT maturation_tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: messages messages_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: messages messages_api_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_api_credential_id_fkey FOREIGN KEY (api_credential_id) REFERENCES public.telegram_api_credentials(id);


--
-- Name: messages messages_campaign_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_campaign_recipient_id_fkey FOREIGN KEY (campaign_recipient_id) REFERENCES public.campaign_recipients(id) ON DELETE SET NULL;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: proxies proxies_assigned_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxies
    ADD CONSTRAINT proxies_assigned_account_id_fkey FOREIGN KEY (assigned_account_id) REFERENCES public.telegram_accounts(id) ON DELETE SET NULL;


--
-- Name: proxy_errors proxy_errors_proxy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxy_errors
    ADD CONSTRAINT proxy_errors_proxy_id_fkey FOREIGN KEY (proxy_id) REFERENCES public.proxies(id) ON DELETE CASCADE;


--
-- Name: scheduled_interactions scheduled_interactions_receiver_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_interactions
    ADD CONSTRAINT scheduled_interactions_receiver_account_id_fkey FOREIGN KEY (receiver_account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: scheduled_interactions scheduled_interactions_sender_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_interactions
    ADD CONSTRAINT scheduled_interactions_sender_account_id_fkey FOREIGN KEY (sender_account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: telegram_accounts telegram_accounts_api_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_accounts
    ADD CONSTRAINT telegram_accounts_api_credential_id_fkey FOREIGN KEY (api_credential_id) REFERENCES public.telegram_api_credentials(id);


--
-- Name: telegram_accounts telegram_accounts_warmup_pair_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_accounts
    ADD CONSTRAINT telegram_accounts_warmup_pair_id_fkey FOREIGN KEY (warmup_pair_id) REFERENCES public.telegram_accounts(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: vps_commands vps_commands_vps_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vps_commands
    ADD CONSTRAINT vps_commands_vps_id_fkey FOREIGN KEY (vps_id) REFERENCES public.vps_connections(id) ON DELETE CASCADE;


--
-- Name: vps_logs vps_logs_vps_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vps_logs
    ADD CONSTRAINT vps_logs_vps_id_fkey FOREIGN KEY (vps_id) REFERENCES public.vps_connections(id) ON DELETE CASCADE;


--
-- Name: warmup_errors warmup_errors_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_errors
    ADD CONSTRAINT warmup_errors_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: warmup_errors warmup_errors_pair_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_errors
    ADD CONSTRAINT warmup_errors_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES public.warmup_pairs(id) ON DELETE CASCADE;


--
-- Name: warmup_errors warmup_errors_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_errors
    ADD CONSTRAINT warmup_errors_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.warmup_sessions(id) ON DELETE CASCADE;


--
-- Name: warmup_messages warmup_messages_pair_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_messages
    ADD CONSTRAINT warmup_messages_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES public.warmup_pairs(id) ON DELETE CASCADE;


--
-- Name: warmup_messages warmup_messages_receiver_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_messages
    ADD CONSTRAINT warmup_messages_receiver_account_id_fkey FOREIGN KEY (receiver_account_id) REFERENCES public.telegram_accounts(id);


--
-- Name: warmup_messages warmup_messages_sender_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_messages
    ADD CONSTRAINT warmup_messages_sender_account_id_fkey FOREIGN KEY (sender_account_id) REFERENCES public.telegram_accounts(id);


--
-- Name: warmup_messages warmup_messages_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_messages
    ADD CONSTRAINT warmup_messages_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.warmup_message_templates(id);


--
-- Name: warmup_pairs warmup_pairs_account_a_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_pairs
    ADD CONSTRAINT warmup_pairs_account_a_id_fkey FOREIGN KEY (account_a_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: warmup_pairs warmup_pairs_account_b_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_pairs
    ADD CONSTRAINT warmup_pairs_account_b_id_fkey FOREIGN KEY (account_b_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: warmup_schedule warmup_schedule_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warmup_schedule
    ADD CONSTRAINT warmup_schedule_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.telegram_accounts(id) ON DELETE CASCADE;


--
-- Name: user_roles Admins can manage all roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all roles" ON public.user_roles USING (public.is_admin());


--
-- Name: proxy_errors Allow all operations for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all operations for authenticated users" ON public.proxy_errors USING (true) WITH CHECK (true);


--
-- Name: account_check_tasks Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.account_check_tasks USING (true) WITH CHECK (true);


--
-- Name: app_settings Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.app_settings USING (true) WITH CHECK (true);


--
-- Name: block_contact_tasks Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.block_contact_tasks USING (true) WITH CHECK (true);


--
-- Name: blocked_contacts Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.blocked_contacts USING (true) WITH CHECK (true);


--
-- Name: campaign_accounts Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.campaign_accounts USING (true) WITH CHECK (true);


--
-- Name: campaign_recipients Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.campaign_recipients USING (true) WITH CHECK (true);


--
-- Name: campaigns Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.campaigns USING (true) WITH CHECK (true);


--
-- Name: contact_import_tasks Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.contact_import_tasks USING (true) WITH CHECK (true);


--
-- Name: contact_tags Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.contact_tags USING (true) WITH CHECK (true);


--
-- Name: contacts_data Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.contacts_data USING (true) WITH CHECK (true);


--
-- Name: conversations Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.conversations USING (true) WITH CHECK (true);


--
-- Name: interaction_scheduler Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.interaction_scheduler USING (true) WITH CHECK (true);


--
-- Name: material_data Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.material_data USING (true) WITH CHECK (true);


--
-- Name: material_names Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.material_names USING (true) WITH CHECK (true);


--
-- Name: material_pictures Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.material_pictures USING (true) WITH CHECK (true);


--
-- Name: material_tags Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.material_tags USING (true) WITH CHECK (true);


--
-- Name: maturation_tasks Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.maturation_tasks USING (true) WITH CHECK (true);


--
-- Name: messages Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.messages USING (true) WITH CHECK (true);


--
-- Name: proxies Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.proxies USING (true) WITH CHECK (true);


--
-- Name: runner_heartbeats Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.runner_heartbeats USING (true) WITH CHECK (true);


--
-- Name: scheduled_interactions Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.scheduled_interactions USING (true) WITH CHECK (true);


--
-- Name: seats Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.seats USING (true) WITH CHECK (true);


--
-- Name: telegram_accounts Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.telegram_accounts USING (true) WITH CHECK (true);


--
-- Name: telegram_api_credentials Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.telegram_api_credentials USING (true) WITH CHECK (true);


--
-- Name: vps_commands Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.vps_commands USING (true) WITH CHECK (true);


--
-- Name: vps_connections Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.vps_connections USING (true) WITH CHECK (true);


--
-- Name: vps_logs Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.vps_logs USING (true) WITH CHECK (true);


--
-- Name: warmup_errors Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.warmup_errors USING (true) WITH CHECK (true);


--
-- Name: warmup_message_templates Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.warmup_message_templates USING (true) WITH CHECK (true);


--
-- Name: warmup_messages Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.warmup_messages USING (true) WITH CHECK (true);


--
-- Name: warmup_pairs Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.warmup_pairs USING (true) WITH CHECK (true);


--
-- Name: warmup_schedule Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.warmup_schedule USING (true) WITH CHECK (true);


--
-- Name: warmup_sessions Public access for admin tool; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public access for admin tool" ON public.warmup_sessions USING (true) WITH CHECK (true);


--
-- Name: user_roles Users can view their own roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own roles" ON public.user_roles FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: account_check_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_check_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: app_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: block_contact_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.block_contact_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: blocked_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocked_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_recipients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_import_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_import_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts_data; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts_data ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: interaction_scheduler; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.interaction_scheduler ENABLE ROW LEVEL SECURITY;

--
-- Name: material_data; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_data ENABLE ROW LEVEL SECURITY;

--
-- Name: material_names; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_names ENABLE ROW LEVEL SECURITY;

--
-- Name: material_pictures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_pictures ENABLE ROW LEVEL SECURITY;

--
-- Name: material_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: maturation_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.maturation_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: proxies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.proxies ENABLE ROW LEVEL SECURITY;

--
-- Name: proxy_errors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.proxy_errors ENABLE ROW LEVEL SECURITY;

--
-- Name: runner_heartbeats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.runner_heartbeats ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduled_interactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduled_interactions ENABLE ROW LEVEL SECURITY;

--
-- Name: seats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.seats ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_api_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_api_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: vps_commands; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vps_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: vps_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vps_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: vps_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vps_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: warmup_errors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warmup_errors ENABLE ROW LEVEL SECURITY;

--
-- Name: warmup_message_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warmup_message_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: warmup_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warmup_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: warmup_pairs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warmup_pairs ENABLE ROW LEVEL SECURITY;

--
-- Name: warmup_schedule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warmup_schedule ENABLE ROW LEVEL SECURITY;

--
-- Name: warmup_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warmup_sessions ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--




COMMIT;