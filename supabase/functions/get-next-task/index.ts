import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LIVE_CONVERSATION_TIMEOUT_MINUTES = 5;

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
    const { account_id } = body;

    console.log(`[get-next-task] Request for account: ${account_id || 'any'}`);

    // Reset any messages stuck in "sending" status for more than 2 minutes (Python may have crashed)
    const sendingCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuckMessages } = await supabase
      .from("messages")
      .update({ status: "pending" })
      .eq("status", "sending")
      .lt("created_at", sendingCutoff)
      .select("id");
    
    if (stuckMessages && stuckMessages.length > 0) {
      console.log(`[get-next-task] Reset ${stuckMessages.length} stuck messages`);
    }

    // Get all active accounts
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("*")
      .eq("status", "active");

    if (accountsError) {
      console.error("[get-next-task] Error fetching accounts:", accountsError);
      return new Response(JSON.stringify({ task: "wait", seconds: 5, reason: "Database error" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!accounts || accounts.length === 0) {
      console.log("[get-next-task] No active accounts");
      return new Response(JSON.stringify({ task: "wait", seconds: 30, reason: "No active accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get live conversation IDs (conversations with incoming messages in last 5 minutes)
    const cutoff = new Date(Date.now() - LIVE_CONVERSATION_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    const { data: liveMessages } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("direction", "incoming")
      .gte("created_at", cutoff);

    const liveConvIds = new Set((liveMessages || []).map((m: { conversation_id: string }) => m.conversation_id));
    console.log(`[get-next-task] Live conversations: ${liveConvIds.size}`);

    // Priority 1: Live chat messages (instant delivery for active conversations)
    if (liveConvIds.size > 0) {
      const { data: liveMessages } = await supabase
        .from("messages")
        .select("*, conversations(*)")
        .eq("status", "pending")
        .eq("direction", "outgoing")
        .in("conversation_id", Array.from(liveConvIds))
        .limit(1);

      if (liveMessages && liveMessages.length > 0) {
        const msg = liveMessages[0];
        const conv = msg.conversations || {};
        const account = accounts.find((a: { id: string }) => a.id === msg.account_id);

        if (account) {
          // Mark message as "sending" to prevent duplicate tasks
          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id)
            .eq("status", "pending"); // Only update if still pending (avoid race)

          console.log(`[get-next-task] Live chat task: message ${msg.id.slice(0, 8)}`);
          return new Response(JSON.stringify({
            task: "send",
            message: {
              id: msg.id,
              content: msg.content,
              media_url: msg.media_url,
              media_type: msg.media_type,
              campaign_recipient_id: msg.campaign_recipient_id,
            },
            recipient: conv.recipient_username || conv.recipient_phone,
            account: {
              id: account.id,
              phone_number: account.phone_number,
              session_data: account.session_data,
            },
            mode: "live",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Priority 2: Campaign messages (controlled intervals)
    const { data: campaignMessages } = await supabase
      .from("messages")
      .select("*, conversations(*), campaign_recipients(campaign_id)")
      .eq("status", "pending")
      .eq("direction", "outgoing")
      .limit(50);

    if (campaignMessages && campaignMessages.length > 0) {
      // Filter out:
      // 1. Live conversations (handled above)
      // 2. Orphaned campaign messages (campaign was deleted)
      for (const msg of campaignMessages) {
        // Skip live conversations
        if (liveConvIds.has(msg.conversation_id)) {
          continue;
        }

        const conv = msg.conversations || {};
        const campaignRecipientId = msg.campaign_recipient_id;

        // Skip orphaned campaign messages
        if (!campaignRecipientId) {
          // No campaign link - check if it's an orphaned first-contact message
          if (!conv.is_active && !conv.recipient_telegram_id) {
            console.log(`[get-next-task] Skipping orphaned message ${msg.id.slice(0, 8)}`);
            // Auto-cancel orphaned messages
            await supabase
              .from("messages")
              .update({ status: "cancelled", failed_reason: "Campaign deleted" })
              .eq("id", msg.id);
            continue;
          }
        } else {
          // Has campaign_recipient_id - verify campaign still exists
          const campaignRecipient = msg.campaign_recipients;
          if (!campaignRecipient || !campaignRecipient.campaign_id) {
            console.log(`[get-next-task] Skipping message ${msg.id.slice(0, 8)} (campaign recipient deleted)`);
            await supabase
              .from("messages")
              .update({ status: "cancelled", failed_reason: "Campaign recipient deleted" })
              .eq("id", msg.id);
            continue;
          }
        }

        // Find the account for this message
        const account = accounts.find((a: { id: string }) => a.id === msg.account_id);
        if (!account) {
          console.log(`[get-next-task] No account found for message ${msg.id.slice(0, 8)}`);
          continue;
        }

        // Check daily limit
        if ((account.messages_sent_today || 0) >= (account.daily_limit || 25)) {
          console.log(`[get-next-task] Account ${account.phone_number} at daily limit`);
          continue;
        }

        // Mark message as "sending" to prevent duplicate tasks
        await supabase
          .from("messages")
          .update({ status: "sending" })
          .eq("id", msg.id)
          .eq("status", "pending"); // Only update if still pending

        console.log(`[get-next-task] Campaign task: message ${msg.id.slice(0, 8)}`);
        return new Response(JSON.stringify({
          task: "send",
          message: {
            id: msg.id,
            content: msg.content,
            media_url: msg.media_url,
            media_type: msg.media_type,
            campaign_recipient_id: msg.campaign_recipient_id,
          },
          recipient: conv.recipient_username || conv.recipient_phone,
          account: {
            id: account.id,
            phone_number: account.phone_number,
            session_data: account.session_data,
          },
          mode: "campaign",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Priority 3: Validate recipients
    const { data: validatingRecipients } = await supabase
      .from("campaign_recipients")
      .select("*")
      .eq("status", "validating")
      .limit(10);

    if (validatingRecipients && validatingRecipients.length > 0) {
      // Get first available account for validation
      const account = accounts[0];
      console.log(`[get-next-task] Validate task: ${validatingRecipients.length} recipients`);
      return new Response(JSON.stringify({
        task: "validate",
        recipients: validatingRecipients.map((r: { id: string; phone_number: string; name: string | null }) => ({
          id: r.id,
          phone_number: r.phone_number,
          name: r.name,
        })),
        account: {
          id: account.id,
          phone_number: account.phone_number,
          session_data: account.session_data,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Priority 4: SpamBot check tasks
    const { data: checkTasks } = await supabase
      .from("account_check_tasks")
      .select("*, telegram_accounts(*)")
      .eq("status", "pending")
      .eq("task_type", "spambot_check")
      .limit(1);

    if (checkTasks && checkTasks.length > 0) {
      const task = checkTasks[0];
      const accountData = task.telegram_accounts;

      if (accountData) {
        // Check 96-hour cooldown
        const lastCheck = accountData.last_spambot_check;
        if (lastCheck) {
          const hoursSinceCheck = (Date.now() - new Date(lastCheck).getTime()) / (1000 * 60 * 60);
          if (hoursSinceCheck < 96) {
            console.log(`[get-next-task] SpamBot check skipped: ${hoursSinceCheck.toFixed(1)}h since last check`);
            await supabase
              .from("account_check_tasks")
              .update({
                status: "skipped",
                result: `Already checked ${hoursSinceCheck.toFixed(1)} hours ago. Cooldown is 96 hours.`,
                completed_at: new Date().toISOString(),
              })
              .eq("id", task.id);
          } else {
            console.log(`[get-next-task] SpamBot check task for account ${task.account_id}`);
            return new Response(JSON.stringify({
              task: "spambot_check",
              task_id: task.id,
              account: {
                id: accountData.id,
                phone_number: accountData.phone_number,
                session_data: accountData.session_data,
              },
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } else {
          // Never checked before
          console.log(`[get-next-task] SpamBot check task for account ${task.account_id}`);
          return new Response(JSON.stringify({
            task: "spambot_check",
            task_id: task.id,
            account: {
              id: accountData.id,
              phone_number: accountData.phone_number,
              session_data: accountData.session_data,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // No tasks - tell Python to wait briefly and check for incoming messages
    return new Response(JSON.stringify({
      task: "wait",
      seconds: 0.3,
      accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
        id: a.id,
        phone_number: a.phone_number,
        session_data: a.session_data,
      })),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[get-next-task] Error:", errMsg);
    return new Response(JSON.stringify({ task: "wait", seconds: 5, reason: `Error: ${errMsg}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
