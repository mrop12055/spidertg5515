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
    const proxyDistribution: { proxy: typeof proxies[0]; targetCount: number }[] = shuffledProxies.map((proxy, index) => ({
      proxy,
      targetCount: baseAccountsPerProxy + (index < extraAccounts ? 1 : 0),
    }));
    
    // Step 5: Assign accounts to proxies
    let accountIndex = 0;
    
    for (const { proxy, targetCount } of proxyDistribution) {
      if (targetCount === 0) continue;
      
      const assignedAccounts: string[] = [];
      
      for (let i = 0; i < targetCount && accountIndex < shuffledAccounts.length; i++) {
        const account = shuffledAccounts[accountIndex];
        accountIndex++;
        
        // Check for geo-match
        const geoMatch = proxy.detected_country === account.phone_country;
        if (geoMatch) stats.geo_matches_found++;
        
        // Update account with proxy
        await supabase
          .from("telegram_accounts")
          .update({ 
            proxy_id: proxy.id,
            geo_mismatch: !geoMatch && !!account.phone_country && !!proxy.detected_country,
          })
          .eq("id", account.id);
        
        assignedAccounts.push(account.phone_number);
        stats.assignments_made++;
      }
      
      // Update proxy with first assigned account (for backwards compatibility)
      if (assignedAccounts.length > 0) {
        const firstAccount = shuffledAccounts.find(a => a.phone_number === assignedAccounts[0]);
        await supabase
          .from("proxies")
          .update({ assigned_account_id: firstAccount?.id || null })
          .eq("id", proxy.id);
      }
      
      stats.accounts_per_proxy[proxy.host] = assignedAccounts.length;
      
      if (assignedAccounts.length > 0) {
        console.log(`[enforce-proxy-mapping] Proxy ${proxy.host}: assigned ${assignedAccounts.length} account(s)`);
      }
    }

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
