import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LIVE_CONVERSATION_TIMEOUT_MINUTES = 5;
const WARMUP_DAYS = 0; // Days before account is ready for campaigns (disabled for testing)
const MESSAGE_DELAY_MIN_SECONDS = 5; // Minimum delay between campaign messages
const MESSAGE_DELAY_MAX_SECONDS = 15; // Maximum delay between campaign messages

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
    const { account_id, runner } = body;

    console.log(`[get-next-task] Request for runner: ${runner || 'all'}, account: ${account_id || 'any'}`);

    // Reset any messages stuck in "sending" status for more than 2 minutes
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

    // Check for paused campaigns - cancel pending messages
    const { data: pausedCampaigns } = await supabase
      .from("campaigns")
      .select("id")
      .in("status", ["paused", "draft"]);
    
    if (pausedCampaigns && pausedCampaigns.length > 0) {
      const pausedIds = pausedCampaigns.map((c: any) => c.id);
      
      // Get campaign_recipient_ids for paused campaigns
      const { data: pausedRecipients } = await supabase
        .from("campaign_recipients")
        .select("id")
        .in("campaign_id", pausedIds)
        .eq("status", "pending");
      
      if (pausedRecipients && pausedRecipients.length > 0) {
        const recipientIds = pausedRecipients.map((r: any) => r.id);
        
        // Cancel pending messages for paused campaigns
        await supabase
          .from("messages")
          .update({ status: "cancelled", failed_reason: "Campaign paused" })
          .in("campaign_recipient_id", recipientIds)
          .eq("status", "pending");
        
        console.log(`[get-next-task] Cancelled messages for ${pausedRecipients.length} paused campaign recipients`);
      }
    }

    // Get all active accounts for campaigns - exclude banned, restricted
    // Include API credentials for each account
    const { data: activeAccounts, error: activeAccountsError } = await supabase
      .from("telegram_accounts")
      .select("*, telegram_api_credentials(*)")
      .eq("status", "active");

    // Get ALL restricted accounts - they can still message existing conversations
    // Restricted accounts cannot message NEW contacts, but existing conversations are safe
    const { data: restrictedAccounts } = await supabase
      .from("telegram_accounts")
      .select("*, telegram_api_credentials(*)")
      .eq("status", "restricted");

    // For LIVE CHAT: Include ALL restricted accounts (they can message existing conversations)
    const allUsableAccounts = [...(activeAccounts || []), ...(restrictedAccounts || [])];
    
    // For CAMPAIGNS: Only active accounts (campaigns target new contacts)
    const accounts = activeAccounts || [];

    if (activeAccountsError) {
      console.error("[get-next-task] Error fetching accounts:", activeAccountsError);
      return new Response(JSON.stringify({ task: "wait", seconds: 5, reason: "Database error" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!allUsableAccounts || allUsableAccounts.length === 0) {
      console.log("[get-next-task] No usable accounts");
      return new Response(JSON.stringify({ task: "wait", seconds: 30, reason: "No usable accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Separate warmed-up accounts (>5 days old) from new accounts
    const now = new Date();
    const warmedUpAccounts = accounts.filter((a: any) => {
      const createdAt = new Date(a.created_at);
      const daysSinceCreation = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
      return daysSinceCreation >= WARMUP_DAYS;
    });
    
    const newAccounts = accounts.filter((a: any) => {
      const createdAt = new Date(a.created_at);
      const daysSinceCreation = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
      return daysSinceCreation < WARMUP_DAYS;
    });

    console.log(`[get-next-task] Accounts: ${warmedUpAccounts.length} warmed-up, ${newAccounts.length} warming`);

    // Get live conversation IDs (incoming messages in last 5 minutes)
    const cutoff = new Date(Date.now() - LIVE_CONVERSATION_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    const { data: liveMessages } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("direction", "incoming")
      .gte("created_at", cutoff);

    const liveConvIds = new Set((liveMessages || []).map((m: { conversation_id: string }) => m.conversation_id));
    console.log(`[get-next-task] Live conversations: ${liveConvIds.size}`);

    // ========== RUNNER-SPECIFIC TASK FILTERING ==========
    
    // RUNNER: campaign - Only campaign messages (uses ALL active accounts now)
    if (runner === "campaign") {
      // Check each running campaign individually - only stop if ALL its assigned accounts are restricted
      const { data: runningCampaigns } = await supabase
        .from("campaigns")
        .select("id, name")
        .eq("status", "running");
      
      if (runningCampaigns && runningCampaigns.length > 0) {
        let allCampaignsStopped = true;
        
        for (const campaign of runningCampaigns) {
          // Get accounts assigned to this specific campaign
          const { data: campaignAccountLinks } = await supabase
            .from("campaign_accounts")
            .select("account_id, telegram_accounts!inner(id, status, messages_sent_today, daily_limit)")
            .eq("campaign_id", campaign.id);
          
          // Check if any assigned account is usable (active AND under daily limit)
          const hasUsableAccount = (campaignAccountLinks || []).some((ca: any) => {
            const acc = ca.telegram_accounts;
            if (!acc) return false;
            const limit = acc.daily_limit ?? 25;
            const sentToday = acc.messages_sent_today ?? 0;
            return acc.status === 'active' && sentToday < limit;
          });
          
          if (!hasUsableAccount) {
            console.log(`[get-next-task] No usable accounts left for campaign "${campaign.name}" (restricted or daily limit) - completing`);
            await supabase
              .from("campaigns")
              .update({ status: "completed" })
              .eq("id", campaign.id);
          } else {
            allCampaignsStopped = false;
          }
        }
        
        // Only send stop signal if ALL campaigns have been completed
        if (allCampaignsStopped) {
          return new Response(JSON.stringify({
            task: "wait",
            seconds: 30,
            stop_signal: true,
            reason: "All campaigns completed - no active accounts"
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      
      // If no accounts at all, wait
      if (accounts.length === 0) {
        return new Response(JSON.stringify({
          task: "wait",
          seconds: 30,
          reason: "No active accounts available"
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (accounts.length > 0) {
        // NEW FLOW: Query campaign_recipients directly, not messages
        // Conversations are only created on successful delivery
        // IMPORTANT: Only get recipients from RUNNING campaigns
        const { data: pendingRecipients } = await supabase
          .from("campaign_recipients")
          .select("*, campaigns!inner(id, status, message_template)")
          .eq("status", "pending")
          .eq("campaigns.status", "running")  // Only running campaigns!
          .not("sent_by_account_id", "is", null)
          .limit(50);

        if (pendingRecipients && pendingRecipients.length > 0) {
          for (const recipient of pendingRecipients) {
            const campaign = recipient.campaigns;

            // Find the assigned account
            const account = accounts.find((a: { id: string }) => a.id === recipient.sent_by_account_id);
            if (!account) continue;

            // Check daily limit
            if ((account.messages_sent_today || 0) >= (account.daily_limit || 50)) {
              console.log(`[get-next-task] Account ${account.phone_number} at daily limit`);
              continue;
            }

            // Mark recipient as "sending" to prevent duplicate picks
            await supabase
              .from("campaign_recipients")
              .update({ status: "sending" })
              .eq("id", recipient.id)
              .eq("status", "pending");

            console.log(`[get-next-task] Campaign task: recipient ${recipient.id.slice(0, 8)} -> ${recipient.phone_number}`);
            
            // Personalize message template
            const personalizedMessage = (campaign.message_template || '')
              .replace(/{name}/g, recipient.name || 'there')
              .replace(/{phone}/g, recipient.phone_number);
            
            // Get API credentials from account
            const apiCred = account.telegram_api_credentials;
            
            // Calculate random delay for next message (human-like behavior)
            const delaySeconds = Math.floor(
              Math.random() * (MESSAGE_DELAY_MAX_SECONDS - MESSAGE_DELAY_MIN_SECONDS + 1) + MESSAGE_DELAY_MIN_SECONDS
            );
            
            console.log(`[get-next-task] Campaign message assigned, next check in ${delaySeconds}s`);
            
            return new Response(JSON.stringify({
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
              mode: "campaign",
              delay_after: delaySeconds,
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }

        // Also handle validation for campaign runner
        const { data: validatingRecipients } = await supabase
          .from("campaign_recipients")
          .select("*")
          .eq("status", "validating")
          .limit(10);

        if (validatingRecipients && validatingRecipients.length > 0) {
          const account = accounts[0];
          const apiCred = account.telegram_api_credentials;
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
              device_model: account.device_model,
              system_version: account.system_version,
              app_version: account.app_version,
              lang_code: account.lang_code,
              system_lang_code: account.system_lang_code,
              api_id: apiCred?.api_id || account.api_id,
              api_hash: apiCred?.api_hash || account.api_hash,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 1,
        accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RUNNER: warmup - Only warmup tasks (from warmup_schedule table)
    if (runner === "warmup") {
      // Priority 1: Check for bidirectional interaction tasks
      const { data: interactionTasks } = await supabase
        .from("interaction_scheduler")
        .select("*, sender:telegram_accounts!sender_account_id(*, telegram_api_credentials(*)), receiver:telegram_accounts!receiver_account_id(*)")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(1);

      if (interactionTasks && interactionTasks.length > 0) {
        const task = interactionTasks[0] as any;
        const senderAccount = task.sender;
        const receiverAccount = task.receiver;
        
        if (senderAccount && senderAccount.status === "active" && receiverAccount) {
          const apiCred = senderAccount.telegram_api_credentials;
          
          // Mark as in_progress
          await supabase
            .from("interaction_scheduler")
            .update({ status: "in_progress" })
            .eq("id", task.id);
          
          console.log(`[get-next-task] Interaction task: ${senderAccount.phone_number} -> ${receiverAccount.phone_number}`);
          return new Response(JSON.stringify({
            task: "warmup_interaction",
            task_id: task.id,
            task_data: {
              recipient_phone: receiverAccount.phone_number,
              message: task.message_content,
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
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Priority 2: Check warmup_schedule table for channel/content tasks
      const { data: warmupTasks } = await supabase
        .from("warmup_schedule")
        .select("*, telegram_accounts(*, telegram_api_credentials(*))")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .order("priority", { ascending: false })
        .order("scheduled_at", { ascending: true })
        .limit(1);

      if (warmupTasks && warmupTasks.length > 0) {
        const task = warmupTasks[0] as any;
        const accountData = task.telegram_accounts;
        
        if (accountData && accountData.status === "active") {
          const apiCred = accountData.telegram_api_credentials;
          
          // Mark as in_progress
          await supabase
            .from("warmup_schedule")
            .update({ status: "in_progress" })
            .eq("id", task.id);
          
          console.log(`[get-next-task] Warmup task ${task.task_type} for ${task.account_id}`);
          return new Response(JSON.stringify({
            task: "warmup_" + task.task_type,
            task_id: task.id,
            task_data: {
              channel_username: task.channel_username,
            },
            account: {
              id: accountData.id,
              phone_number: accountData.phone_number,
              session_data: accountData.session_data,
              device_model: accountData.device_model,
              system_version: accountData.system_version,
              app_version: accountData.app_version,
              lang_code: accountData.lang_code,
              system_lang_code: accountData.system_lang_code,
              api_id: apiCred?.api_id || accountData.api_id,
              api_hash: apiCred?.api_hash || accountData.api_hash,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Fallback: Check old maturation_tasks table for backwards compatibility
      const { data: oldWarmupTasks } = await supabase
        .from("maturation_tasks")
        .select("*, telegram_accounts(*, telegram_api_credentials(*))")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .limit(1);

      if (oldWarmupTasks && oldWarmupTasks.length > 0) {
        const task = oldWarmupTasks[0] as any;
        const accountData = task.telegram_accounts;
        
        if (accountData && accountData.status === "active") {
          const apiCred = accountData.telegram_api_credentials;
          console.log(`[get-next-task] Legacy warmup task ${task.task_type} for ${task.account_id}`);
          return new Response(JSON.stringify({
            task: "warmup_" + task.task_type,
            task_id: task.id,
            account: {
              id: accountData.id,
              phone_number: accountData.phone_number,
              session_data: accountData.session_data,
              device_model: accountData.device_model,
              system_version: accountData.system_version,
              app_version: accountData.app_version,
              lang_code: accountData.lang_code,
              system_lang_code: accountData.system_lang_code,
              api_id: apiCred?.api_id || accountData.api_id,
              api_hash: apiCred?.api_hash || accountData.api_hash,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 30,
        reason: "No warmup tasks",
        accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RUNNER: account - Only account management tasks
    if (runner === "account") {
      const { data: checkTasks } = await supabase
        .from("account_check_tasks")
        .select("*, telegram_accounts(*, telegram_api_credentials(*))")
        .eq("status", "pending")
        .in("task_type", ["spambot_check", "change_name", "privacy_settings", "change_password", "logout_sessions", "change_photo"])
        .limit(1);

      if (checkTasks && checkTasks.length > 0) {
        const task = checkTasks[0];
        const accountData = task.telegram_accounts;
        const taskType = task.task_type;

        if (accountData) {
          const apiCred = accountData.telegram_api_credentials;
          
          if (taskType === "spambot_check") {
            const lastCheck = accountData.last_spambot_check;
            if (lastCheck) {
              const hoursSinceCheck = (Date.now() - new Date(lastCheck).getTime()) / (1000 * 60 * 60);
              if (hoursSinceCheck < 96) {
                await supabase
                  .from("account_check_tasks")
                  .update({
                    status: "skipped",
                    result: `Already checked ${hoursSinceCheck.toFixed(1)} hours ago.`,
                    completed_at: new Date().toISOString(),
                  })
                  .eq("id", task.id);
              } else {
                console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
                return new Response(JSON.stringify({
                  task: "spambot_check",
                  task_id: task.id,
                  account: {
                    id: accountData.id,
                    phone_number: accountData.phone_number,
                    session_data: accountData.session_data,
                    device_model: accountData.device_model,
                    system_version: accountData.system_version,
                    app_version: accountData.app_version,
                    lang_code: accountData.lang_code,
                    system_lang_code: accountData.system_lang_code,
                    api_id: apiCred?.api_id || accountData.api_id,
                    api_hash: apiCred?.api_hash || accountData.api_hash,
                  },
                }), {
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
              }
            } else {
              console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
              return new Response(JSON.stringify({
                task: "spambot_check",
                task_id: task.id,
                account: {
                  id: accountData.id,
                  phone_number: accountData.phone_number,
                  session_data: accountData.session_data,
                  device_model: accountData.device_model,
                  system_version: accountData.system_version,
                  app_version: accountData.app_version,
                  lang_code: accountData.lang_code,
                  system_lang_code: accountData.system_lang_code,
                  api_id: apiCred?.api_id || accountData.api_id,
                  api_hash: apiCred?.api_hash || accountData.api_hash,
                },
              }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          } else {
            console.log(`[get-next-task] ${taskType} for ${task.account_id}`);
            return new Response(JSON.stringify({
              task: taskType,
              task_id: task.id,
              task_data: task.result ? JSON.parse(task.result) : {},
              account: {
                id: accountData.id,
                phone_number: accountData.phone_number,
                session_data: accountData.session_data,
                device_model: accountData.device_model,
                system_version: accountData.system_version,
                app_version: accountData.app_version,
                lang_code: accountData.lang_code,
                system_lang_code: accountData.system_lang_code,
                api_id: apiCred?.api_id || accountData.api_id,
                api_hash: apiCred?.api_hash || accountData.api_hash,
              },
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 5,
        reason: "No account tasks",
        accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RUNNER: livechat - Handles ALL pending outgoing messages (not just live conversations)
    // Restricted accounts CAN send live chat messages to existing contacts (won't get banned)
    if (runner === "livechat") {
      // Get all usable account IDs (includes restricted for livechat)
      const usableAccountIds = new Set(allUsableAccounts.map((a: { id: string }) => a.id));
      
      // Only fail messages from BANNED or DISCONNECTED accounts (not restricted!)
      const { data: unusableAccounts } = await supabase
        .from("telegram_accounts")
        .select("id")
        .in("status", ["banned", "disconnected"]);
      
      if (unusableAccounts && unusableAccounts.length > 0) {
        const unusableIds = unusableAccounts.map((a: { id: string }) => a.id);
        const { data: stuckMessages } = await supabase
          .from("messages")
          .select("id")
          .eq("status", "pending")
          .eq("direction", "outgoing")
          .is("campaign_recipient_id", null)
          .in("account_id", unusableIds);
        
        if (stuckMessages && stuckMessages.length > 0) {
          const messageIds = stuckMessages.map(m => m.id);
          await supabase
            .from("messages")
            .update({ status: "failed", failed_reason: "Account banned or disconnected" })
            .in("id", messageIds);
          console.log(`[get-next-task] Auto-failed ${stuckMessages.length} messages from banned/disconnected accounts`);
        }
      }
      
      // Fetch pending messages and find one with an available account
      const { data: pendingMessages } = await supabase
        .from("messages")
        .select("*, conversations(*)")
        .eq("status", "pending")
        .eq("direction", "outgoing")
        .is("campaign_recipient_id", null)  // Non-campaign messages only
        .order("created_at", { ascending: true })
        .limit(20);  // Fetch more messages to find one with available account

      if (pendingMessages && pendingMessages.length > 0) {
        // Loop through messages to find one with an available account
        for (const msg of pendingMessages) {
          const conv = msg.conversations || {};
          // Use allUsableAccounts (includes restricted) for live chat
          const account = allUsableAccounts.find((a: { id: string }) => a.id === msg.account_id);

          if (account) {
            await supabase
              .from("messages")
              .update({ status: "sending" })
              .eq("id", msg.id)
              .eq("status", "pending");

            console.log(`[get-next-task] Live chat task: message ${msg.id.slice(0, 8)} to ${conv.recipient_phone || conv.recipient_username} (account status: ${account.status})`);
            const apiCred = account.telegram_api_credentials;
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
                device_model: account.device_model,
                system_version: account.system_version,
                app_version: account.app_version,
                lang_code: account.lang_code,
                system_lang_code: account.system_lang_code,
                api_id: apiCred?.api_id || account.api_id,
                api_hash: apiCred?.api_hash || account.api_hash,
              },
              mode: "live",
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 0.1,
        accounts: allUsableAccounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ========== DEFAULT: ALL TASKS (original behavior) ==========

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
          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id)
            .eq("status", "pending");

          console.log(`[get-next-task] Live chat task: message ${msg.id.slice(0, 8)}`);
          const apiCred = account.telegram_api_credentials;
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
              device_model: account.device_model,
              system_version: account.system_version,
              app_version: account.app_version,
              lang_code: account.lang_code,
              system_lang_code: account.system_lang_code,
              api_id: apiCred?.api_id || account.api_id,
              api_hash: apiCred?.api_hash || account.api_hash,
            },
            mode: "live",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Priority 2: Campaign messages (only use warmed-up accounts)
    if (warmedUpAccounts.length > 0) {
      const { data: campaignMessages } = await supabase
        .from("messages")
        .select("*, conversations(*), campaign_recipients(campaign_id)")
        .eq("status", "pending")
        .eq("direction", "outgoing")
        .limit(50);

      if (campaignMessages && campaignMessages.length > 0) {
        for (const msg of campaignMessages) {
          if (liveConvIds.has(msg.conversation_id)) continue;

          const conv = msg.conversations || {};
          const campaignRecipientId = msg.campaign_recipient_id;

          // Skip orphaned messages
          if (!campaignRecipientId) {
            if (!conv.is_active && !conv.recipient_telegram_id) {
              await supabase
                .from("messages")
                .update({ status: "cancelled", failed_reason: "Campaign deleted" })
                .eq("id", msg.id);
              continue;
            }
          } else {
            const campaignRecipient = msg.campaign_recipients;
            if (!campaignRecipient || !campaignRecipient.campaign_id) {
              await supabase
                .from("messages")
                .update({ status: "cancelled", failed_reason: "Campaign recipient deleted" })
                .eq("id", msg.id);
              continue;
            }

            // Check if campaign is paused
            const { data: campaign } = await supabase
              .from("campaigns")
              .select("status")
              .eq("id", campaignRecipient.campaign_id)
              .single();
            
            if (campaign && (campaign.status === "paused" || campaign.status === "draft")) {
              console.log(`[get-next-task] Campaign ${campaignRecipient.campaign_id} is paused`);
              continue;
            }
          }

          // Only use warmed-up accounts for campaigns
          const account = warmedUpAccounts.find((a: { id: string }) => a.id === msg.account_id);
          if (!account) {
            console.log(`[get-next-task] Account ${msg.account_id} not warmed-up or unavailable`);
            continue;
          }

          // Check daily limit
          if ((account.messages_sent_today || 0) >= (account.daily_limit || 10)) {
            console.log(`[get-next-task] Account ${account.phone_number} at daily limit`);
            continue;
          }

          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id)
            .eq("status", "pending");

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
    }

    // Priority 3: Validate recipients
    const { data: validatingRecipients } = await supabase
      .from("campaign_recipients")
      .select("*")
      .eq("status", "validating")
      .limit(10);

    if (validatingRecipients && validatingRecipients.length > 0 && warmedUpAccounts.length > 0) {
      const account = warmedUpAccounts[0];
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

    // Priority 4: Account management tasks
    const { data: checkTasks } = await supabase
      .from("account_check_tasks")
      .select("*, telegram_accounts(*)")
      .eq("status", "pending")
      .in("task_type", ["spambot_check", "change_name", "privacy_settings", "change_password", "logout_sessions", "change_photo"])
      .limit(1);

    if (checkTasks && checkTasks.length > 0) {
      const task = checkTasks[0];
      const accountData = task.telegram_accounts;
      const taskType = task.task_type;

      if (accountData) {
        if (taskType === "spambot_check") {
          const lastCheck = accountData.last_spambot_check;
          if (lastCheck) {
            const hoursSinceCheck = (Date.now() - new Date(lastCheck).getTime()) / (1000 * 60 * 60);
            if (hoursSinceCheck < 96) {
              await supabase
                .from("account_check_tasks")
                .update({
                  status: "skipped",
                  result: `Already checked ${hoursSinceCheck.toFixed(1)} hours ago.`,
                  completed_at: new Date().toISOString(),
                })
                .eq("id", task.id);
            } else {
              console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
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
            console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
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
          console.log(`[get-next-task] ${taskType} for ${task.account_id}`);
          return new Response(JSON.stringify({
            task: taskType,
            task_id: task.id,
            task_data: task.result ? JSON.parse(task.result) : {},
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

    // Priority 5: Warm-up tasks for new accounts
    if (newAccounts.length > 0) {
      const { data: warmupTasks } = await supabase
        .from("maturation_tasks")
        .select("*, telegram_accounts(*)")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .limit(1);

      if (warmupTasks && warmupTasks.length > 0) {
        const task = warmupTasks[0];
        const accountData = task.telegram_accounts;
        
        if (accountData && accountData.status === "active") {
          console.log(`[get-next-task] Warmup task ${task.task_type} for ${task.account_id}`);
          return new Response(JSON.stringify({
            task: "warmup_" + task.task_type,
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

    // No tasks - wait briefly
    return new Response(JSON.stringify({
      task: "wait",
      seconds: 0.05,
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
