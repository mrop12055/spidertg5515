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

    const { account_id } = await req.json();

    if (!account_id) {
      return new Response(JSON.stringify({ error: "account_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[get-fallback-proxy] Finding fallback proxy for account ${account_id}`);

    // Get the account's current proxy to exclude it
    const { data: account } = await supabase
      .from("telegram_accounts")
      .select("proxy_id, phone_country")
      .eq("id", account_id)
      .single();

    // Find an available active proxy that's not assigned to this account
    // Prefer proxies matching the account's phone country if available
    let query = supabase
      .from("proxies")
      .select("*")
      .eq("status", "active");

    if (account?.proxy_id) {
      query = query.neq("id", account.proxy_id);
    }

    const { data: availableProxies, error } = await query.limit(10);

    if (error || !availableProxies || availableProxies.length === 0) {
      console.log("[get-fallback-proxy] No available proxies found");
      return new Response(JSON.stringify({ proxy: null, reason: "No available proxies" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sort by preference: same country first, then by response time
    let sortedProxies = availableProxies;
    if (account?.phone_country) {
      sortedProxies = availableProxies.sort((a: any, b: any) => {
        const aMatch = (a.country === account.phone_country || a.detected_country === account.phone_country) ? 0 : 1;
        const bMatch = (b.country === account.phone_country || b.detected_country === account.phone_country) ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return (a.response_time || 9999) - (b.response_time || 9999);
      });
    }

    const selectedProxy = sortedProxies[0];

    console.log(`[get-fallback-proxy] Selected fallback proxy: ${selectedProxy.host}:${selectedProxy.port}`);

    // Optionally update the account to use this new proxy
    await supabase
      .from("telegram_accounts")
      .update({ proxy_id: selectedProxy.id })
      .eq("id", account_id);

    return new Response(JSON.stringify({
      proxy: {
        id: selectedProxy.id,
        host: selectedProxy.host,
        port: selectedProxy.port,
        username: selectedProxy.username,
        password: selectedProxy.password,
        proxy_type: selectedProxy.proxy_type,
        type: selectedProxy.proxy_type,
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[get-fallback-proxy] Error:", errorMessage);
    return new Response(JSON.stringify({ proxy: null, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
