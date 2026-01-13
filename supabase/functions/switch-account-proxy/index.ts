import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Report Proxy Error (formerly Switch Account Proxy)
 * 
 * STRICT 1:1 PROXY POLICY - NO AUTO-SWITCHING
 * 
 * When a proxy fails, this function:
 * 1. Marks the proxy status as "error"
 * 2. Logs the error in proxy_errors table
 * 3. Returns failure - admin must manually fix in dashboard
 * 
 * NO proxy switching is performed - all changes must be made by admin.
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
    const { account_id, old_proxy_id, reason } = body;

    if (!account_id) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: "account_id required" 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[switch-account-proxy] PROXY ERROR reported for account ${account_id}`);
    console.log(`[switch-account-proxy] Reason: ${reason || 'Connection failed'}`);
    console.log(`[switch-account-proxy] NOTE: NO auto-switching - admin must fix in dashboard`);

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

    const proxyId = old_proxy_id || account.proxy_id;

    // If there's a proxy, mark it as having an error
    if (proxyId) {
      // Mark proxy status as "error"
      await supabase
        .from("proxies")
        .update({ 
          status: "error",
          last_checked: new Date().toISOString()
        })
        .eq("id", proxyId);

      // Log the error in proxy_errors table
      await supabase
        .from("proxy_errors")
        .insert({
          proxy_id: proxyId,
          error_type: "connection_failed",
          error_message: reason || "Proxy connection failed - reported by runner"
        });

      console.log(`[switch-account-proxy] Marked proxy ${proxyId} as ERROR`);
      console.log(`[switch-account-proxy] Account ${account.phone_number} needs manual proxy reassignment`);
    }

    // Return failure - no auto-switching
    return new Response(JSON.stringify({
      success: false,
      error: "Proxy marked as error. Admin must reassign proxy in dashboard.",
      message: "STRICT 1:1 PROXY POLICY - No automatic proxy switching"
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
