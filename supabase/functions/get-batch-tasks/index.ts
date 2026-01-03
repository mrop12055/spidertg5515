import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Default values (will be overridden by database settings)
let MESSAGE_DELAY_MIN_SECONDS = 5;
let MESSAGE_DELAY_MAX_SECONDS = 15;
let DAILY_MESSAGE_LIMIT = 25;

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
    const { runner, batch_size = 5 } = body;

    console.log(`[get-batch-tasks] Request for runner: ${runner}, batch_size: ${batch_size}`);

    // Record runner heartbeat
    if (runner) {
      await supabase
        .from("runner_heartbeats")
        .upsert({
          runner_name: `${runner}_batch`,
          last_seen: new Date().toISOString(),
          status: 'online'
        }, { onConflict: 'runner_name' });
    }

    // Load settings from database
    const { data: settingsData } = await supabase
      .from("app_settings")
      .select("key, value");

    if (settingsData) {
      for (const setting of settingsData) {
        const value = setting.value as Record<string, unknown>;
        if (setting.key === "message_timing" && value) {
          MESSAGE_DELAY_MIN_SECONDS = (value.minDelaySeconds as number) || MESSAGE_DELAY_MIN_SECONDS;
          MESSAGE_DELAY_MAX_SECONDS = (value.maxDelaySeconds as number) || MESSAGE_DELAY_MAX_SECONDS;
        } else if (setting.key === "account_limits" && value) {
          DAILY_MESSAGE_LIMIT = (value.dailyMessageLimit as number) || DAILY_MESSAGE_LIMIT;
        }
      }
    }

    const now = new Date().toISOString();

    // Get all active accounts not temporarily restricted, with their proxy info
    // LIMIT to 100 to prevent query timeout
    const { data: activeAccounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("*, telegram_api_credentials(*), proxies!fk_proxy(*)")
      .eq("status", "active")
      .or(`restricted_until.is.null,restricted_until.lt.${now}`)
      .limit(100);

    if (accountsError || !activeAccounts || activeAccounts.length === 0) {
      console.log("[get-batch-tasks] No active accounts available");
      return new Response(JSON.stringify({
        tasks: [],
        delay_after: 30,
        reason: "No active accounts"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CRITICAL SAFETY CHECK: Only use accounts that have an ACTIVE proxy assigned
    const accountsWithActiveProxy = activeAccounts.filter((a: any) => {
      if (!a.proxy_id) {
        console.log(`[get-batch-tasks] SKIPPING account ${a.phone_number} - NO PROXY ASSIGNED`);
        return false;
      }
      if (!a.proxies || a.proxies.status !== 'active') {
        console.log(`[get-batch-tasks] SKIPPING account ${a.phone_number} - PROXY NOT ACTIVE (status: ${a.proxies?.status || 'missing'})`);
        return false;
      }
      return true;
    });

    if (accountsWithActiveProxy.length === 0) {
      console.log("[get-batch-tasks] No accounts with active proxies available");
      return new Response(JSON.stringify({
        tasks: [],
        delay_after: 30,
        reason: "No accounts with active proxies - assign proxies to accounts first"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Filter to accounts under daily limit
    const usableAccounts = accountsWithActiveProxy.filter((a: any) => {
      const limit = a.daily_limit ?? DAILY_MESSAGE_LIMIT;
      const sentToday = a.messages_sent_today ?? 0;
      return sentToday < limit;
    });

    if (usableAccounts.length === 0) {
      console.log("[get-batch-tasks] All accounts at daily limit");
      return new Response(JSON.stringify({
        tasks: [],
        delay_after: 60,
        reason: "All accounts at daily limit"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
    console.log(`[get-batch-tasks] ${usableAccounts.length} accounts with active proxies ready`);

    const tasks: any[] = [];
    const usedAccountIds = new Set<string>();
    const actualBatchSize = Math.min(batch_size, usableAccounts.length);

    // CAMPAIGN RUNNER: Get pending campaign recipients
    if (runner === "campaign") {
      // Get pending recipients from running campaigns (include unassigned ones too)
      const { data: pendingRecipients } = await supabase
        .from("campaign_recipients")
        .select("*, campaigns!inner(id, status, message_template)")
        .eq("status", "pending")
        .eq("campaigns.status", "running")
        .limit(actualBatchSize * 2); // Fetch extra in case some accounts are already used

      if (pendingRecipients && pendingRecipients.length > 0) {
        for (const recipient of pendingRecipients) {
          if (tasks.length >= actualBatchSize) break;

          const campaign = recipient.campaigns;
          
          // Find an account - prefer assigned one, otherwise assign dynamically
          let account = null;
          
          if (recipient.sent_by_account_id) {
            // Use pre-assigned account if available and not already used
            account = usableAccounts.find((a: any) => 
              a.id === recipient.sent_by_account_id && !usedAccountIds.has(a.id)
            );
          }

          // If no assigned account or it's already used, find any available account
          if (!account) {
            account = usableAccounts.find((a: any) => !usedAccountIds.has(a.id));
          }

          if (!account) {
            console.log(`[get-batch-tasks] No more unique accounts for batch`);
            break;
          }

          // Mark recipient as "sending" and assign account
          await supabase
            .from("campaign_recipients")
            .update({ status: "sending", sent_by_account_id: account.id })
            .eq("id", recipient.id)
            .eq("status", "pending");

          // Personalize message
          const personalizedMessage = (campaign.message_template || '')
            .replace(/{name}/g, recipient.name || 'there')
            .replace(/{phone}/g, recipient.phone_number);

          const apiCred = account.telegram_api_credentials;

          tasks.push({
            task: "send",
            message: {
              content: personalizedMessage,
              campaign_recipient_id: recipient.id,
            },
            recipient: recipient.phone_number,
            recipient_name: recipient.name,
            account: {
              id: account.id,
              phone_number: account.phone_number,
              session_data: account.session_data,
              device_model: account.device_model,
              system_version: account.system_version,
              app_version: account.app_version,
              lang_code: account.lang_code,
              system_lang_code: account.system_lang_code,
              api_id: apiCred?.api_id || account.api_id,
              api_hash: apiCred?.api_hash || account.api_hash,
              proxy_id: account.proxy_id,
            },
            proxy: account.proxies
              ? {
                  host: account.proxies.host,
                  port: account.proxies.port,
                  username: account.proxies.username,
                  password: account.proxies.password,
                  // Backwards compatible: python expects proxy_type, older code may use type
                  proxy_type: account.proxies.proxy_type,
                  type: account.proxies.proxy_type,
                }
              : null,
            mode: "campaign",
          });

          usedAccountIds.add(account.id);
          console.log(`[get-batch-tasks] Added task for ${recipient.phone_number} via ${account.phone_number}`);
        }
      }
    }

    // LIVECHAT RUNNER: Get pending outgoing messages
    if (runner === "livechat") {
      const { data: pendingMessages } = await supabase
        .from("messages")
        .select(`
          *,
          conversations!inner(
            id, account_id, recipient_phone, recipient_name, recipient_telegram_id
          )
        `)
        .eq("status", "pending")
        .eq("direction", "outgoing")
        .is("campaign_recipient_id", null)
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(actualBatchSize * 2);

      if (pendingMessages && pendingMessages.length > 0) {
        for (const msg of pendingMessages) {
          if (tasks.length >= actualBatchSize) break;

          const conv = msg.conversations;
          
          // Find the account for this conversation
          const account = usableAccounts.find((a: any) => 
            a.id === conv.account_id && !usedAccountIds.has(a.id)
          );

          if (!account) continue;

          // Mark message as sending
          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id);

          const apiCred = account.telegram_api_credentials;

          tasks.push({
            task: "send",
            message: {
              id: msg.id,
              content: msg.content,
              media_url: msg.media_url,
            },
            recipient: conv.recipient_telegram_id?.toString() || conv.recipient_phone,
            recipient_name: conv.recipient_name,
            account: {
              id: account.id,
              phone_number: account.phone_number,
              session_data: account.session_data,
              device_model: account.device_model,
              system_version: account.system_version,
              app_version: account.app_version,
              lang_code: account.lang_code,
              system_lang_code: account.system_lang_code,
              api_id: apiCred?.api_id || account.api_id,
              api_hash: apiCred?.api_hash || account.api_hash,
              proxy_id: account.proxy_id,
            },
            proxy: account.proxies
              ? {
                  host: account.proxies.host,
                  port: account.proxies.port,
                  username: account.proxies.username,
                  password: account.proxies.password,
                  // Backwards compatible: python expects proxy_type, older code may use type
                  proxy_type: account.proxies.proxy_type,
                  type: account.proxies.proxy_type,
                }
              : null,
            mode: "livechat",
          });

          usedAccountIds.add(account.id);
        }
      }
    }

    // Calculate delay for next batch
    const delaySeconds = Math.floor(
      Math.random() * (MESSAGE_DELAY_MAX_SECONDS - MESSAGE_DELAY_MIN_SECONDS + 1) + MESSAGE_DELAY_MIN_SECONDS
    );

    console.log(`[get-batch-tasks] Returning ${tasks.length} tasks, delay_after: ${delaySeconds}s`);

    return new Response(JSON.stringify({
      tasks,
      delay_after: delaySeconds,
      accounts_available: usableAccounts.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[get-batch-tasks] Error:", errorMessage);
    return new Response(JSON.stringify({
      tasks: [],
      delay_after: 5,
      error: errorMessage,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
