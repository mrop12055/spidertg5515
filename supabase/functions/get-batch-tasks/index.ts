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

    // Record runner heartbeat (fire-and-forget, don't wait)
    if (runner) {
      const baseRunnerName = runner.replace(/_batch$/, '').replace(/_chat$/, '');
      supabase
        .from("runner_heartbeats")
        .upsert({
          runner_name: baseRunnerName,
          last_seen: new Date().toISOString(),
          status: 'online'
        }, { onConflict: 'runner_name' })
        .then(() => {});
    }

    // Load settings from database (lightweight)
    const nowIso = new Date().toISOString();
    const { data: settingsData } = await supabase
      .from("app_settings")
      .select("key, value");

    // Dynamic batch sizes from settings
    let warmupBatchSize = 100; // Default for warmup
    let campaignBatchSize = 100; // Default for campaign

    // Campaign speed settings (server-controlled)
    let campaignPollingInterval = 3;
    let campaignMessagesPerAccountPerDay = 25;
    if (settingsData) {
      for (const setting of settingsData) {
        const value = setting.value as Record<string, unknown>;
        if (setting.key === "message_timing" && value) {
          MESSAGE_DELAY_MIN_SECONDS = (value.minDelaySeconds as number) || MESSAGE_DELAY_MIN_SECONDS;
          MESSAGE_DELAY_MAX_SECONDS = (value.maxDelaySeconds as number) || MESSAGE_DELAY_MAX_SECONDS;
        } else if (setting.key === "account_limits" && value) {
          DAILY_MESSAGE_LIMIT = (value.dailyMessageLimit as number) || DAILY_MESSAGE_LIMIT;
        } else if (setting.key === "warmup_batch_size" && value) {
          // Read warmup batch size from app_settings
          warmupBatchSize = (value.batchSize as number) || warmupBatchSize;
        } else if (setting.key === "campaign_speed" && value) {
          // Campaign speed settings
          campaignPollingInterval = (value.pollingInterval as number) ?? campaignPollingInterval;
          campaignBatchSize = (value.batchSize as number) ?? campaignBatchSize;
          campaignMessagesPerAccountPerDay = (value.messagesPerAccountPerDay as number) ?? campaignMessagesPerAccountPerDay;
        }
      }
    }

    // EARLY EXIT: avoid heavy account fetch when there's clearly nothing to do
    if (runner === "campaign") {
      const { data: runningCampaigns } = await supabase
        .from("campaigns")
        .select("id")
        .eq("status", "running");

      if (!runningCampaigns || runningCampaigns.length === 0) {
        return new Response(
          JSON.stringify({
            tasks: [],
            delay_after: campaignPollingInterval,
            reason: "No running campaigns",
            stop_signal: true,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    if (runner === "warmup_chat") {
      const { data: dueWarmupMessages } = await supabase
        .from("warmup_messages")
        .select("id")
        .eq("status", "pending")
        .lte("scheduled_at", nowIso)
        .limit(1);

      if (!dueWarmupMessages || dueWarmupMessages.length === 0) {
        return new Response(
          JSON.stringify({
            tasks: [],
            delay_after: 5,
            reason: "No pending warmup messages",
            accounts_available: 0,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    // Load active accounts only when needed
    // For LIVECHAT: Include restricted accounts (they can reply to existing chats)
    // For CAMPAIGN: Exclude restricted accounts (no new outreach)
    const isLivechatRunner = runner === "livechat";
    
    let activeAccounts: any[] = [];
    let accountsError: any = null;
    
    if (isLivechatRunner) {
      // LIVECHAT: Include all active accounts, even if restricted (they can reply to existing conversations)
      const result = await supabase
        .from("telegram_accounts")
        .select("*, telegram_api_credentials(*), proxies!fk_proxy(*)")
        .eq("status", "active");
      activeAccounts = result.data || [];
      accountsError = result.error;
      console.log(`[get-batch-tasks] Livechat: ${activeAccounts.length} active accounts (including restricted)`);
    } else {
      // CAMPAIGN/WARMUP: Exclude restricted accounts (no new outreach allowed)
      // First get all active accounts, then filter out those with future restricted_until in code
      // This avoids Supabase .or() timestamp comparison issues
      const result = await supabase
        .from("telegram_accounts")
        .select("*, telegram_api_credentials(*), proxies!fk_proxy(*)")
        .eq("status", "active");
      
      const allActiveAccounts = result.data || [];
      
      // Filter out accounts that are still restricted (restricted_until in the future)
      activeAccounts = allActiveAccounts.filter((a: any) => {
        if (!a.restricted_until) return true; // No restriction
        const restrictedUntil = new Date(a.restricted_until);
        const now = new Date();
        if (restrictedUntil > now) {
          console.log(`[get-batch-tasks] SKIPPING account ${a.phone_number} - RESTRICTED until ${a.restricted_until}`);
          return false;
        }
        return true; // Restriction has expired
      });
      
      accountsError = result.error;
      console.log(`[get-batch-tasks] Campaign/Warmup: ${activeAccounts.length} active unrestricted accounts (filtered from ${allActiveAccounts.length} total active)`);
    }

    if (accountsError || !activeAccounts || activeAccounts.length === 0) {
      console.log("[get-batch-tasks] No active accounts available");
      return new Response(
        JSON.stringify({
          tasks: [],
          delay_after: 30,
          reason: "No active accounts",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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

    // Filter to accounts under daily limit (uses campaign speed setting)
    // IMPORTANT: Livechat replies must NOT be blocked by daily limits/restrictions.
    // Daily limits are intended to throttle NEW outreach (campaign/warmup), not ongoing conversations.
    const usableAccounts = runner === "livechat"
      ? accountsWithActiveProxy
      : accountsWithActiveProxy.filter((a: any) => {
          // Use campaign-specific limit from admin settings, fallback to account's own limit, then default
          const limit = campaignMessagesPerAccountPerDay || a.daily_limit || DAILY_MESSAGE_LIMIT;
          const sentToday = a.messages_sent_today ?? 0;
          return sentToday < limit;
        });

    if (runner !== "livechat" && usableAccounts.length === 0) {
      console.log("[get-batch-tasks] All accounts at daily limit");
      return new Response(
        JSON.stringify({
          tasks: [],
          delay_after: 60,
          reason: "All accounts at daily limit",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    
    console.log(`[get-batch-tasks] ${usableAccounts.length} accounts with active proxies ready`);

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
          delay_after: campaignPollingInterval,
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

      // Get campaign recipients processed in last 24h with their API (sent, failed, or currently sending all count against quota)
      const { data: recentSends } = await supabase
        .from("campaign_recipients")
        .select("api_credential_id, status, sent_at, scheduled_at")
        .in("status", ["sent", "failed", "sending"])
        .not("api_credential_id", "is", null)
        .or(`sent_at.gte.${oneDayAgo},scheduled_at.gte.${oneDayAgo}`);

      
      // Count usage per API - use sent_at or scheduled_at for timing
      const apiUsageCounts = new Map<string, number>();
      (recentSends || []).forEach((r: any) => {
        if (r.api_credential_id) {
          const timestamp = r.sent_at || r.scheduled_at;
          if (timestamp && new Date(timestamp) >= new Date(oneDayAgo)) {
            apiUsageCounts.set(r.api_credential_id, (apiUsageCounts.get(r.api_credential_id) || 0) + 1);
          }
        }
      });
      // Load API daily limit from settings (default 80)
      let apiDailyLimit = 80;
      const apiLimitSetting = settingsData?.find((s: any) => s.key === "api_limits");
      if (apiLimitSetting?.value?.dailyLimitPerApi) {
        apiDailyLimit = (apiLimitSetting.value as { dailyLimitPerApi?: number }).dailyLimitPerApi || 80;
      }

      console.log(`[get-batch-tasks] API usage (24h): ${JSON.stringify(Object.fromEntries(apiUsageCounts))}, limit: ${apiDailyLimit}`);

      // Get all available APIs sorted by usage (least used first)
      const { data: allApis } = await supabase
        .from("telegram_api_credentials")
        .select("id, name, is_active")
        .eq("is_active", true);
      
      const availableApis = (allApis || [])
        .filter((api: any) => (apiUsageCounts.get(api.id) || 0) < apiDailyLimit)
        .sort((a: any, b: any) => {
          const usageA = apiUsageCounts.get(a.id) || 0;
          const usageB = apiUsageCounts.get(b.id) || 0;
          return usageA - usageB; // Least used first
        });
      
      console.log(`[get-batch-tasks] Available APIs: ${availableApis.map((a: any) => `${a.name}:${apiUsageCounts.get(a.id) || 0}/${apiDailyLimit}`).join(', ')}`);
      
      // If no APIs available, skip all accounts
      if (availableApis.length === 0) {
        console.log(`[get-batch-tasks] No APIs available under limit - skipping all accounts`);
        return new Response(JSON.stringify({ tasks: [], message: "All APIs at daily limit" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // SMART API DISTRIBUTION: Assign least-used API DYNAMICALLY per account
      // Track incremental usage so each account gets the API with lowest current+pending usage
      const dynamicApiUsage = new Map<string, number>();
      availableApis.forEach((api: any) => {
        dynamicApiUsage.set(api.id, apiUsageCounts.get(api.id) || 0);
      });
      
      const accountsWithAvailableApi = usableAccounts.map((a: any) => {
        // Find the API with CURRENT lowest usage (including pending assignments from this loop)
        let bestApi = null;
        let lowestUsage = Infinity;
        
        for (const api of availableApis) {
          const currentUsage = dynamicApiUsage.get(api.id) || 0;
          if (currentUsage < lowestUsage && currentUsage < apiDailyLimit) {
            lowestUsage = currentUsage;
            bestApi = api;
          }
        }
        
        if (!bestApi) {
          // All APIs at limit - use original account's API or first available
          bestApi = availableApis[0];
        }
        
        // Increment the dynamic usage counter for this API
        dynamicApiUsage.set(bestApi.id, (dynamicApiUsage.get(bestApi.id) || 0) + 1);
        
        if (a.api_credential_id !== bestApi.id) {
          console.log(`[get-batch-tasks] SMART ROUTE: ${a.phone_number} -> ${bestApi.name} (${lowestUsage}/${apiDailyLimit})`);
        }
        
        return { ...a, api_credential_id: bestApi.id, _bestApi: bestApi };
      });

      console.log(`[get-batch-tasks] Dynamic API distribution: ${JSON.stringify(Object.fromEntries(dynamicApiUsage))}`);

      // ========== CAMPAIGN-SPECIFIC DAILY LIMIT PER ACCOUNT ==========
      // Count how many campaign messages each account has sent TODAY (UTC)
      // Include both 'sent' and 'sending' to prevent over-assignment during parallel processing
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todayStartIso = todayStart.toISOString();

      // IMPORTANT: Filter by today on the DB side to avoid the 1000-row default limit skewing counts.
      // Use sent_at when available, otherwise scheduled_at (sending rows may not have sent_at yet).
      const { data: todayCampaignSends } = await supabase
        .from("campaign_recipients")
        .select("sent_by_account_id, status, sent_at, scheduled_at")
        .in("status", ["sent", "sending"])
        .not("sent_by_account_id", "is", null)
        .or(`sent_at.gte.${todayStartIso},scheduled_at.gte.${todayStartIso}`);

      // Count sends per account - only count those from today
      const accountCampaignSentToday = new Map<string, number>();
      (todayCampaignSends || []).forEach((r: any) => {
        if (!r.sent_by_account_id) return;
        
        // Use sent_at if available, otherwise scheduled_at
        const timestamp = r.sent_at || r.scheduled_at;
        if (!timestamp) return;
        
        // Only count if timestamp is from today (UTC)
        const recordDate = new Date(timestamp);
        if (recordDate >= todayStart) {
          accountCampaignSentToday.set(
            r.sent_by_account_id,
            (accountCampaignSentToday.get(r.sent_by_account_id) || 0) + 1
          );
        }
      });

      console.log(`[get-batch-tasks] Campaign sends today per account: ${JSON.stringify(Object.fromEntries(accountCampaignSentToday))}, limit: ${campaignMessagesPerAccountPerDay}`);

      // Filter accounts for campaigns using campaign-specific per-account limit
      // Also calculate remaining quota for each account
      const campaignUsableAccounts = accountsWithAvailableApi.filter((a: any) => {
        const sentTodayCampaign = accountCampaignSentToday.get(a.id) || 0;
        if (sentTodayCampaign >= campaignMessagesPerAccountPerDay) {
          console.log(`[get-batch-tasks] SKIP account ${a.phone_number} - already sent ${sentTodayCampaign}/${campaignMessagesPerAccountPerDay} campaign messages today`);
          return false;
        }
        return true;
      });

      // Track API usage in this batch to avoid over-assigning
      const batchApiUsage = new Map<string, number>();
      
      // CRITICAL: Track per-account usage WITHIN THIS BATCH to enforce daily limits
      // This prevents assigning 2 tasks to an account that only has 1 slot remaining
      const batchAccountUsage = new Map<string, number>();
      
      // Helper function to get remaining quota for an account
      const getRemainingAccountQuota = (accountId: string): number => {
        const sentToday = accountCampaignSentToday.get(accountId) || 0;
        const batchAssigned = batchAccountUsage.get(accountId) || 0;
        return campaignMessagesPerAccountPerDay - sentToday - batchAssigned;
      };

      // ========== STUCK SENDING RECOVERY (TIME-BASED) ==========
      // Find "sending" recipients that have been stuck for over 2 minutes
      // These are tasks that were assigned but never completed (runner crash, timeout, etc.)
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      
      // Query for sending recipients with scheduled_at older than 2 minutes
      const { data: stuckSendingRecipients } = await supabase
        .from("campaign_recipients")
        .select("id, campaign_id, sent_by_account_id")
        .eq("status", "sending")
        .in("campaign_id", campaignIds)
        .lt("scheduled_at", twoMinutesAgo)
        .limit(200);

      if (stuckSendingRecipients && stuckSendingRecipients.length > 0) {
        const stuckIds = stuckSendingRecipients.map(r => r.id);
        console.log(`[get-batch-tasks] Recovering ${stuckIds.length} stuck sending recipients (scheduled > 2 min ago)`);
        
        // Batch update all stuck recipients at once - reset to pending for retry
        await supabase
          .from("campaign_recipients")
          .update({
            status: "pending",
            sent_by_account_id: null,
            api_credential_id: null,
            scheduled_at: null,
            failed_reason: null
          })
          .in("id", stuckIds);
      }

      // ========== RELEASE QUEUED RECIPIENTS TO PENDING (PARALLEL) ==========
      // This is the core queue mechanism - gradually release recipients based on batch settings
      // Process all campaigns in parallel to avoid sequential delays
      // IMPORTANT: Limit release to available accounts, not just batch size setting
      const effectiveReleaseLimit = campaignBatchSize === 0 
        ? campaignUsableAccounts.length 
        : Math.min(campaignBatchSize, campaignUsableAccounts.length);
      
      console.log(`[get-batch-tasks] Queue release limit: ${effectiveReleaseLimit} (batch setting: ${campaignBatchSize}, usable accounts: ${campaignUsableAccounts.length})`);
      
      await Promise.all(runningCampaigns.map(async (campaign) => {
        // Count currently processing (pending + sending)
        const { count: inProgressCount } = await supabase
          .from("campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", campaign.id)
          .in("status", ["pending", "sending"]);

        const currentInProgress = inProgressCount || 0;

        // Only release more if below threshold (limited by available accounts)
        if (currentInProgress < effectiveReleaseLimit) {
          const toRelease = effectiveReleaseLimit - currentInProgress;
          
          // Get queued recipients to release (oldest first)
          const { data: queuedToRelease } = await supabase
            .from("campaign_recipients")
            .select("id")
            .eq("campaign_id", campaign.id)
            .eq("status", "queued")
            .order("id", { ascending: true })
            .limit(toRelease);

          if (queuedToRelease && queuedToRelease.length > 0) {
            // Smart API assignment for each queued recipient
            // Distribute across APIs with lowest usage
            for (const queued of queuedToRelease) {
              // Find API with current lowest usage (including what we've assigned)
              let bestApiId = availableApis[0]?.id || null;
              let lowestUsage = Infinity;
              
              for (const api of availableApis) {
                const currentUsage = dynamicApiUsage.get(api.id) || 0;
                if (currentUsage < lowestUsage && currentUsage < apiDailyLimit) {
                  lowestUsage = currentUsage;
                  bestApiId = api.id;
                }
              }
              
              // Increment the dynamic usage counter
              if (bestApiId) {
                dynamicApiUsage.set(bestApiId, (dynamicApiUsage.get(bestApiId) || 0) + 1);
              }
              
              await supabase
                .from("campaign_recipients")
                .update({ 
                  status: "pending",
                  scheduled_at: new Date().toISOString(),
                  api_credential_id: bestApiId
                })
                .eq("id", queued.id);
            }

            console.log(`[get-batch-tasks] QUEUE RELEASE: Campaign ${campaign.id} - released ${queuedToRelease.length} (limit: ${effectiveReleaseLimit}, in-progress: ${currentInProgress})`);
          }
        }
      }));

      // ========== GET PENDING RECIPIENTS ==========
      // Get pending recipients with their failed_account_ids
      // Use campaignBatchSize for limit (before actualBatchSize is calculated)
      // Include seat_id for multi-seat campaign support
      const { data: pendingRecipients } = await supabase
        .from("campaign_recipients")
        .select("*, campaigns!inner(id, status, message_template, batch_size, seat_id, name)")
        .eq("status", "pending")
        .eq("campaigns.status", "running")
        .limit(campaignBatchSize === 0 ? 200 : campaignBatchSize * 2); // Fetch only what we need

      // Count total pending after recovery
      const totalPending = pendingRecipients?.length || 0;

      // ========== NO PENDING RECIPIENTS = CHECK QUEUE OR AUTO-COMPLETE ==========
      if (totalPending === 0) {
        console.log(`[get-batch-tasks] No pending recipients - checking queue and completion status`);
        
        // FIRST: Check if ANY campaigns still have queued recipients - if so, DON'T auto-complete
        // This is a global check to prevent race conditions where queue release hasn't happened yet
        const { count: totalQueuedAcrossAllCampaigns } = await supabase
          .from("campaign_recipients")
          .select("id", { count: "exact", head: true })
          .in("campaign_id", campaignIds)
          .eq("status", "queued");
        
        if ((totalQueuedAcrossAllCampaigns || 0) > 0) {
          console.log(`[get-batch-tasks] ${totalQueuedAcrossAllCampaigns} recipients still queued - NOT completing any campaigns, waiting for queue release`);
          return new Response(JSON.stringify({
            tasks: [],
            delay_after: campaignPollingInterval,
            reason: `${totalQueuedAcrossAllCampaigns} recipients still queued - waiting for next release cycle`,
            stop_signal: false
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        
        // No queued recipients globally - now check each campaign individually for completion
        await Promise.all(runningCampaigns.map(async (campaign) => {
          // Double-check this specific campaign has no queued/pending/sending recipients
          const [{ count: stillQueued }, { count: stillPendingOrSending }] = await Promise.all([
            supabase
              .from("campaign_recipients")
              .select("id", { count: "exact", head: true })
              .eq("campaign_id", campaign.id)
              .eq("status", "queued"),
            supabase
              .from("campaign_recipients")
              .select("id", { count: "exact", head: true })
              .eq("campaign_id", campaign.id)
              .in("status", ["pending", "sending"])
          ]);

          // Only complete if BOTH queue and pending/sending are empty (strict check)
          if ((stillQueued || 0) === 0 && (stillPendingOrSending || 0) === 0) {
            // EXTRA SAFETY: Verify there are actual sent/failed recipients (not an empty campaign)
            const { count: processedCount } = await supabase
              .from("campaign_recipients")
              .select("id", { count: "exact", head: true })
              .eq("campaign_id", campaign.id)
              .in("status", ["sent", "failed"]);
            
            if ((processedCount || 0) > 0) {
              console.log(`[get-batch-tasks] Auto-completing campaign ${campaign.id} - all ${processedCount} recipients processed`);
              await supabase
                .from("campaigns")
                .update({ status: "completed", updated_at: new Date().toISOString() })
                .eq("id", campaign.id);
            } else {
              console.log(`[get-batch-tasks] Campaign ${campaign.id} has no processed recipients - NOT completing (may be stuck)`);
            }
          } else {
            console.log(`[get-batch-tasks] Campaign ${campaign.id} still has ${stillQueued || 0} queued, ${stillPendingOrSending || 0} pending/sending`);
          }
        }));

        return new Response(JSON.stringify({
          tasks: [],
          delay_after: campaignPollingInterval,
          reason: "No pending recipients - campaigns checked for completion",
          stop_signal: false
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ========== NO USABLE ACCOUNTS ==========
      // IMPORTANT: Do NOT mark campaign as completed here.
      // If accounts are temporarily unavailable (daily limit / restricted / proxy), the campaign should keep waiting.
      if (campaignUsableAccounts.length === 0) {
        console.log(`[get-batch-tasks] No usable accounts - waiting (not completing campaigns)`);

        return new Response(
          JSON.stringify({
            tasks: [],
            delay_after: Math.max(campaignPollingInterval, 30),
            reason: "No usable accounts (restricted/daily limit/proxy) - waiting",
            stop_signal: false,
            accounts_available: 0,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Use campaignBatchSize from settings, limited by available accounts
      // If batchSize is 0, treat as "unlimited" - use all available accounts
      const effectiveBatchSize = campaignBatchSize === 0 ? 9999 : campaignBatchSize;
      const actualBatchSize = Math.min(effectiveBatchSize, campaignUsableAccounts.length);
      console.log(`[get-batch-tasks] Campaign using batch size: ${actualBatchSize} (settings: ${campaignBatchSize}${campaignBatchSize === 0 ? ' [unlimited]' : ''}, accounts: ${campaignUsableAccounts.length}, limit: ${campaignMessagesPerAccountPerDay}/account)`);

      // ========== OPTIMIZED BATCH PROCESSING ==========
      // Collect all updates to perform in single batch at the end
      const recipientsToUpdate: { id: string; account_id: string; api_credential_id: string | null }[] = [];
      const recipientsToFail: { id: string; campaign_id: string; failedCount: number }[] = [];

      if (pendingRecipients && pendingRecipients.length > 0) {
        for (const recipient of pendingRecipients) {
          if (tasks.length >= actualBatchSize) break;

          const campaign = recipient.campaigns;
          const failedAccountIds: string[] = recipient.failed_account_ids || [];
          const failedApiIds: string[] = recipient.failed_api_ids || [];  // Track failed APIs
          
          // Find eligible account - MUST check remaining quota (daily limit - sent today - batch assigned)
          // ALSO must check that account's API is NOT in failedApiIds
          let account = null;
          
          if (recipient.sent_by_account_id) {
            const isNotFailed = !failedAccountIds.includes(recipient.sent_by_account_id);
            account = isNotFailed 
              ? campaignUsableAccounts.find((a: any) => {
                  if (a.id !== recipient.sent_by_account_id) return false;
                  // CRITICAL: Check remaining quota instead of just usedAccountIds
                  if (getRemainingAccountQuota(a.id) <= 0) return false;
                  // CRITICAL: Skip if this account's API already failed for this recipient
                  if (a.api_credential_id && failedApiIds.includes(a.api_credential_id)) return false;
                  if (a.api_credential_id) {
                    const batchUsed = batchApiUsage.get(a.api_credential_id) || 0;
                    const totalUsage = (apiUsageCounts.get(a.api_credential_id) || 0) + batchUsed;
                    if (totalUsage >= apiDailyLimit) return false;
                  }
                  return true;
                })
              : null;
          }

          if (!account) {
            // ROUND-ROBIN DISTRIBUTION: Prioritize accounts with LEAST batch usage first
            // This ensures even distribution across accounts (1 message each before reusing)
            const sortedAccounts = [...campaignUsableAccounts].sort((a: any, b: any) => {
              // PRIMARY: Sort by batch usage (least used in this batch first)
              const batchUsageA = batchAccountUsage.get(a.id) || 0;
              const batchUsageB = batchAccountUsage.get(b.id) || 0;
              if (batchUsageA !== batchUsageB) {
                return batchUsageA - batchUsageB;
              }
              // SECONDARY: Sort by API usage for load balancing
              const apiUsageA = (apiUsageCounts.get(a.api_credential_id) || 0) + (batchApiUsage.get(a.api_credential_id) || 0);
              const apiUsageB = (apiUsageCounts.get(b.api_credential_id) || 0) + (batchApiUsage.get(b.api_credential_id) || 0);
              return apiUsageA - apiUsageB;
            });
            
            account = sortedAccounts.find((a: any) => {
              // CRITICAL: Check remaining quota instead of just usedAccountIds
              if (getRemainingAccountQuota(a.id) <= 0) return false;
              if (failedAccountIds.includes(a.id)) return false;
              // CRITICAL: Skip accounts whose API already failed for this recipient
              if (a.api_credential_id && failedApiIds.includes(a.api_credential_id)) {
                return false;
              }
              if (a.api_credential_id) {
                const batchUsed = batchApiUsage.get(a.api_credential_id) || 0;
                const totalUsage = (apiUsageCounts.get(a.api_credential_id) || 0) + batchUsed;
                if (totalUsage >= apiDailyLimit) return false;
              }
              return true;
            });
          }

          if (!account) {
            // Check if any accounts have remaining quota (excluding failed ones AND failed APIs)
            const eligibleAccounts = campaignUsableAccounts.filter((a: any) => 
              !failedAccountIds.includes(a.id) && 
              getRemainingAccountQuota(a.id) > 0 &&
              (!a.api_credential_id || !failedApiIds.includes(a.api_credential_id))
            );
            
            if (eligibleAccounts.length === 0 && (failedAccountIds.length > 0 || failedApiIds.length > 0)) {
              console.log(`[get-batch-tasks] Recipient ${recipient.id} FAILED - no eligible accounts (failed accounts: ${failedAccountIds.length}, failed APIs: ${failedApiIds.length})`);
              recipientsToFail.push({ 
                id: recipient.id, 
                campaign_id: recipient.campaign_id, 
                failedCount: failedAccountIds.length 
              });
            }
            continue;
          }

          // Log when assigning after API retry
          if (failedApiIds.length > 0) {
            console.log(`[get-batch-tasks] Recipient ${recipient.id} assigned to account ${account.phone_number} with API ${account.api_credential_id} (avoiding ${failedApiIds.length} failed APIs)`);
          }

          // Collect for batch update
          recipientsToUpdate.push({
            id: recipient.id,
            account_id: account.id,
            api_credential_id: account.api_credential_id
          });

          // CRITICAL: Track account usage in this batch to enforce daily limits
          batchAccountUsage.set(
            account.id,
            (batchAccountUsage.get(account.id) || 0) + 1
          );

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
          // For multi-seat campaigns: prioritize recipient-level seat_id over campaign-level
          const recipientCampaign = recipient.campaigns;
          const recipientSeatId = recipient.seat_id || recipientCampaign?.seat_id || null;
          const campaignName = recipientCampaign?.name || null;

          tasks.push({
            task: "send",
            message: {
              content: personalizedMessage,
              campaign_recipient_id: recipient.id,
            },
            recipient: recipient.phone_number,
            recipient_name: recipient.name,
            campaign_id: recipient.campaign_id,
            campaign_seat_id: recipientSeatId,  // Recipient seat_id > campaign seat_id
            campaign_name: campaignName,
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
            // IMPORTANT: Telegram session connection lifecycle is controlled by the runner.
            // For campaign mode, the runner should keep connections only during ONE batch,
            // then disconnect ALL clients before requesting the next batch.
            disconnect_after: false,
          });

          // Note: Using batchAccountUsage for quota tracking, usedAccountIds still used for warmup/livechat
        }
      }

      // ========== BATCH UPDATE ALL RECIPIENTS AT ONCE ==========
      if (recipientsToUpdate.length > 0) {
        // Group by account+api combo and update in batches
        const updatePromises = recipientsToUpdate.map(r =>
          supabase
            .from("campaign_recipients")
            .update({ 
              status: "sending", 
              sent_by_account_id: r.account_id, 
              api_credential_id: r.api_credential_id 
            })
            .eq("id", r.id)
            .eq("status", "pending")
        );
        await Promise.all(updatePromises);
        console.log(`[get-batch-tasks] Batch updated ${recipientsToUpdate.length} recipients to sending`);
      }

      // Batch fail recipients with no eligible accounts
      if (recipientsToFail.length > 0) {
        const failIds = recipientsToFail.map(r => r.id);
        await supabase
          .from("campaign_recipients")
          .update({
            status: "failed",
            failed_reason: "No eligible accounts left",
            sent_at: new Date().toISOString()
          })
          .in("id", failIds);
        
        // Increment failed counts in parallel (batch RPC calls)
        const failedByCampaign = new Map<string, number>();
        recipientsToFail.forEach(r => {
          failedByCampaign.set(r.campaign_id, (failedByCampaign.get(r.campaign_id) || 0) + 1);
        });
        // Execute all RPC calls in parallel
        const rpcCalls = [];
        for (const [cid, count] of failedByCampaign) {
          for (let i = 0; i < count; i++) {
            rpcCalls.push(supabase.rpc("increment_campaign_failed_count", { cid }).then(() => {}));
          }
        }
        await Promise.all(rpcCalls);
        console.log(`[get-batch-tasks] Batch failed ${recipientsToFail.length} recipients with no accounts`);
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
        batch_id: crypto.randomUUID(),
        disconnect_after_batch: true,
        disconnect_scope: "batch",
        tasks,
        delay_after: delayAfter,
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
    if (runner === "livechat") {
      const actualBatchSize = Math.min(batch_size || 50, usableAccounts.length);
      
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
      
      // For livechat, also return accounts for initial connection
      // This helps the runner connect accounts that need message handlers
      const accountsForConnection = usableAccounts.map((a: any) => ({
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
        accounts_available: usableAccounts.length,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ACCOUNT RUNNER: Get batch of account management tasks (sync_profile, change_name, etc.)
    if (runner === "account") {
      const accountBatchSize = Math.min(batch_size, 20); // Max 20 parallel account tasks
      
      // Auto-recover stuck tasks (in_progress for more than 90 seconds)
      // Uses updated_at which is set when status changes to in_progress
      const stuckCutoffIso = new Date(Date.now() - 90 * 1000).toISOString();
      await supabase
        .from("account_check_tasks")
        .update({ status: "pending" })
        .eq("status", "in_progress")
        .lt("updated_at", stuckCutoffIso);
      
      // Get pending account tasks
      const { data: checkTasks } = await supabase
        .from("account_check_tasks")
        // IMPORTANT: Only tasks with a resolvable telegram_accounts relation can be processed.
        .select("*, telegram_accounts(*, telegram_api_credentials(*), proxies!fk_proxy(*))")
        .eq("status", "pending")
        .in("task_type", [
          "spambot_check",
          "change_name",
          "privacy_settings",
          "change_password",
          "logout_sessions",
          "change_photo",
          "sync_profile",
          "verify_session",
        ])
        .order("created_at", { ascending: true })
        .limit(accountBatchSize);

      if (checkTasks && checkTasks.length > 0) {
        // Build the tasks we can actually execute BEFORE claiming them.
        const nowIso = new Date().toISOString();
        const claimIds: string[] = [];
        const failIds: string[] = [];

        for (const task of checkTasks as any[]) {
          const accountData = task.telegram_accounts;
          if (!accountData) {
            // If this happens, the row cannot be processed (usually missing/invalid relation).
            // Mark failed so it doesn't get stuck in_progress and doesn't loop forever.
            failIds.push(task.id);
            continue;
          }

          const apiCred = accountData.telegram_api_credentials;
          const proxyData = accountData.proxies;

          claimIds.push(task.id);
          tasks.push({
            task: task.task_type,
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
              proxy_id: accountData.proxy_id,
            },
            proxy: proxyData
              ? {
                  host: proxyData.host,
                  port: proxyData.port,
                  username: proxyData.username,
                  password: proxyData.password,
                  proxy_type: proxyData.proxy_type,
                  type: proxyData.proxy_type,
                }
              : null,
          });
        }

        if (failIds.length > 0) {
          console.warn(
            `[get-batch-tasks] ${failIds.length} account tasks missing account data; marking as failed`
          );
          await supabase
            .from("account_check_tasks")
            .update({
              status: "failed",
              completed_at: nowIso,
              result: "Task cannot be processed: missing account data (relation not resolved)",
            })
            .in("id", failIds);
        }

        if (claimIds.length === 0) {
          return new Response(
            JSON.stringify({
              tasks: [],
              delay_after: 15,
              reason: "No processable account tasks",
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Claim ONLY the tasks we are returning.
        await supabase
          .from("account_check_tasks")
          .update({ status: "in_progress" })
          .in("id", claimIds)
          .eq("status", "pending");

        console.log(
          `[get-batch-tasks] Returning ${tasks.length} account tasks for parallel processing`
        );

        return new Response(
          JSON.stringify({
            tasks,
            delay_after: tasks.length > 0 ? 1 : 3,
            batch_mode: true,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      // No tasks - return empty with 15s delay for account runner
      return new Response(JSON.stringify({
        tasks: [],
        delay_after: 15,
        reason: "No pending account tasks",
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
