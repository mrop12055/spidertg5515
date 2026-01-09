import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Switch Account Proxy
 * 
 * When a proxy times out, this function:
 * 1. Finds an available active proxy not assigned to this account
 * 2. Updates the account's proxy_id
 * 3. Returns the new proxy details for immediate use
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json().catch(() => ({}));
    const { account_id, old_proxy_id } = body;

    if (!account_id) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: "account_id required" 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[switch-account-proxy] Finding new proxy for account ${account_id}`);

    // Get current account info
    const { data: account, error: accountError } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, proxy_id")
      .eq("id", account_id)
      .single();

    if (accountError || !account) {
      console.log(`[switch-account-proxy] Account not found: ${account_id}`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: "Account not found" 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currentProxyId = old_proxy_id || account.proxy_id;

    // Find available active proxies not currently assigned to this account
    // Prefer proxies that are not assigned to any account (unassigned_first)
    const { data: availableProxies, error: proxyError } = await supabase
      .from("proxies")
      .select("id, host, port, username, password, proxy_type, assigned_account_id")
      .eq("status", "active")
      .neq("id", currentProxyId || "00000000-0000-0000-0000-000000000000")
      .order("assigned_account_id", { ascending: true, nullsFirst: true }) // Unassigned first
      .limit(10);

    if (proxyError) {
      console.log(`[switch-account-proxy] Error fetching proxies: ${proxyError.message}`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: "Failed to fetch proxies" 
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!availableProxies || availableProxies.length === 0) {
      console.log(`[switch-account-proxy] No available proxies found`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: "No available proxies" 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pick the first available (preferring unassigned)
    const newProxy = availableProxies[0];
    console.log(`[switch-account-proxy] Selected new proxy: ${newProxy.host}:${newProxy.port}`);

    // Update account's proxy_id
    const { error: updateError } = await supabase
      .from("telegram_accounts")
      .update({ proxy_id: newProxy.id })
      .eq("id", account_id);

    if (updateError) {
      console.log(`[switch-account-proxy] Failed to update account: ${updateError.message}`);
      return new Response(JSON.stringify({ 
        success: false, 
        error: "Failed to update account proxy" 
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Also update proxy assignment
    await supabase
      .from("proxies")
      .update({ assigned_account_id: account_id })
      .eq("id", newProxy.id);

    // Clear old proxy assignment if it was assigned to this account
    if (currentProxyId) {
      await supabase
        .from("proxies")
        .update({ assigned_account_id: null })
        .eq("id", currentProxyId)
        .eq("assigned_account_id", account_id);
    }

    console.log(`[switch-account-proxy] Successfully switched account ${account.phone_number} to proxy ${newProxy.host}:${newProxy.port}`);

    return new Response(JSON.stringify({
      success: true,
      new_proxy: {
        id: newProxy.id,
        host: newProxy.host,
        port: newProxy.port,
        username: newProxy.username,
        password: newProxy.password,
        proxy_type: newProxy.proxy_type,
        type: newProxy.proxy_type,
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error(`[switch-account-proxy] Error:`, error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
