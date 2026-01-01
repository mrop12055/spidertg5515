import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Minimum hours between SpamBot checks per account
const CHECK_COOLDOWN_HOURS = 96; // 4 days

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    console.log("[auto-spambot-check] Starting automatic SpamBot check scheduling");

    const now = new Date();
    const cooldownCutoff = new Date(now.getTime() - CHECK_COOLDOWN_HOURS * 60 * 60 * 1000);

    // Get all active accounts that haven't been checked recently
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, last_spambot_check, spambot_status")
      .eq("status", "active")
      .or(`last_spambot_check.is.null,last_spambot_check.lt.${cooldownCutoff.toISOString()}`);

    if (accountsError) {
      throw accountsError;
    }

    if (!accounts || accounts.length === 0) {
      console.log("[auto-spambot-check] No accounts need checking");
      return new Response(JSON.stringify({
        success: true,
        message: "No accounts need SpamBot check",
        scheduled: 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[auto-spambot-check] Found ${accounts.length} accounts needing check`);

    // Check for existing pending SpamBot tasks
    const { data: existingTasks } = await supabase
      .from("account_check_tasks")
      .select("account_id")
      .eq("task_type", "spambot_check")
      .eq("status", "pending");

    const existingAccountIds = new Set((existingTasks || []).map((t: { account_id: string }) => t.account_id));

    // Filter out accounts that already have pending tasks
    const accountsToCheck = accounts.filter((a: { id: string }) => !existingAccountIds.has(a.id));

    if (accountsToCheck.length === 0) {
      console.log("[auto-spambot-check] All accounts already have pending tasks");
      return new Response(JSON.stringify({
        success: true,
        message: "All accounts already have pending SpamBot checks",
        scheduled: 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create SpamBot check tasks - spread them out over time to avoid rate limits
    const tasks = accountsToCheck.map((account: { id: string; phone_number: string }, index: number) => ({
      account_id: account.id,
      task_type: "spambot_check",
      status: "pending",
      created_at: new Date(now.getTime() + index * 30 * 1000).toISOString(), // Stagger by 30 seconds each
    }));

    const { error: insertError } = await supabase
      .from("account_check_tasks")
      .insert(tasks);

    if (insertError) {
      throw insertError;
    }

    console.log(`[auto-spambot-check] Scheduled ${tasks.length} SpamBot checks`);

    // Check for any previously restricted accounts that should be alerted
    const { data: restrictedAccounts } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, spambot_status, ban_reason")
      .in("spambot_status", ["limited", "restricted"]);

    const restrictedCount = restrictedAccounts?.length || 0;

    // Log alert for restricted accounts
    if (restrictedCount > 0) {
      console.log(`[auto-spambot-check] ALERT: ${restrictedCount} accounts are restricted/limited`);
      
      // Store alert in a simple way - could be expanded to send notifications
      for (const acc of restrictedAccounts || []) {
        console.log(`  - ${acc.phone_number}: ${acc.spambot_status} - ${acc.ban_reason || 'No reason'}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Scheduled ${tasks.length} SpamBot checks`,
      scheduled: tasks.length,
      total_accounts: accounts.length,
      already_pending: existingAccountIds.size,
      restricted_accounts: restrictedCount,
      restricted_details: restrictedAccounts?.map((a: { phone_number: string; spambot_status: string }) => ({
        phone: a.phone_number,
        status: a.spambot_status,
      })) || [],
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[auto-spambot-check] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
