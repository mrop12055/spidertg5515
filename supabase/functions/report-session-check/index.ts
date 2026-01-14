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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { account_id, success, error, telegram_data } = await req.json();

    if (!account_id) {
      return new Response(
        JSON.stringify({ error: "account_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[report-session-check] Processing account ${account_id}, success: ${success}, error: ${error}`);

    // Determine new status based on result
    let newStatus: string;
    let banReason: string | null = null;

    if (success && telegram_data) {
      // ========== SUCCESS: Account is active ==========
      newStatus = "active";
      
      // Update account with Telegram data from get_me()
      const updateData: any = {
        status: "active",
        ban_reason: null,
        last_active: new Date().toISOString(),
      };

      // Store telegram user data if provided
      if (telegram_data.id) updateData.telegram_id = telegram_data.id;
      if (telegram_data.first_name) updateData.first_name = telegram_data.first_name;
      if (telegram_data.last_name) updateData.last_name = telegram_data.last_name;
      if (telegram_data.username) updateData.username = telegram_data.username;

      const { error: updateError } = await supabase
        .from("telegram_accounts")
        .update(updateData)
        .eq("id", account_id);

      if (updateError) {
        console.error(`[report-session-check] Failed to update account ${account_id}:`, updateError);
        throw updateError;
      }

      console.log(`[report-session-check] Account ${account_id} marked ACTIVE with telegram_id: ${telegram_data.id}`);

    } else if (error) {
      // ========== ERROR: Determine status based on error type ==========
      const errorLower = (error || "").toLowerCase();

      // FROZEN account detection - multiple patterns
      const frozenPatterns = [
        "frozen",
        "frozen account",
        "not available for frozen",
        "account is frozen",
      ];
      const isFrozen = frozenPatterns.some(p => errorLower.includes(p));

      // BANNED/DEACTIVATED account detection
      const bannedPatterns = [
        "userdeactivatederror",
        "user deactivated",
        "deactivated",
        "account deleted",
        "account was deleted",
        "account banned",
        "phone_number_banned",
        "user has been deleted",
        "auth key unregistered", // Session invalidated by Telegram
        "authkeyunregistered",
      ];
      const isBanned = bannedPatterns.some(p => errorLower.includes(p));

      // SESSION EXPIRED/INVALID detection
      const sessionExpiredPatterns = [
        "session expired",
        "session revoked",
        "sessionrevoked",
        "auth key duplicated",
        "authkeyduplicatederror",
        "unauthorized",
        "invalid session",
      ];
      const isSessionExpired = sessionExpiredPatterns.some(p => errorLower.includes(p));

      // RESTRICTED detection (temporary)
      const restrictedPatterns = [
        "restricted",
        "temporarily restricted",
        "flood",
        "too many",
      ];
      const isRestricted = !isFrozen && !isBanned && restrictedPatterns.some(p => errorLower.includes(p));

      // Determine status
      if (isFrozen) {
        newStatus = "frozen";
        banReason = `Frozen account detected: ${error}`;
        console.log(`[report-session-check] Account ${account_id} detected as FROZEN`);
      } else if (isBanned) {
        newStatus = "banned";
        banReason = `Account banned/deleted: ${error}`;
        console.log(`[report-session-check] Account ${account_id} detected as BANNED`);
      } else if (isSessionExpired) {
        newStatus = "disconnected";
        banReason = `Session expired/invalid: ${error}`;
        console.log(`[report-session-check] Account ${account_id} session EXPIRED`);
      } else if (isRestricted) {
        newStatus = "restricted";
        banReason = `Temporarily restricted: ${error}`;
        console.log(`[report-session-check] Account ${account_id} RESTRICTED`);
      } else {
        // Unknown error - mark as disconnected for safety
        newStatus = "disconnected";
        banReason = `Connection error: ${error}`;
        console.log(`[report-session-check] Account ${account_id} DISCONNECTED (unknown error)`);
      }

      // Update account status
      const { error: updateError } = await supabase
        .from("telegram_accounts")
        .update({
          status: newStatus,
          ban_reason: banReason,
          last_active: new Date().toISOString(),
        })
        .eq("id", account_id);

      if (updateError) {
        console.error(`[report-session-check] Failed to update account ${account_id}:`, updateError);
        throw updateError;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        account_id,
        new_status: newStatus!,
        ban_reason: banReason,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[report-session-check] Error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
