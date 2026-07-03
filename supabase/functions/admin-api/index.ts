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
  let path = url.pathname.replace('/admin-api', '');
  const method = req.method;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = method !== "GET" ? await req.json().catch(() => ({})) : {};
    
    // Support path in body for single-endpoint calls from frontend
    if (body.path && !path) {
      path = body.path;
    }

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

      console.log(`[admin-api] Starting campaign ${campaign_id}`);

      // === AUTO-ENROLL: Add any active accounts with remaining capacity ===
      // This ensures resumed campaigns can use newly activated accounts
      const { data: existingLinks } = await supabase
        .from('campaign_accounts')
        .select('account_id')
        .eq('campaign_id', campaign_id);
      
      const existingAccountIds = new Set((existingLinks || []).map((l: any) => l.account_id));

      // app_settings removed — use hardcoded default
      const messagesPerAccountPerDay = 10;


      // Find active accounts with session data, valid proxy, and remaining daily capacity
      const { data: availableAccounts } = await supabase
        .from('telegram_accounts')
        .select('id, messages_sent_today, proxy_id')
        .eq('status', 'active')
        .not('session_data', 'is', null)
        .not('proxy_id', 'is', null)
        .lt('messages_sent_today', messagesPerAccountPerDay);

      // Filter to only accounts not already linked
      const newAccountIds = (availableAccounts || [])
        .filter((a: any) => !existingAccountIds.has(a.id))
        .map((a: any) => a.id);

      if (newAccountIds.length > 0) {
        const { error: linkError } = await supabase
          .from('campaign_accounts')
          .insert(newAccountIds.map((aid: string) => ({ campaign_id, account_id: aid })));
        
        if (linkError) {
          console.error(`[admin-api] Failed to auto-enroll accounts:`, linkError);
        } else {
          console.log(`[admin-api] Auto-enrolled ${newAccountIds.length} fresh accounts into campaign ${campaign_id}`);
        }
      }

      const { data, error } = await supabase
        .from('campaigns')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('id', campaign_id)
        .select()
        .single();

      if (error) throw error;

      // Promote all queued recipients to pending so the runner picks them up
      const { data: promoted, error: promoteError } = await supabase
        .from('campaign_recipients')
        .update({ status: 'pending' })
        .eq('campaign_id', campaign_id)
        .eq('status', 'queued')
        .select('id');

      if (promoteError) {
        console.error(`[admin-api] Failed to promote queued recipients:`, promoteError);
      } else {
        const count = promoted?.length ?? 0;
        console.log(`[admin-api] Promoted ${count} queued recipients to pending for campaign ${campaign_id}`);
      }

      return jsonResponse({ success: true, campaign: data, promoted_count: promoted?.length ?? 0, auto_enrolled_accounts: newAccountIds.length });
    }

    if (path === '/campaigns/pause' && method === 'POST') {
      const { campaign_id } = body;
      if (!campaign_id) return jsonResponse({ error: "campaign_id required" }, 400);

      console.log(`[admin-api] Pausing campaign ${campaign_id}`);

      // Step 1: Update campaign status immediately
      const { error: campaignError } = await supabase
        .from('campaigns')
        .update({ status: 'paused', updated_at: new Date().toISOString() })
        .eq('id', campaign_id);

      if (campaignError) throw campaignError;

      // Step 2: Reset recipients in background (parallel)
      const resetPromise = (async () => {
        try {
          await Promise.all([
            supabase
              .from("campaign_recipients")
              .update({
                status: "queued",
                sent_by_account_id: null,
                api_credential_id: null,
                scheduled_at: null,
                failed_reason: null,
              })
              .eq("campaign_id", campaign_id)
              .eq("status", "sending"),
            supabase
              .from("campaign_recipients")
              .update({
                status: "queued",
                sent_by_account_id: null,
                api_credential_id: null,
                scheduled_at: null,
                failed_reason: null,
              })
              .eq("campaign_id", campaign_id)
              .eq("status", "pending"),
          ]);
          console.log(`[admin-api] Reset recipients for campaign ${campaign_id}`);
        } catch (err) {
          console.error(`[admin-api] Background reset error:`, err);
        }
      })();

      // Use EdgeRuntime.waitUntil if available, otherwise just fire and forget
      // @ts-ignore
      (globalThis as any).EdgeRuntime?.waitUntil?.(resetPromise) ?? resetPromise;

      return jsonResponse({ success: true, campaign_id, message: "Campaign paused" });
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
      const { accounts, tags } = body;
      if (!accounts?.length) return jsonResponse({ error: "accounts array required" }, 400);

      const metadataStats = {
        with_json_api: 0,
        with_json_fingerprint: 0,
        with_generated_fingerprint: 0,
        with_2fa: 0,
      };

      const normalizePhoneNumber = (value: unknown) => {
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        if (raw.startsWith('+unknown_')) return raw;
        const digits = raw.replace(/\D/g, '');
        return digits ? `+${digits}` : raw.startsWith('+') ? raw : `+${raw}`;
      };

      const generatedDeviceModel = (phone: string) => {
        const suffix = phone.replace(/\D/g, '').slice(-4) || 'cloud';
        return `Telegram Desktop ${suffix}`;
      };

      // Extract all phone numbers from incoming accounts
      const incomingPhones = accounts.map((acc: any) => normalizePhoneNumber(acc.phone_number || acc.phone || acc.phone_num)).filter(Boolean);

      // Step 1: Fetch existing phone numbers in ONE query
      const { data: existingAccounts, error: fetchError } = await supabase
        .from('telegram_accounts')
        .select('phone_number')
        .in('phone_number', incomingPhones);

      if (fetchError) {
        console.error('[admin-api] Error fetching existing accounts:', fetchError);
        throw fetchError;
      }

      const existingPhoneSet = new Set((existingAccounts || []).map((a: any) => a.phone_number));
      let skipped = 0;

      // Step 2: Normalize and prepare accounts. Existing accounts are updated.
      const accountsByPhone = new Map<string, any>();
      const errors: any[] = [];
      for (const acc of accounts) {
        const phone = normalizePhoneNumber(acc.phone_number || acc.phone || acc.phone_num);
        if (!phone) {
          errors.push({ phone: acc.phone_number || acc.phone || acc.phone_num || null, error: 'Missing phone number' });
          continue;
        }
        
        // Resolve field name variations
        const resolvedApiId = (acc.api_id || acc.app_id)?.toString() || null;
        const resolvedApiHash = acc.api_hash || acc.app_hash || null;
        const resolvedDeviceModel = acc.device_model || acc.device || generatedDeviceModel(phone);
        const resolvedSystemVersion = acc.system_version || acc.sdk || 'Windows';
        
        // Track metadata stats for all accounts
        if (resolvedApiId && resolvedApiHash) metadataStats.with_json_api++;
        if (acc.device_model || acc.device || acc.system_version || acc.sdk) metadataStats.with_json_fingerprint++;
        else metadataStats.with_generated_fingerprint++;
        if (acc.two_fa_password || acc.twoFA || acc['2fa']) metadataStats.with_2fa++;

        // If the same phone appears twice in one upload, keep the latest row and count one skip.
        if (accountsByPhone.has(phone)) skipped++;

        accountsByPhone.set(phone, {
          phone_number: phone,
          session_data: acc.session_data || acc.session,
          first_name: acc.first_name,
          last_name: acc.last_name,
          username: acc.username,
          telegram_id: acc.telegram_id,
          api_id: resolvedApiId,
          api_hash: resolvedApiHash,
          device_model: resolvedDeviceModel,
          system_version: resolvedSystemVersion,
          app_version: acc.app_version || null,
          build_id: acc.build_id || null,
          lang_code: acc.lang_code || acc.lang_pack || 'en',
          system_lang_code: acc.system_lang_code || acc.system_lang_pack || 'en-US',
          two_fa_password: acc.two_fa_password || acc.twoFA || acc['2fa'] || null,
          ...(Array.isArray(tags) && tags.length > 0 ? { tags } : {}),
        });
      }

      const accountsToUpsert = Array.from(accountsByPhone.values());

      // Step 3: Batch upsert accounts (if any)
      let successful = 0;
      let failed = errors.length;
      const accountIds: string[] = [];

      if (accountsToUpsert.length > 0) {
        const { data: insertedAccounts, error: insertError } = await supabase
          .from('telegram_accounts')
          .upsert(accountsToUpsert, { onConflict: 'phone_number' })
          .select('id');

        if (insertError) {
          console.error('[admin-api] Batch upsert error:', insertError);
          // If batch fails, try one-by-one as fallback
          for (const acc of accountsToUpsert) {
            const { data, error } = await supabase
              .from('telegram_accounts')
              .upsert(acc, { onConflict: 'phone_number' })
              .select('id')
              .single();
            if (error) {
              console.log(`[admin-api] Account ${acc.phone_number} failed: ${error.message}`);
              failed++;
              errors.push({ phone: acc.phone_number, error: error.message });
            } else {
              successful++;
              if (data?.id) accountIds.push(data.id);
            }
          }
        } else {
          successful = insertedAccounts?.length || 0;
          accountIds.push(...(insertedAccounts || []).map((a: any) => a.id));
        }
      }

      console.log(`[admin-api] Upload complete: ${successful} saved, ${existingPhoneSet.size} updated, ${skipped} skipped, ${failed} failed`);

      return jsonResponse({
        success: true,
        successful,
        skipped,
        failed,
        errors,
        account_ids: accountIds,
        metadata_stats: metadataStats,
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
