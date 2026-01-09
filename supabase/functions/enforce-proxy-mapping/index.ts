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

    console.log("[enforce-proxy-mapping] Starting smart proxy-account distribution");

    // Get all active accounts and their proxy assignments
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, phone_country, proxy_id, geo_mismatch")
      .in("status", ["active", "restricted", "cooldown"]);

    if (accountsError) throw accountsError;

    // Get all available proxies
    const { data: proxies, error: proxiesError } = await supabase
      .from("proxies")
      .select("id, host, port, detected_country, assigned_account_id, status")
      .eq("status", "active");

    if (proxiesError) throw proxiesError;

    const totalAccounts = accounts?.length || 0;
    const totalProxies = proxies?.length || 0;
    
    console.log(`[enforce-proxy-mapping] Found ${totalAccounts} accounts, ${totalProxies} proxies`);

    const stats = {
      total_accounts: totalAccounts,
      total_proxies: totalProxies,
      assignments_made: 0,
      geo_matches_found: 0,
      accounts_per_proxy: {} as Record<string, number>,
      distribution_summary: "",
    };

    if (!accounts || accounts.length === 0 || !proxies || proxies.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "No accounts or proxies to distribute",
        stats,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 1: Clear all existing proxy assignments for a fresh distribution
    console.log("[enforce-proxy-mapping] Clearing existing assignments for fresh distribution...");
    
    await supabase
      .from("telegram_accounts")
      .update({ proxy_id: null, geo_mismatch: null })
      .in("status", ["active", "restricted", "cooldown"]);
    
    await supabase
      .from("proxies")
      .update({ assigned_account_id: null })
      .eq("status", "active");

    // Step 2: Shuffle accounts randomly for fair distribution
    const shuffledAccounts = [...accounts].sort(() => Math.random() - 0.5);
    
    // Step 3: Calculate distribution
    // If 100 proxies and 110 accounts: each proxy gets 1, then 10 random proxies get 1 more
    const baseAccountsPerProxy = Math.floor(totalAccounts / totalProxies);
    const extraAccounts = totalAccounts % totalProxies;
    
    console.log(`[enforce-proxy-mapping] Distribution plan: ${baseAccountsPerProxy} accounts/proxy base, ${extraAccounts} proxies will get +1 extra`);
    
    // Shuffle proxies too for randomness
    const shuffledProxies = [...proxies].sort(() => Math.random() - 0.5);
    
    // Step 4: Create distribution map - which proxies get extra accounts
    const proxyDistribution = shuffledProxies.map((proxy, index) => ({
      proxy,
      targetCount: baseAccountsPerProxy + (index < extraAccounts ? 1 : 0),
    }));
    
    // Step 5: Build assignment plan (group accounts by proxy for batch updates)
    let accountIndex = 0;
    const assignmentPlan: Map<string, { 
      proxy: typeof proxies[0], 
      accountIds: string[], 
      geoMatchIds: string[],
      geoMismatchIds: string[],
      firstAccountId: string | null 
    }> = new Map();
    
    for (const { proxy, targetCount } of proxyDistribution) {
      if (targetCount === 0) continue;
      
      const accountIds: string[] = [];
      const geoMatchIds: string[] = [];
      const geoMismatchIds: string[] = [];
      let firstAccountId: string | null = null;
      
      for (let i = 0; i < targetCount && accountIndex < shuffledAccounts.length; i++) {
        const account = shuffledAccounts[accountIndex];
        accountIndex++;
        
        accountIds.push(account.id);
        if (!firstAccountId) firstAccountId = account.id;
        
        // Check for geo-match
        const geoMatch = proxy.detected_country === account.phone_country;
        if (geoMatch) {
          stats.geo_matches_found++;
          geoMatchIds.push(account.id);
        } else if (account.phone_country && proxy.detected_country) {
          geoMismatchIds.push(account.id);
        } else {
          geoMatchIds.push(account.id); // No country data = no mismatch
        }
        
        stats.assignments_made++;
      }
      
      if (accountIds.length > 0) {
        assignmentPlan.set(proxy.id, { proxy, accountIds, geoMatchIds, geoMismatchIds, firstAccountId });
        stats.accounts_per_proxy[proxy.host] = accountIds.length;
      }
    }
    
    // Step 6: Execute batch updates IN PARALLEL (much faster!)
    console.log(`[enforce-proxy-mapping] Executing ${assignmentPlan.size} batch updates in parallel...`);
    
    // Build all update functions - using 'any' to avoid Supabase type issues
    // deno-lint-ignore no-explicit-any
    const updateFns: (() => PromiseLike<any>)[] = [];
    
    for (const [proxyId, { geoMatchIds, geoMismatchIds, firstAccountId }] of assignmentPlan) {
      // Batch update accounts with geo-match (no mismatch flag)
      if (geoMatchIds.length > 0) {
        updateFns.push(() =>
          supabase
            .from("telegram_accounts")
            .update({ proxy_id: proxyId, geo_mismatch: false })
            .in("id", geoMatchIds)
        );
      }
      
      // Batch update accounts with geo-mismatch
      if (geoMismatchIds.length > 0) {
        updateFns.push(() =>
          supabase
            .from("telegram_accounts")
            .update({ proxy_id: proxyId, geo_mismatch: true })
            .in("id", geoMismatchIds)
        );
      }
      
      // Update proxy with first assigned account
      updateFns.push(() =>
        supabase
          .from("proxies")
          .update({ assigned_account_id: firstAccountId })
          .eq("id", proxyId)
      );
    }
    
    // Execute all updates in parallel batches of 50 to avoid overwhelming the DB
    const BATCH_SIZE = 50;
    for (let i = 0; i < updateFns.length; i += BATCH_SIZE) {
      const batch = updateFns.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(fn => fn()));
    }
    
    console.log(`[enforce-proxy-mapping] All ${updateFns.length} updates completed in parallel batches`);

    // Generate distribution summary
    const distribution = Object.values(stats.accounts_per_proxy);
    const with1 = distribution.filter(c => c === 1).length;
    const with2 = distribution.filter(c => c === 2).length;
    const withMore = distribution.filter(c => c > 2).length;
    
    stats.distribution_summary = `${with1} proxies with 1 account, ${with2} proxies with 2 accounts${withMore > 0 ? `, ${withMore} proxies with 3+ accounts` : ""}`;

    console.log(`[enforce-proxy-mapping] Completed. Assignments: ${stats.assignments_made}, Distribution: ${stats.distribution_summary}`);

    return new Response(JSON.stringify({
      success: true,
      message: `Smart proxy distribution completed: ${stats.assignments_made} assignments, ${stats.distribution_summary}`,
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
