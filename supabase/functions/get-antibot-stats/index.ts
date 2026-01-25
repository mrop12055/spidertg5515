import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    console.log("[get-antibot-stats] Fetching anti-ban system statistics");

    // Phase 1: Dynamic API System (no stored credentials needed)
    // The system now generates unique api_id + api_hash per request
    const dynamicApiStatus = {
      system: "Dynamic Per-Request API",
      status: "active",
      description: "Each task gets unique api_id (8-digit) + api_hash (32-char hex)",
      capacity: "90M+ unique combinations",
      rate_limits: "None (no API reuse)",
    };

    // Phase 2: Proxy Mapping Stats
    const { data: accounts } = await supabase
      .from("telegram_accounts")
      .select("id, proxy_id, geo_mismatch, warmup_phase, warmup_started_at, spambot_status, status")
      .eq("status", "active");

    const totalAccounts = accounts?.length || 0;
    const accountsWithProxy = accounts?.filter(a => a.proxy_id).length || 0;
    const accountsWithoutProxy = totalAccounts - accountsWithProxy;

    // Get proxy assignment details
    const { data: proxies } = await supabase
      .from("proxies")
      .select("id, assigned_account_id, detected_country, status")
      .eq("status", "active");

    const totalProxies = proxies?.length || 0;
    const assignedProxies = proxies?.filter(p => p.assigned_account_id).length || 0;
    const unassignedProxies = totalProxies - assignedProxies;

    // Check for shared proxies (violations)
    const proxyUsage = new Map<string, number>();
    if (accounts) {
      for (const acc of accounts) {
        if (acc.proxy_id) {
          proxyUsage.set(acc.proxy_id, (proxyUsage.get(acc.proxy_id) || 0) + 1);
        }
      }
    }
    const sharedProxies = Array.from(proxyUsage.values()).filter(count => count > 1).length;

    // Phase 3: Warmup Stats
    const warmupAccounts = accounts?.filter(a => {
      if (!a.warmup_started_at) return false;
      const days = Math.floor((Date.now() - new Date(a.warmup_started_at).getTime()) / (1000 * 60 * 60 * 24));
      return days < 14;
    }).length || 0;
    
    const warmupComplete = accounts?.filter(a => {
      if (!a.warmup_started_at) return false;
      const days = Math.floor((Date.now() - new Date(a.warmup_started_at).getTime()) / (1000 * 60 * 60 * 24));
      return days >= 14;
    }).length || 0;

    // Get pending warmup tasks
    const { count: pendingWarmupTasks } = await supabase
      .from("warmup_schedule")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    // Phase 4: SpamBot Status
    const spamBotClean = accounts?.filter(a => a.spambot_status === "clean").length || 0;
    const spamBotLimited = accounts?.filter(a => a.spambot_status === "limited").length || 0;
    const spamBotRestricted = accounts?.filter(a => a.spambot_status === "restricted").length || 0;
    const spamBotUnknown = accounts?.filter(a => !a.spambot_status || a.spambot_status === "unknown").length || 0;

    // Get pending spambot checks
    const { count: pendingSpamBotChecks } = await supabase
      .from("account_check_tasks")
      .select("id", { count: "exact", head: true })
      .eq("task_type", "spambot_check")
      .eq("status", "pending");

    // Phase 5: First Message Safety (conversations with first_message_sent = false)
    const { count: newContactConversations } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("first_message_sent", false);

    // Phase 6: Geo Mismatch Stats
    const geoMismatches = accounts?.filter(a => a.geo_mismatch).length || 0;
    const geoMatched = accounts?.filter(a => a.proxy_id && !a.geo_mismatch).length || 0;
    const proxiesWithCountry = proxies?.filter(p => p.detected_country).length || 0;

    // Phase 7: Bidirectional Interactions
    const { count: pendingInteractions } = await supabase
      .from("interaction_scheduler")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");

    const { count: completedInteractions } = await supabase
      .from("interaction_scheduler")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed");

    const stats = {
      phase1_api_system: dynamicApiStatus,
      phase2_proxy_mapping: {
        total_accounts: totalAccounts,
        accounts_with_proxy: accountsWithProxy,
        accounts_without_proxy: accountsWithoutProxy,
        total_proxies: totalProxies,
        assigned_proxies: assignedProxies,
        unassigned_proxies: unassignedProxies,
        shared_proxies_violations: sharedProxies,
        mapping_coverage: totalAccounts > 0 
          ? Math.round((accountsWithProxy / totalAccounts) * 100) 
          : 0,
      },
      phase3_warmup: {
        accounts_in_warmup: warmupAccounts,
        accounts_warmup_complete: warmupComplete,
        pending_warmup_tasks: pendingWarmupTasks || 0,
      },
      phase4_spambot: {
        clean: spamBotClean,
        limited: spamBotLimited,
        restricted: spamBotRestricted,
        unknown: spamBotUnknown,
        pending_checks: pendingSpamBotChecks || 0,
      },
      phase5_first_message: {
        new_contact_conversations: newContactConversations || 0,
      },
      phase6_geo_consistency: {
        geo_matched: geoMatched,
        geo_mismatches: geoMismatches,
        proxies_with_country: proxiesWithCountry,
        proxies_without_country: totalProxies - proxiesWithCountry,
        match_rate: accountsWithProxy > 0 
          ? Math.round((geoMatched / accountsWithProxy) * 100) 
          : 0,
      },
      phase7_interactions: {
        pending: pendingInteractions || 0,
        completed: completedInteractions || 0,
      },
    };

    console.log("[get-antibot-stats] Stats fetched successfully");

    return new Response(JSON.stringify({
      success: true,
      stats,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[get-antibot-stats] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
