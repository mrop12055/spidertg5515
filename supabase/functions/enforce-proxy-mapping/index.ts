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

    console.log("[enforce-proxy-mapping] Starting 1:1 proxy-account mapping enforcement");

    // Get all active accounts and their proxy assignments
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, phone_country, proxy_id, geo_mismatch")
      .eq("status", "active");

    if (accountsError) throw accountsError;

    // Get all available proxies
    const { data: proxies, error: proxiesError } = await supabase
      .from("proxies")
      .select("id, host, port, detected_country, assigned_account_id, status")
      .eq("status", "active");

    if (proxiesError) throw proxiesError;

    console.log(`[enforce-proxy-mapping] Found ${accounts?.length || 0} accounts, ${proxies?.length || 0} proxies`);

    const stats = {
      accounts_without_proxy: 0,
      accounts_with_proxy: 0,
      proxies_available: 0,
      assignments_made: 0,
      geo_matches_found: 0,
      violations: [] as { account_id: string; phone: string; issue: string }[],
    };

    // Build proxy assignment map
    const proxyAssignments = new Map<string, string>();
    const availableProxies: typeof proxies = [];

    if (proxies) {
      for (const proxy of proxies) {
        if (proxy.assigned_account_id) {
          proxyAssignments.set(proxy.id, proxy.assigned_account_id);
        } else {
          availableProxies.push(proxy);
        }
      }
    }

    stats.proxies_available = availableProxies.length;

    // Check each account
    if (accounts) {
      for (const account of accounts) {
        if (account.proxy_id) {
          stats.accounts_with_proxy++;
          
          // Check if this proxy is shared with another account
          const proxyOwner = proxyAssignments.get(account.proxy_id);
          if (proxyOwner && proxyOwner !== account.id) {
            stats.violations.push({
              account_id: account.id,
              phone: account.phone_number,
              issue: "Proxy shared with another account",
            });
          }
        } else {
          stats.accounts_without_proxy++;
          
          // Try to assign a proxy, preferring geo-matched ones
          let bestProxy = null;
          
          if (account.phone_country) {
            // First try to find a geo-matched proxy
            bestProxy = availableProxies.find(p => 
              p.detected_country === account.phone_country
            );
            
            if (bestProxy) {
              stats.geo_matches_found++;
            }
          }
          
          // If no geo-matched proxy, take any available one
          if (!bestProxy && availableProxies.length > 0) {
            bestProxy = availableProxies[0];
          }
          
          if (bestProxy) {
            // Assign the proxy
            const geoMatch = bestProxy.detected_country === account.phone_country;
            
            await supabase
              .from("telegram_accounts")
              .update({ 
                proxy_id: bestProxy.id,
                geo_mismatch: !geoMatch && !!account.phone_country && !!bestProxy.detected_country,
              })
              .eq("id", account.id);
            
            await supabase
              .from("proxies")
              .update({ assigned_account_id: account.id })
              .eq("id", bestProxy.id);
            
            // Remove from available pool
            const idx = availableProxies.findIndex(p => p.id === bestProxy!.id);
            if (idx > -1) availableProxies.splice(idx, 1);
            
            stats.assignments_made++;
            console.log(`[enforce-proxy-mapping] Assigned proxy ${bestProxy.host} to ${account.phone_number} (geo-match: ${geoMatch})`);
          } else {
            stats.violations.push({
              account_id: account.id,
              phone: account.phone_number,
              issue: "No available proxy",
            });
          }
        }
      }
    }

    // Check for duplicate proxy assignments
    const { data: duplicates } = await supabase
      .from("telegram_accounts")
      .select("proxy_id")
      .eq("status", "active")
      .not("proxy_id", "is", null);

    if (duplicates) {
      const proxyCounts = new Map<string, number>();
      for (const acc of duplicates) {
        const count = proxyCounts.get(acc.proxy_id) || 0;
        proxyCounts.set(acc.proxy_id, count + 1);
      }
      
      for (const [proxyId, count] of proxyCounts) {
        if (count > 1) {
          stats.violations.push({
            account_id: proxyId,
            phone: "N/A",
            issue: `Proxy ${proxyId} is shared by ${count} accounts`,
          });
        }
      }
    }

    console.log(`[enforce-proxy-mapping] Completed. Assignments: ${stats.assignments_made}, Violations: ${stats.violations.length}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Enforced 1:1 proxy mapping`,
      stats,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[enforce-proxy-mapping] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
