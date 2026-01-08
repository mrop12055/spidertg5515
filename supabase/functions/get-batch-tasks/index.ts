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
    const { runner, batch_size = 100 } = body;

    console.log(`[get-batch-tasks] Request for runner: ${runner}, batch_size: ${batch_size}`);

    // Record runner heartbeat - use base runner name for UI display
    if (runner) {
      // Normalize runner name: warmup_chat -> warmup, campaign_batch -> campaign
      const baseRunnerName = runner.replace(/_batch$/, '').replace(/_chat$/, '');
      await supabase
        .from("runner_heartbeats")
        .upsert({
          runner_name: baseRunnerName,
          last_seen: new Date().toISOString(),
          status: 'online'
        }, { onConflict: 'runner_name' });
    }

    // Load settings from database
    const { data: settingsData } = await supabase
      .from("app_settings")
      .select("key, value");

    // Dynamic batch sizes from settings
    let warmupBatchSize = 100; // Default for warmup
    
    // Campaign speed settings - NO LIMITS, INSTANT SENDING
    const campaignStaggerMin = 0;  // No stagger
    const campaignStaggerMax = 0;  // No stagger
    const campaignPollingInterval = 3;  // 3 seconds when tasks exist
    const noTaskPollingInterval = 30;   // 30 seconds when no tasks
    // NO message limit per account - unlimited
    
    if (settingsData) {
      for (const setting of settingsData) {
        const value = setting.value as Record<string, unknown>;
        if (setting.key === "message_timing" && value) {
          MESSAGE_DELAY_MIN_SECONDS = (value.minDelaySeconds as number) || MESSAGE_DELAY_MIN_SECONDS;
          MESSAGE_DELAY_MAX_SECONDS = (value.maxDelaySeconds as number) || MESSAGE_DELAY_MAX_SECONDS;
        } else if (setting.key === "warmup_batch_size" && value) {
          // Read warmup batch size from app_settings
          warmupBatchSize = (value.batchSize as number) || warmupBatchSize;
        }
        // Ignore campaign_speed settings - we use hardcoded values for no limits
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
        delay_after: noTaskPollingInterval,
        reason: "No accounts with active proxies - assign proxies to accounts first"
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use ALL accounts with active proxies - NO daily limit filtering for campaigns
    const usableAccounts = accountsWithActiveProxy;
    
    console.log(`[get-batch-tasks] ${usableAccounts.length} accounts with active proxies ready (NO LIMITS)`);

    const tasks: any[] = [];
    const usedAccountIds = new Set<string>();

    // WARMUP_CHAT RUNNER: Get pending warmup messages (PARALLEL BATCH)
    if (runner === "warmup_chat") {
      // Use dynamic warmup batch size from settings
      const actualBatchSize = Math.min(warmupBatchSize, usableAccounts.length);
      console.log(`[get-batch-tasks] Warmup using batch size: ${actualBatchSize} (from settings: ${warmupBatchSize})`);
      
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
        .limit(actualBatchSize * 3); // Fetch extra to find unique senders

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
      const delaySeconds = tasks.length > 0 ? 3 : 5; // Short delay if we got tasks
      console.log(`[get-batch-tasks] Returning ${tasks.length} warmup tasks`);
      
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
      // Get running campaigns with their batch_size settings + seat_id and name for metadata
      const { data: runningCampaigns } = await supabase
        .from("campaigns")
        .select("id, batch_size, message_template, seat_id, name")
        .eq("status", "running");

      if (!runningCampaigns || runningCampaigns.length === 0) {
        return new Response(JSON.stringify({
          tasks: [],
          delay_after: noTaskPollingInterval,
          stagger_min: campaignStaggerMin,
          stagger_max: campaignStaggerMax,
          reason: "No running campaigns",
          stop_signal: true
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Build campaign lookup for metadata
      const campaignLookup = new Map<string, { seat_id: string | null; name: string }>();
      for (const c of runningCampaigns) {
        campaignLookup.set(c.id, { seat_id: c.seat_id, name: c.name });
      }

      const campaignIds = runningCampaigns.map(c => c.id);

      // ========== SMART API DISTRIBUTION ==========
      // Get 24h usage per API credential
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Get campaign recipients sent in last 24h with their API
      const { data: recentSends } = await supabase
        .from("campaign_recipients")
        .select("api_credential_id")
        .eq("status", "sent")
        .not("api_credential_id", "is", null)
        .gte("sent_at", oneDayAgo);

      // Count usage per API
      const apiUsageCounts = new Map<string, number>();
      (recentSends || []).forEach((r: any) => {
        if (r.api_credential_id) {
          apiUsageCounts.set(r.api_credential_id, (apiUsageCounts.get(r.api_credential_id) || 0) + 1);
        }
      });

      // Load API daily limit from settings (default 45)
      let apiDailyLimit = 45;
      const apiLimitSetting = settingsData?.find((s: any) => s.key === "api_limits");
      if (apiLimitSetting?.value?.dailyLimitPerApi) {
        apiDailyLimit = (apiLimitSetting.value as { dailyLimitPerApi?: number }).dailyLimitPerApi || 45;
      }

      console.log(`[get-batch-tasks] API usage (24h): ${JSON.stringify(Object.fromEntries(apiUsageCounts))}, limit: ${apiDailyLimit}`);

      // Filter accounts to only those whose API is under the 24h limit
      const accountsWithAvailableApi = usableAccounts.filter((a: any) => {
        if (!a.api_credential_id) return true; // Allow accounts without API (will use default)
        const apiUsed = apiUsageCounts.get(a.api_credential_id) || 0;
        if (apiUsed >= apiDailyLimit) {
          console.log(`[get-batch-tasks] Skipping account ${a.phone_number} - API at limit (${apiUsed}/${apiDailyLimit})`);
          return false;
        }
        return true;
      });

      // Sort by API usage (least-used first for even distribution)
      accountsWithAvailableApi.sort((a: any, b: any) => {
        const usageA = apiUsageCounts.get(a.api_credential_id) || 0;
        const usageB = apiUsageCounts.get(b.api_credential_id) || 0;
        return usageA - usageB; // Least used first
      });

      console.log(`[get-batch-tasks] ${accountsWithAvailableApi.length} accounts have API under limit (of ${usableAccounts.length} total)`);

      // NO per-account message limit - use all accounts with available API
      const campaignUsableAccounts = accountsWithAvailableApi;

      // Track API usage in this batch to avoid over-assigning
      const batchApiUsage = new Map<string, number>();

      // ========== STUCK SENDING RECOVERY ==========
      // Find "sending" recipients that have been stuck for over 2 minutes (no message created)
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const { data: stuckSendingRecipients } = await supabase
        .from("campaign_recipients")
        .select("id, campaign_id, sent_by_account_id")
        .eq("status", "sending")
        .in("campaign_id", campaignIds)
        .limit(50);

      if (stuckSendingRecipients && stuckSendingRecipients.length > 0) {
        // Check which ones don't have a corresponding message
        for (const stuck of stuckSendingRecipients) {
          const { count: msgCount } = await supabase
            .from("messages")
            .select("id", { count: "exact", head: true })
            .eq("campaign_recipient_id", stuck.id);

          if (msgCount === 0) {
            // No message exists - this is truly stuck, reset to pending
            console.log(`[get-batch-tasks] Recovering stuck recipient ${stuck.id} - no message found`);
            
            // Add the stuck account to failed_account_ids to avoid retrying with same account
            const { data: currentRecipient } = await supabase
              .from("campaign_recipients")
              .select("failed_account_ids")
              .eq("id", stuck.id)
              .single();
            
            const failedIds: string[] = currentRecipient?.failed_account_ids || [];
            if (stuck.sent_by_account_id && !failedIds.includes(stuck.sent_by_account_id)) {
              failedIds.push(stuck.sent_by_account_id);
            }

            await supabase
              .from("campaign_recipients")
              .update({
                status: "pending",
                sent_by_account_id: null,
                failed_account_ids: failedIds,
                failed_reason: null
              })
              .eq("id", stuck.id);
          }
        }
      }

      // ========== GET PENDING RECIPIENTS ==========
      // Get pending recipients with their failed_account_ids
      const { data: pendingRecipients } = await supabase
        .from("campaign_recipients")
        .select("*, campaigns!inner(id, status, message_template, batch_size)")
        .eq("status", "pending")
        .eq("campaigns.status", "running")
        .limit(200); // Fetch more to account for filtering

      // Count total pending after recovery
      const totalPending = pendingRecipients?.length || 0;

      // ========== NO PENDING RECIPIENTS = AUTO-COMPLETE ==========
      if (totalPending === 0) {
        console.log(`[get-batch-tasks] No pending recipients - checking if campaigns should complete`);
        
        // Check each running campaign
        for (const campaign of runningCampaigns) {
          const { count: stillPending } = await supabase
            .from("campaign_recipients")
            .select("id", { count: "exact", head: true })
            .eq("campaign_id", campaign.id)
            .in("status", ["pending", "sending"]);

          if (stillPending === 0) {
            console.log(`[get-batch-tasks] Auto-completing campaign ${campaign.id} - no pending/sending recipients`);
            await supabase
              .from("campaigns")
              .update({ status: "completed", updated_at: new Date().toISOString() })
              .eq("id", campaign.id);
          }
        }

        return new Response(JSON.stringify({
          tasks: [],
          delay_after: noTaskPollingInterval,
          stagger_min: campaignStaggerMin,
          stagger_max: campaignStaggerMax,
          reason: "No pending recipients",
          stop_signal: true
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ========== NO USABLE ACCOUNTS = AUTO-FAIL ==========
      if (campaignUsableAccounts.length === 0) {
        console.log(`[get-batch-tasks] No usable accounts - AUTO-FAILING campaigns with pending recipients`);
        
        for (const campaign of runningCampaigns) {
          // Mark campaign as failed
          await supabase
            .from("campaigns")
            .update({ 
              status: "failed", 
              updated_at: new Date().toISOString() 
            })
            .eq("id", campaign.id);

          // Mark all pending recipients as failed
          await supabase
            .from("campaign_recipients")
            .update({
              status: "failed",
              failed_reason: "No accounts available - all restricted or at daily limit",
              sent_at: new Date().toISOString()
            })
            .eq("campaign_id", campaign.id)
            .eq("status", "pending");

          console.log(`[get-batch-tasks] Campaign ${campaign.id} auto-failed - no usable accounts`);
        }

        return new Response(JSON.stringify({
          tasks: [],
          delay_after: noTaskPollingInterval,
          stagger_min: campaignStaggerMin,
          stagger_max: campaignStaggerMax,
          reason: "All accounts restricted or at daily limit - campaigns failed",
          stop_signal: true
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // NO batch size limit - get ALL pending recipients that we can assign to accounts
      const actualBatchSize = campaignUsableAccounts.length * 10; // Allow many tasks per account
      console.log(`[get-batch-tasks] Campaign using NO LIMITS: ${campaignUsableAccounts.length} accounts available`);

      // Track recipients with no eligible accounts (all accounts in their failed_account_ids)
      let recipientsWithNoAccounts = 0;

      if (pendingRecipients && pendingRecipients.length > 0) {
        for (const recipient of pendingRecipients) {
          if (tasks.length >= actualBatchSize) break;

          const campaign = recipient.campaigns;
          const failedAccountIds: string[] = recipient.failed_account_ids || [];
          
          // ========== ROUND-ROBIN: Assign accounts evenly, allow multiple messages per account ==========
          let account = null;
          
          // Round-robin index for fair distribution
          const roundRobinIndex = tasks.length % campaignUsableAccounts.length;
          
          if (recipient.sent_by_account_id) {
            // Use pre-assigned account ONLY if:
            // 1. It's not in failed_account_ids
            // 2. It's in campaignUsableAccounts (active, under limit)
            // 3. API not at limit (NO usedAccountIds check - allow multiple per batch)
            const isNotFailed = !failedAccountIds.includes(recipient.sent_by_account_id);
            account = isNotFailed 
              ? campaignUsableAccounts.find((a: any) => {
                  if (a.id !== recipient.sent_by_account_id) return false;
                  // Check API limit with batch usage
                  if (a.api_credential_id) {
                    const batchUsed = batchApiUsage.get(a.api_credential_id) || 0;
                    const totalUsage = (apiUsageCounts.get(a.api_credential_id) || 0) + batchUsed;
                    if (totalUsage >= apiDailyLimit) return false;
                  }
                  return true;
                })
              : null;
          }

          // If no assigned account, use round-robin to distribute evenly
          if (!account) {
            // Start from round-robin position and find first eligible account
            for (let i = 0; i < campaignUsableAccounts.length; i++) {
              const idx = (roundRobinIndex + i) % campaignUsableAccounts.length;
              const a = campaignUsableAccounts[idx];
              
              if (failedAccountIds.includes(a.id)) continue;
              
              // Check API limit with batch usage
              if (a.api_credential_id) {
                const batchUsed = batchApiUsage.get(a.api_credential_id) || 0;
                const totalUsage = (apiUsageCounts.get(a.api_credential_id) || 0) + batchUsed;
                if (totalUsage >= apiDailyLimit) continue;
              }
              
              account = a;
              break;
            }
          }

          if (!account) {
            // Check if this recipient has exhausted all possible accounts
            const eligibleAccounts = campaignUsableAccounts.filter((a: any) => 
              !failedAccountIds.includes(a.id)
            );
            
            if (eligibleAccounts.length === 0 && failedAccountIds.length > 0) {
              // This recipient has tried all possible accounts - mark as failed
              console.log(`[get-batch-tasks] Recipient ${recipient.id} has no eligible accounts (tried ${failedAccountIds.length}) - marking failed`);
              
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "failed",
                  failed_reason: `No eligible accounts left (tried ${failedAccountIds.length} accounts)`,
                  sent_at: new Date().toISOString()
                })
                .eq("id", recipient.id);

              // Increment campaign failed count
              await supabase.rpc("increment_campaign_failed_count", { cid: recipient.campaign_id });
              recipientsWithNoAccounts++;
            }
            // Skip this recipient for now (accounts may become available later)
            continue;
          }

          // Mark recipient as "sending" and assign account + track API usage
          await supabase
            .from("campaign_recipients")
            .update({ status: "sending", sent_by_account_id: account.id, api_credential_id: account.api_credential_id })
            .eq("id", recipient.id)
            .eq("status", "pending");

          // Track API usage in this batch
          if (account.api_credential_id) {
            batchApiUsage.set(
              account.api_credential_id,
              (batchApiUsage.get(account.api_credential_id) || 0) + 1
            );
          }

          // Personalize message
          const personalizedMessage = (campaign.message_template || '')
            .replace(/{name}/g, recipient.name || 'there')
            .replace(/{phone}/g, recipient.phone_number);

          const apiCred = account.telegram_api_credentials;

          // Get campaign metadata for this recipient
          const campaignMeta = campaignLookup.get(recipient.campaign_id) || { seat_id: null, name: null };

          tasks.push({
            task: "send",
            message: {
              content: personalizedMessage,
              campaign_recipient_id: recipient.id,
            },
            recipient: recipient.phone_number,
            recipient_name: recipient.name,
            // Include campaign metadata so report-task-result doesn't need to refetch
            campaign_id: recipient.campaign_id,
            campaign_seat_id: campaignMeta.seat_id,
            campaign_name: campaignMeta.name,
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
              api_credential_id: account.api_credential_id,
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

          // NO usedAccountIds tracking - allow same account to send multiple messages per batch
          console.log(`[get-batch-tasks] Added task for ${recipient.phone_number} via ${account.phone_number}`);
        }
      }

      // Recount pending after potential failures
      const { count: remainingPending } = await supabase
        .from("campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .in("campaign_id", campaignIds);
      
      // Calculate if more tasks are pending (for immediate repoll)
      const morePending = (remainingPending || 0) > 0;
      const delayAfter = morePending && tasks.length > 0 ? 0 : campaignPollingInterval;
      
      console.log(`[get-batch-tasks] Campaign returning ${tasks.length} tasks, remaining pending: ${remainingPending}, delay: ${delayAfter}s`);
      
      return new Response(JSON.stringify({
        tasks,
        delay_after: delayAfter,
        stagger_min: campaignStaggerMin,
        stagger_max: campaignStaggerMax,
        more_pending: morePending,
        accounts_available: campaignUsableAccounts.length,
        api_usage: Object.fromEntries(apiUsageCounts),
        api_limit: apiDailyLimit,
        stop_signal: tasks.length === 0 && !morePending
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // LIVECHAT RUNNER: Get pending outgoing messages
    // For livechat, we need ALL accounts (active + restricted) to receive and send messages
    if (runner === "livechat") {
      // Fetch active + restricted accounts specifically for livechat
      const { data: livechatAccounts } = await supabase
        .from("telegram_accounts")
        .select("*, telegram_api_credentials(*), proxies!fk_proxy(*)")
        .in("status", ["active", "restricted"])
        .or(`restricted_until.is.null,restricted_until.lt.${now}`);

      // Filter to only those with active proxies
      const livechatUsableAccounts = (livechatAccounts || []).filter((a: any) => {
        if (!a.proxy_id) return false;
        if (!a.proxies || a.proxies.status !== 'active') return false;
        return true;
      });

      console.log(`[get-batch-tasks] Livechat: ${livechatUsableAccounts.length} accounts (active + restricted with active proxies)`);

      const actualBatchSize = Math.min(batch_size || 50, livechatUsableAccounts.length);
      
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
          
          // Find the account for this conversation from livechat accounts
          const account = livechatUsableAccounts.find((a: any) => 
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
            recipient_telegram_id: conv.recipient_telegram_id,
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
      
      // For livechat, return ALL active + restricted accounts for connection
      // This ensures all accounts can receive incoming messages
      const accountsForConnection = livechatUsableAccounts.map((a: any) => ({
        id: a.id,
        phone_number: a.phone_number,
        session_data: a.session_data,
        device_model: a.device_model,
        system_version: a.system_version,
        app_version: a.app_version,
        lang_code: a.lang_code,
        system_lang_code: a.system_lang_code,
        api_id: a.telegram_api_credentials?.api_id || a.api_id,
        api_hash: a.telegram_api_credentials?.api_hash || a.api_hash,
        proxy_id: a.proxy_id,
        proxy: a.proxies ? {
          host: a.proxies.host,
          port: a.proxies.port,
          username: a.proxies.username,
          password: a.proxies.password,
          proxy_type: a.proxies.proxy_type,
          type: a.proxies.proxy_type,
        } : null,
      }));
      
      return new Response(JSON.stringify({
        tasks,
        accounts: accountsForConnection,
        delay_after: 1, // 1-second polling for livechat
        accounts_available: livechatUsableAccounts.length,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
