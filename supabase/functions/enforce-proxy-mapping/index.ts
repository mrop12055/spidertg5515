import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

    console.log("[enforce-proxy-mapping] Starting FAST proxy-account distribution");
    const startTime = Date.now();

    // Get all active accounts and proxies in parallel
    const [accountsResult, proxiesResult] = await Promise.all([
      supabase
        .from("telegram_accounts")
        .select("id, phone_number, phone_country, proxy_id")
        .in("status", ["active", "restricted", "cooldown"]),
      supabase
        .from("proxies")
        .select("id, host, detected_country")
        .eq("status", "active")
    ]);

    if (accountsResult.error) throw accountsResult.error;
    if (proxiesResult.error) throw proxiesResult.error;

    const accounts = accountsResult.data || [];
    const proxies = proxiesResult.data || [];
    const totalAccounts = accounts.length;
    const totalProxies = proxies.length;
    
    console.log(`[enforce-proxy-mapping] Found ${totalAccounts} accounts, ${totalProxies} proxies (${Date.now() - startTime}ms)`);

    if (totalAccounts === 0 || totalProxies === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "No accounts or proxies to distribute",
        stats: { total_accounts: totalAccounts, total_proxies: totalProxies },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 1: Clear all existing assignments in parallel (single query each)
    console.log("[enforce-proxy-mapping] Clearing existing assignments...");
    await Promise.all([
      supabase
        .from("telegram_accounts")
        .update({ proxy_id: null, geo_mismatch: null })
        .in("status", ["active", "restricted", "cooldown"]),
      supabase
        .from("proxies")
        .update({ assigned_account_id: null })
        .eq("status", "active")
    ]);
    console.log(`[enforce-proxy-mapping] Cleared assignments (${Date.now() - startTime}ms)`);

    // Step 2: Shuffle and calculate distribution
    const shuffledAccounts = [...accounts].sort(() => Math.random() - 0.5);
    const shuffledProxies = [...proxies].sort(() => Math.random() - 0.5);
    const baseAccountsPerProxy = Math.floor(totalAccounts / totalProxies);
    const extraAccounts = totalAccounts % totalProxies;

    // Step 3: Build assignment maps - group by proxy for MEGA batch updates
    // Key insight: Instead of updating accounts one proxy at a time,
    // we build a map of account_id -> {proxy_id, geo_mismatch} and do bulk updates
    const accountUpdates: Array<{ id: string; proxy_id: string; geo_mismatch: boolean }> = [];
    const proxyFirstAccount: Map<string, string> = new Map();
    
    let accountIndex = 0;
    let geoMatches = 0;

    for (let proxyIdx = 0; proxyIdx < shuffledProxies.length; proxyIdx++) {
      const proxy = shuffledProxies[proxyIdx];
      const targetCount = baseAccountsPerProxy + (proxyIdx < extraAccounts ? 1 : 0);
      
      if (targetCount === 0) continue;
      
      for (let i = 0; i < targetCount && accountIndex < shuffledAccounts.length; i++) {
        const account = shuffledAccounts[accountIndex++];
        
        // Check geo-match
        const geoMatch = proxy.detected_country === account.phone_country;
        const geo_mismatch = !!(account.phone_country && proxy.detected_country && !geoMatch);
        if (geoMatch) geoMatches++;
        
        accountUpdates.push({
          id: account.id,
          proxy_id: proxy.id,
          geo_mismatch
        });
        
        // Track first account for each proxy
        if (!proxyFirstAccount.has(proxy.id)) {
          proxyFirstAccount.set(proxy.id, account.id);
        }
      }
    }

    console.log(`[enforce-proxy-mapping] Built ${accountUpdates.length} account updates (${Date.now() - startTime}ms)`);

    // Step 4: Execute MEGA batch updates - group accounts by proxy_id and geo_mismatch
    // This reduces hundreds of queries to just a handful
    const groupedUpdates = new Map<string, string[]>(); // "proxy_id:geo_mismatch" -> account_ids
    
    for (const upd of accountUpdates) {
      const key = `${upd.proxy_id}:${upd.geo_mismatch}`;
      if (!groupedUpdates.has(key)) {
        groupedUpdates.set(key, []);
      }
      groupedUpdates.get(key)!.push(upd.id);
    }

    console.log(`[enforce-proxy-mapping] Grouped into ${groupedUpdates.size} batch updates (${Date.now() - startTime}ms)`);

    // Execute account updates - batch of 200 accounts per update for speed
    const ACCOUNT_BATCH_SIZE = 200;
    // deno-lint-ignore no-explicit-any
    const accountUpdatePromises: PromiseLike<any>[] = [];
    
    for (const [key, accountIds] of groupedUpdates) {
      const [proxy_id, geo_mismatch_str] = key.split(':');
      const geo_mismatch = geo_mismatch_str === 'true';
      
      // Split into sub-batches if needed
      for (let i = 0; i < accountIds.length; i += ACCOUNT_BATCH_SIZE) {
        const batch = accountIds.slice(i, i + ACCOUNT_BATCH_SIZE);
        accountUpdatePromises.push(
          supabase
            .from("telegram_accounts")
            .update({ proxy_id, geo_mismatch })
            .in("id", batch)
        );
      }
    }

    // Execute proxy updates - set first assigned account
    // deno-lint-ignore no-explicit-any
    const proxyUpdatePromises: PromiseLike<any>[] = [];
    const PROXY_BATCH_SIZE = 100;
    const proxyEntries = Array.from(proxyFirstAccount.entries());
    
    for (let i = 0; i < proxyEntries.length; i += PROXY_BATCH_SIZE) {
      const batch = proxyEntries.slice(i, i + PROXY_BATCH_SIZE);
      // Update each proxy in the batch in parallel
      for (const [proxyId, accountId] of batch) {
        proxyUpdatePromises.push(
          supabase
            .from("proxies")
            .update({ assigned_account_id: accountId })
            .eq("id", proxyId)
        );
      }
    }

    // Execute all updates in parallel
    console.log(`[enforce-proxy-mapping] Executing ${accountUpdatePromises.length} account batches + ${proxyUpdatePromises.length} proxy updates...`);
    
    await Promise.all([...accountUpdatePromises, ...proxyUpdatePromises]);
    
    const elapsed = Date.now() - startTime;
    console.log(`[enforce-proxy-mapping] COMPLETED in ${elapsed}ms. ${accountUpdates.length} assignments, ${geoMatches} geo-matches`);

    // Generate distribution summary
    const proxyCounts = new Map<string, number>();
    for (const upd of accountUpdates) {
      proxyCounts.set(upd.proxy_id, (proxyCounts.get(upd.proxy_id) || 0) + 1);
    }
    const distribution = Array.from(proxyCounts.values());
    const with1 = distribution.filter(c => c === 1).length;
    const with2 = distribution.filter(c => c === 2).length;
    const withMore = distribution.filter(c => c > 2).length;

    return new Response(JSON.stringify({
      success: true,
      message: `Fast distribution completed in ${elapsed}ms: ${accountUpdates.length} assignments`,
      stats: {
        total_accounts: totalAccounts,
        total_proxies: totalProxies,
        assignments_made: accountUpdates.length,
        geo_matches_found: geoMatches,
        elapsed_ms: elapsed,
        distribution_summary: `${with1} proxies with 1 account, ${with2} with 2${withMore > 0 ? `, ${withMore} with 3+` : ""}`,
      },
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
