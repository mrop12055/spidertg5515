import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * UNIFIED ADMIN API ENDPOINT
 * 
 * Consolidates: telegram-api, send-bulk-messages, verify-sessions, process-account-upload
 * 
 * Routes:
 * - GET/POST/PATCH/DELETE /accounts - Account CRUD
 * - GET/POST/DELETE /proxies - Proxy CRUD
 * - GET/POST /campaigns - Campaign CRUD
 * - POST /campaigns/start - Start campaign
 * - POST /campaigns/pause - Pause campaign
 * - POST /verify-sessions - Verify account sessions
 * - POST /upload-accounts - Process account upload
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/admin-api', '');
  const method = req.method;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = method !== "GET" ? await req.json().catch(() => ({})) : {};

    console.log(`[admin-api] ${method} ${path}`);

    // ==================== ACCOUNTS ====================
    if (path === '/accounts' && method === 'GET') {
      const { data, error } = await supabase.from('telegram_accounts').select('*, proxies(*)');
      if (error) throw error;
      return jsonResponse(data);
    }

    if (path === '/accounts' && method === 'POST') {
      const { data, error } = await supabase.from('telegram_accounts').insert(body).select().single();
      if (error) throw error;
      return jsonResponse(data, 201);
    }

    if (path.startsWith('/accounts/') && method === 'PATCH') {
      const id = path.split('/')[2];
      const { data, error } = await supabase.from('telegram_accounts').update(body).eq('id', id).select().single();
      if (error) throw error;
      return jsonResponse(data);
    }

    if (path.startsWith('/accounts/') && method === 'DELETE') {
      const id = path.split('/')[2];
      const { error } = await supabase.from('telegram_accounts').delete().eq('id', id);
      if (error) throw error;
      return jsonResponse({ success: true });
    }

    // ==================== PROXIES ====================
    if (path === '/proxies' && method === 'GET') {
      const { data, error } = await supabase.from('proxies').select('*');
      if (error) throw error;
      return jsonResponse(data);
    }

    if (path === '/proxies' && method === 'POST') {
      const proxies = Array.isArray(body) ? body : body.proxies || [body];
      const { data, error } = await supabase.from('proxies').insert(proxies).select();
      if (error) throw error;
      return jsonResponse(data, 201);
    }

    if (path.startsWith('/proxies/') && method === 'DELETE') {
      const id = path.split('/')[2];
      const { error } = await supabase.from('proxies').delete().eq('id', id);
      if (error) throw error;
      return jsonResponse({ success: true });
    }

    // ==================== CAMPAIGNS ====================
    if (path === '/campaigns' && method === 'GET') {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*, campaign_accounts(account_id)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return jsonResponse(data);
    }

    if (path === '/campaigns' && method === 'POST') {
      const { account_ids, recipients, ...campaignData } = body;
      
      const { data: campaign, error } = await supabase.from('campaigns').insert(campaignData).select().single();
      if (error) throw error;

      // Link accounts
      if (account_ids?.length) {
        await supabase.from('campaign_accounts').insert(
          account_ids.map((aid: string) => ({ campaign_id: campaign.id, account_id: aid }))
        );
      }

      // Add recipients
      if (recipients?.length) {
        const recipientData = recipients.map((r: any) => ({
          campaign_id: campaign.id,
          phone_number: r.phone || r.phone_number,
          name: r.name,
          status: 'pending',
        }));
        await supabase.from('campaign_recipients').insert(recipientData);
        await supabase.from('campaigns').update({ recipient_count: recipients.length }).eq('id', campaign.id);
      }

      return jsonResponse(campaign, 201);
    }

    if (path === '/campaigns/start' && method === 'POST') {
      const { campaign_id } = body;
      if (!campaign_id) return jsonResponse({ error: "campaign_id required" }, 400);

      const { data, error } = await supabase
        .from('campaigns')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('id', campaign_id)
        .select()
        .single();

      if (error) throw error;
      return jsonResponse({ success: true, campaign: data });
    }

    if (path === '/campaigns/pause' && method === 'POST') {
      const { campaign_id } = body;
      if (!campaign_id) return jsonResponse({ error: "campaign_id required" }, 400);

      const { data, error } = await supabase
        .from('campaigns')
        .update({ status: 'paused', updated_at: new Date().toISOString() })
        .eq('id', campaign_id)
        .select()
        .single();

      if (error) throw error;
      return jsonResponse({ success: true, campaign: data });
    }

    // ==================== VERIFY SESSIONS ====================
    if (path === '/verify-sessions' && method === 'POST') {
      const { account_ids } = body;
      
      let query = supabase.from('telegram_accounts').select('id, phone_number, session_data, status');
      if (account_ids?.length) {
        query = query.in('id', account_ids);
      }

      const { data: accounts, error } = await query;
      if (error) throw error;

      const results = (accounts || []).map((acc: any) => ({
        id: acc.id,
        phone_number: acc.phone_number,
        has_session: !!acc.session_data,
        status: acc.status,
        valid: !!acc.session_data && acc.status !== 'banned',
      }));

      return jsonResponse({
        success: true,
        total: results.length,
        valid: results.filter((r: any) => r.valid).length,
        invalid: results.filter((r: any) => !r.valid).length,
        results,
      });
    }

    // ==================== UPLOAD ACCOUNTS ====================
    if (path === '/upload-accounts' && method === 'POST') {
      const { accounts } = body;
      if (!accounts?.length) return jsonResponse({ error: "accounts array required" }, 400);

      const insertData = accounts.map((acc: any) => ({
        phone_number: acc.phone_number || acc.phone,
        session_data: acc.session_data || acc.session,
        first_name: acc.first_name,
        last_name: acc.last_name,
        username: acc.username,
        telegram_id: acc.telegram_id,
        api_id: acc.api_id,
        api_hash: acc.api_hash,
        device_model: acc.device_model,
        system_version: acc.system_version,
        app_version: acc.app_version,
        lang_code: acc.lang_code || 'en',
        system_lang_code: acc.system_lang_code || 'en-US',
        status: 'disconnected',
      }));

      const { data, error } = await supabase.from('telegram_accounts').insert(insertData).select();
      if (error) throw error;

      return jsonResponse({
        success: true,
        imported: data.length,
      });
    }

    // ==================== CONVERSATIONS ====================
    if (path === '/conversations' && method === 'GET') {
      const accountId = url.searchParams.get('account_id');
      const seatId = url.searchParams.get('seat_id');
      
      let query = supabase.from('conversations').select('*').order('updated_at', { ascending: false });
      if (accountId) query = query.eq('account_id', accountId);
      if (seatId) query = query.eq('seat_id', seatId);

      const { data, error } = await query;
      if (error) throw error;
      return jsonResponse(data);
    }

    // ==================== MESSAGES ====================
    if (path === '/messages' && method === 'GET') {
      const conversationId = url.searchParams.get('conversation_id');
      if (!conversationId) return jsonResponse({ error: 'conversation_id required' }, 400);

      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return jsonResponse(data);
    }

    if (path === '/messages' && method === 'POST') {
      const { data, error } = await supabase.from('messages').insert(body).select().single();
      if (error) throw error;
      return jsonResponse(data, 201);
    }

    return jsonResponse({ error: 'Not found', path }, 404);

  } catch (error) {
    console.error('[admin-api] Error:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
