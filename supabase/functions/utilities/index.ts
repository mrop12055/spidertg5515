import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * UNIFIED UTILITIES ENDPOINT
 * 
 * Consolidates: test-proxies, detect-proxy-country, cleanup-old-chats, system-maintenance
 * 
 * Routes:
 * - POST /test-proxies - Test proxy connections
 * - POST /detect-country - Detect proxy country
 * - POST /cleanup - Cleanup old data
 * - POST /maintenance - System maintenance tasks
 * - GET /stats - Get system statistics
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper for timeout
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ]);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  let path = url.pathname.replace('/utilities', '');

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = req.method !== "GET" ? await req.json().catch(() => ({})) : {};
    
    // Support path in body for single-endpoint calls from frontend
    if (body.path && !path) {
      path = body.path;
    }

    console.log(`[utilities] ${req.method} ${path}`);

    // ==================== TEST PROXIES ====================
    if (path === '/test-proxies' && req.method === 'POST') {
      const { proxy_ids, auto_detect_country = true } = body;
      
      if (!proxy_ids || !Array.isArray(proxy_ids)) {
        return jsonResponse({ error: 'proxy_ids array required' }, 400);
      }

      console.log(`[utilities] Testing ${proxy_ids.length} proxies`);

      // Fetch proxies in batches
      const proxies: any[] = [];
      for (let i = 0; i < proxy_ids.length; i += 100) {
        const batchIds = proxy_ids.slice(i, i + 100);
        const { data: batchProxies } = await supabase.from('proxies').select('*').in('id', batchIds);
        if (batchProxies) proxies.push(...batchProxies);
      }

      // Test in batches of 50
      const results: any[] = [];
      for (let i = 0; i < proxies.length; i += 50) {
        const batch = proxies.slice(i, i + 50);
        
        const batchResults = await Promise.all(batch.map(async (proxy) => {
          const startTime = Date.now();
          try {
            const conn = await withTimeout(
              Deno.connect({ hostname: proxy.host, port: proxy.port }),
              10000,
              'Connection timeout'
            );
            conn.close();
            
            const responseTime = Date.now() - startTime;
            let detectedCountry: string | undefined;
            const passwordMatch = proxy.password?.match(/-([A-Z]{2})-/);
            if (passwordMatch) detectedCountry = passwordMatch[1];

            await supabase.from('proxies').update({
              status: 'active',
              response_time: responseTime,
              last_checked: new Date().toISOString(),
              ...(detectedCountry && auto_detect_country ? { detected_country: detectedCountry } : {}),
            }).eq('id', proxy.id);

            return { id: proxy.id, success: true, responseTime, country: detectedCountry };
          } catch (e) {
            const responseTime = Date.now() - startTime;
            await supabase.from('proxies').update({
              status: 'error',
              response_time: responseTime,
              last_checked: new Date().toISOString(),
            }).eq('id', proxy.id);
            return { id: proxy.id, success: false, responseTime, error: e instanceof Error ? e.message : 'Unknown' };
          }
        }));
        
        results.push(...batchResults);
      }

      const working = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      return jsonResponse({ success: true, results, summary: { working, failed } });
    }

    // ==================== DETECT COUNTRY ====================
    if (path === '/detect-country' && req.method === 'POST') {
      const { proxy_id } = body;
      if (!proxy_id) return jsonResponse({ error: 'proxy_id required' }, 400);

      const { data: proxy } = await supabase.from('proxies').select('*').eq('id', proxy_id).single();
      if (!proxy) return jsonResponse({ error: 'Proxy not found' }, 404);

      // Extract country from password pattern
      let country: string | undefined;
      const passwordMatch = proxy.password?.match(/-([A-Z]{2})-/);
      if (passwordMatch) {
        country = passwordMatch[1];
        await supabase.from('proxies').update({ detected_country: country }).eq('id', proxy_id);
      }

      return jsonResponse({ success: true, proxy_id, country });
    }

    // ==================== CLEANUP ====================
    if (path === '/cleanup' && req.method === 'POST') {
      const { days_old = 30 } = body;
      const cutoffDate = new Date(Date.now() - days_old * 24 * 60 * 60 * 1000).toISOString();

      console.log(`[utilities] Cleanup: removing data older than ${days_old} days`);

      // Cleanup old warmup messages
      const { count: warmupDeleted } = await supabase
        .from('warmup_messages')
        .delete({ count: 'exact' })
        .in('status', ['sent', 'failed', 'cancelled'])
        .lt('created_at', cutoffDate);

      // Cleanup old warmup errors
      const { count: errorsDeleted } = await supabase
        .from('warmup_errors')
        .delete({ count: 'exact' })
        .lt('created_at', cutoffDate);

      // Cleanup old proxy errors
      const { count: proxyErrorsDeleted } = await supabase
        .from('proxy_errors')
        .delete({ count: 'exact' })
        .lt('created_at', cutoffDate);

      // Cleanup old VPS logs
      const { count: logsDeleted } = await supabase
        .from('vps_logs')
        .delete({ count: 'exact' })
        .lt('created_at', cutoffDate);

      return jsonResponse({
        success: true,
        deleted: {
          warmup_messages: warmupDeleted || 0,
          warmup_errors: errorsDeleted || 0,
          proxy_errors: proxyErrorsDeleted || 0,
          vps_logs: logsDeleted || 0,
        },
      });
    }

    // ==================== MAINTENANCE ====================
    if (path === '/maintenance' && req.method === 'POST') {
      const now = new Date().toISOString();
      const results: Record<string, any> = {};

      // Reset daily message counts (if past midnight UTC)
      const { error: resetError } = await supabase.rpc('reset_daily_message_counts');
      results.daily_counts_reset = !resetError;

      // Sync messages_sent_today with actual counts from messages table
      const { error: syncError } = await supabase.rpc('sync_messages_sent_today');
      results.messages_sent_today_synced = !syncError;

      // Auto-restore expired cooldowns
      const { data: expiredCooldowns } = await supabase
        .from('telegram_accounts')
        .select('id')
        .in('status', ['cooldown', 'restricted'])
        .lt('restricted_until', now);

      if (expiredCooldowns && expiredCooldowns.length > 0) {
        await supabase.from('telegram_accounts')
          .update({ status: 'active', restricted_until: null, ban_reason: null })
          .in('id', expiredCooldowns.map((a: any) => a.id));
        results.cooldowns_restored = expiredCooldowns.length;
      }

      // Mark offline runners
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: offlineRunners } = await supabase
        .from('runner_heartbeats')
        .update({ status: 'offline', last_offline_at: now })
        .eq('status', 'online')
        .lt('last_seen', fiveMinutesAgo)
        .select();

      results.runners_marked_offline = offlineRunners?.length || 0;

      // Reset stale "sending" recipients (stuck for > 3 minutes)
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const { data: staleRecipients } = await supabase
        .from('campaign_recipients')
        .update({ 
          status: 'pending', 
          sending_started_at: null,
          sent_by_account_id: null 
        })
        .eq('status', 'sending')
        .lt('sending_started_at', threeMinutesAgo)
        .select('id');

      results.stale_recipients_reset = staleRecipients?.length || 0;

      // Auto-complete stuck campaigns
      const { data: runningCampaigns } = await supabase
        .from('campaigns')
        .select('id')
        .eq('status', 'running');

      let campaignsCompleted = 0;
      for (const campaign of runningCampaigns || []) {
        const { count: pendingCount } = await supabase
          .from('campaign_recipients')
          .select('*', { count: 'exact', head: true })
          .eq('campaign_id', campaign.id)
          .in('status', ['pending', 'sending', 'queued']);

        if (pendingCount === 0) {
          await supabase.from('campaigns')
            .update({ status: 'completed', updated_at: now })
            .eq('id', campaign.id);
          campaignsCompleted++;
        }
      }
      results.campaigns_completed = campaignsCompleted;

      return jsonResponse({ success: true, results });
    }

    // ==================== STATS ====================
    if (path === '/stats' && req.method === 'GET') {
      const [
        { count: totalAccounts },
        { count: activeAccounts },
        { count: totalProxies },
        { count: activeProxies },
        { count: runningCampaigns },
        { count: pendingMessages },
        { count: totalConversations },
      ] = await Promise.all([
        supabase.from('telegram_accounts').select('*', { count: 'exact', head: true }),
        supabase.from('telegram_accounts').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('proxies').select('*', { count: 'exact', head: true }),
        supabase.from('proxies').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('campaigns').select('*', { count: 'exact', head: true }).eq('status', 'running'),
        supabase.from('messages').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('conversations').select('*', { count: 'exact', head: true }),
      ]);

      // Get runner status
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: runners } = await supabase
        .from('runner_heartbeats')
        .select('runner_name, status, last_seen')
        .order('last_seen', { ascending: false });

      return jsonResponse({
        accounts: { total: totalAccounts || 0, active: activeAccounts || 0 },
        proxies: { total: totalProxies || 0, active: activeProxies || 0 },
        campaigns: { running: runningCampaigns || 0 },
        messages: { pending: pendingMessages || 0 },
        conversations: { total: totalConversations || 0 },
        runners: runners || [],
      });
    }

    return jsonResponse({ error: 'Not found', path }, 404);

  } catch (error) {
    console.error('[utilities] Error:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
