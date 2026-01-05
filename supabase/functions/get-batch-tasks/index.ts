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
    const { runner, batch_size = 200 } = body;

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
    // Fetch all accounts without limit to support 100+ pairs
    const { data: activeAccounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("*, telegram_api_credentials(*), proxies!fk_proxy(*)")
      .eq("status", "active")
      .or(`restricted_until.is.null,restricted_until.lt.${now}`);

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

    // WARMUP_CHAT RUNNER: Get pending warmup messages (PARALLEL BATCH)
    if (runner === "warmup_chat") {
      // First: Auto-fail stuck tasks (claimed > 1 minute ago but still "sending")
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
      const { data: stuckMessages } = await supabase
        .from("warmup_messages")
        .select("id, pair_id, sender_account_id")
        .eq("status", "sending")
        .lt("claimed_at", oneMinuteAgo);

      if (stuckMessages && stuckMessages.length > 0) {
        console.log(`[get-batch-tasks] Found ${stuckMessages.length} stuck warmup messages, marking as failed`);
        
        // Mark stuck messages as failed
        const stuckIds = stuckMessages.map(m => m.id);
        await supabase
          .from("warmup_messages")
          .update({ status: "failed", error_message: "Runner crash - task stuck" })
          .in("id", stuckIds);

        // Get unique pair IDs that need to be marked failed
        const stuckPairIds = [...new Set(stuckMessages.map(m => m.pair_id).filter(Boolean))];
        
        for (const pairId of stuckPairIds) {
          // Cancel pending messages for this pair
          await supabase
            .from("warmup_messages")
            .update({ status: "cancelled", error_message: "Pair stopped due to runner crash" })
            .eq("pair_id", pairId)
            .eq("status", "pending");
          
          // Mark pair as failed with reason
          await supabase
            .from("warmup_pairs")
            .update({ status: "failed", failed_reason: "Runner crash" })
            .eq("id", pairId);
          
          // Log error
          const { data: pairData } = await supabase
            .from("warmup_pairs")
            .select("session_id")
            .eq("id", pairId)
            .single();
          
          if (pairData?.session_id) {
            await supabase
              .from("warmup_errors")
              .insert({
                session_id: pairData.session_id,
                pair_id: pairId,
                error_message: "Runner crash - warmup task stuck for over 1 minute",
                error_type: "runner_crash",
              });
          }
        }
      }

      // Get pending warmup messages that are due, one per SENDER ACCOUNT to avoid conflicts
      const { data: warmupMessages } = await supabase
        .from("warmup_messages")
        .select(`
          *,
          warmup_pairs(*),
          sender:telegram_accounts!warmup_messages_sender_account_id_fkey(*, telegram_api_credentials(*), proxies!fk_proxy(id, host, port, username, password, proxy_type, status)),
          receiver:telegram_accounts!warmup_messages_receiver_account_id_fkey(phone_number, telegram_id, username, first_name)
        `)
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(500); // Fetch plenty to maximize parallel processing

      if (warmupMessages && warmupMessages.length > 0) {
        console.log(`[get-batch-tasks] Found ${warmupMessages.length} pending warmup messages`);
        
        for (const msg of warmupMessages as any[]) {
          if (tasks.length >= actualBatchSize) break;
          
          const senderAccount = msg.sender;
          const receiverAccount = msg.receiver;
          const proxy = Array.isArray(senderAccount?.proxies) ? senderAccount.proxies[0] : senderAccount?.proxies;

          // Skip if sender already has a task in this batch (avoid parallel sends from same account)
          if (usedAccountIds.has(senderAccount?.id)) continue;

          // Check account is active/restricted and has active proxy (restricted accounts CAN do warmup)
          const isUsableStatus = senderAccount && (senderAccount.status === "active" || senderAccount.status === "restricted");
          if (isUsableStatus && receiverAccount && proxy?.status === "active") {
            const apiCred = senderAccount.telegram_api_credentials;

            // Mark as "sending" with claim info (task leasing)
            await supabase
              .from("warmup_messages")
              .update({ 
                status: "sending",
                claimed_at: new Date().toISOString(),
                claimed_by: "warmup_chat_runner"
              })
              .eq("id", msg.id);

            // Determine task type based on message_type
            const taskType = msg.message_type === "add_contact" ? "warmup_add_contact" : "warmup_chat";

            tasks.push({
              task: taskType,
              task_id: msg.id,
              pair_id: msg.pair_id,
              is_cycle_last: msg.is_cycle_last || false,
              task_data: {
                recipient_phone: receiverAccount.phone_number,
                recipient_telegram_id: receiverAccount.telegram_id,
                recipient_username: receiverAccount.username,
                message: msg.message_content,
                message_type: msg.message_type,
                first_name: msg.message_type === "add_contact" ? msg.message_content : receiverAccount.first_name,
                phone: receiverAccount.phone_number,
              },
              account: {
                id: senderAccount.id,
                phone_number: senderAccount.phone_number,
                session_data: senderAccount.session_data,
                device_model: senderAccount.device_model,
                system_version: senderAccount.system_version,
                app_version: senderAccount.app_version,
                lang_code: senderAccount.lang_code,
                system_lang_code: senderAccount.system_lang_code,
                api_id: apiCred?.api_id || senderAccount.api_id,
                api_hash: apiCred?.api_hash || senderAccount.api_hash,
                proxy: proxy,
              },
            });

            usedAccountIds.add(senderAccount.id);
            console.log(`[get-batch-tasks] Added warmup task: ${senderAccount.phone_number} -> ${receiverAccount.phone_number}`);
          } else {
            // Account not usable, mark as failed
            const reason = !senderAccount ? "Sender account not found" :
                           (senderAccount.status !== "active" && senderAccount.status !== "restricted") ? `Sender status: ${senderAccount.status}` :
                           !proxy ? "No proxy assigned" :
                           proxy.status !== "active" ? `Proxy status: ${proxy.status}` :
                           "Unknown reason";
            
            await supabase
              .from("warmup_messages")
              .update({ status: "failed", error_message: reason })
              .eq("id", msg.id);

            // If proxy error, mark the pair as failed
            if (reason.includes("Proxy") || reason.includes("proxy")) {
              await supabase
                .from("warmup_pairs")
                .update({ status: "failed", failed_reason: "Proxy error" })
                .eq("id", msg.pair_id);
              
              // Cancel other pending messages for this pair
              await supabase
                .from("warmup_messages")
                .update({ status: "cancelled", error_message: "Pair stopped due to proxy error" })
                .eq("pair_id", msg.pair_id)
                .eq("status", "pending");
            }
            
            console.log(`[get-batch-tasks] Warmup task skipped: ${reason}`);
          }
        }
      }
      
      // Return warmup batch result
      // FAST MODE: Minimal delay when tasks are available, process as fast as possible
      const delaySeconds = tasks.length > 0 ? 0.5 : 3; // Near-instant if we got tasks
      console.log(`[get-batch-tasks] Returning ${tasks.length} warmup tasks (delay: ${delaySeconds}s)`);
      
      return new Response(JSON.stringify({
        tasks,
        delay_after: delaySeconds,
        accounts_available: usableAccounts.length,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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