import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LIVE_CONVERSATION_TIMEOUT_MINUTES = 5;

// Default values (will be overridden by database settings)
let WARMUP_DAYS = 0;
let MESSAGE_DELAY_MIN_SECONDS = 5;
let MESSAGE_DELAY_MAX_SECONDS = 15;
let ACCOUNT_SWITCH_DELAY_SECONDS = 30;
let DAILY_MESSAGE_LIMIT = 25;
let MESSAGES_PER_ACCOUNT = 10;

// Scheduler (rotation + cooldown)
let SCHEDULER_ENABLED = true;
let MAX_MESSAGES_BEFORE_ROTATION = 10;
let COOLDOWN_DURATION_SECONDS = 300;

// API rate limiting - 40 messages per API per 24 hours
const API_DAILY_LIMIT = 40;

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
    const { account_id, runner } = body as { account_id?: string; runner?: string };

    console.log(`[get-next-task] Request for runner: ${runner || 'all'}, account: ${account_id || 'any'}`);

    // Record runner heartbeat if runner name provided
    if (runner) {
      await supabase
        .from("runner_heartbeats")
        .upsert({
          runner_name: runner,
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
          ACCOUNT_SWITCH_DELAY_SECONDS = (value.accountSwitchDelaySeconds as number) || ACCOUNT_SWITCH_DELAY_SECONDS;
        } else if (setting.key === "account_limits" && value) {
          WARMUP_DAYS = (value.warmupDays as number) || WARMUP_DAYS;
          DAILY_MESSAGE_LIMIT = (value.dailyMessageLimit as number) || DAILY_MESSAGE_LIMIT;
          MESSAGES_PER_ACCOUNT = (value.messagesPerAccount as number) || MESSAGES_PER_ACCOUNT;
        } else if (setting.key === "scheduler" && value) {
          // If a value is missing, keep defaults
          if (typeof value.enabled === 'boolean') {
            SCHEDULER_ENABLED = value.enabled as boolean;
          }
          MAX_MESSAGES_BEFORE_ROTATION = (value.maxMessagesBeforeRotation as number) || MAX_MESSAGES_BEFORE_ROTATION;
          COOLDOWN_DURATION_SECONDS = (value.cooldownDuration as number) || COOLDOWN_DURATION_SECONDS;
        }
      }
      console.log(
        `[get-next-task] Loaded settings: delay=${MESSAGE_DELAY_MIN_SECONDS}-${MESSAGE_DELAY_MAX_SECONDS}s, switch=${ACCOUNT_SWITCH_DELAY_SECONDS}s, warmup=${WARMUP_DAYS}d, dailyLimit=${DAILY_MESSAGE_LIMIT}, perCampaign=${MESSAGES_PER_ACCOUNT}, rotate=${MAX_MESSAGES_BEFORE_ROTATION}, cooldown=${COOLDOWN_DURATION_SECONDS}s, enabled=${SCHEDULER_ENABLED}`
      );
    }

    // Maintenance: requeue "sending" messages that got stuck (e.g. runner crash / timeout).
    // We run this on every request because the update is a no-op unless something is actually stuck.
    // Using 30 seconds timeout for faster recovery of stuck messages
    const sendingCutoff = new Date(Date.now() - 30 * 1000).toISOString();
    const { data: resetRows, error: resetErr } = await supabase
      .from("messages")
      .update({
        status: "pending",
        failed_reason: "Requeued: stuck in sending",
      })
      .eq("status", "sending")
      .lt("created_at", sendingCutoff)
      .select("id");

    if (resetErr) {
      console.log(`[get-next-task] Maintenance: could not requeue stuck messages: ${resetErr.message}`);
    } else if (resetRows && resetRows.length > 0) {
      console.log(`[get-next-task] Maintenance: requeued ${resetRows.length} stuck message(s)`);
    }


    const now = new Date();

    // Get all active accounts with joins but LIMIT to prevent timeout
    // NOTE: select only the columns runners actually need (session_data is large but required for connection)
    // IMPORTANT: last_campaign_send_at is required for server-side rate limiting
    // IMPORTANT: api_credential_id is required for API-level rate limiting
    const ACCOUNT_WITH_JOINS_SELECT =
      "id,phone_number,status,proxy_id,session_data,api_id,api_hash,device_model,system_version,app_version,lang_code,system_lang_code,first_name,last_name,username,telegram_id,created_at,last_active,messages_sent_today,daily_limit,restricted_until,ban_reason,last_campaign_send_at,api_credential_id,auto_disabled,success_rate,telegram_api_credentials(id,api_id,api_hash,client_type,is_active),proxies!fk_proxy(id,host,port,username,password,proxy_type,status,country,detected_country,response_time,last_checked)" as const;

    const { data: activeAccountsRaw, error: activeAccountsError } = await supabase
      .from("telegram_accounts")
      .select(ACCOUNT_WITH_JOINS_SELECT as any)
      .eq("status", "active")
      .limit(60);

    // Get restricted accounts with limit
    const { data: restrictedAccountsRaw } = await supabase
      .from("telegram_accounts")
      .select(ACCOUNT_WITH_JOINS_SELECT as any)
      .eq("status", "restricted")
      .limit(40);

    // Get cooldown accounts with limit (auto-rotation cooldown)
    const { data: cooldownAccountsRaw } = await supabase
      .from("telegram_accounts")
      .select(ACCOUNT_WITH_JOINS_SELECT as any)
      .eq("status", "cooldown")
      .limit(40);

    // Get frozen accounts with limit (for live chat only)
    const { data: frozenAccountsRaw } = await supabase
      .from("telegram_accounts")
      .select(ACCOUNT_WITH_JOINS_SELECT as any)
      .eq("status", "frozen")
      .limit(40);

    const activeAccounts = (activeAccountsRaw as any[]) || [];
    const restrictedAccounts = (restrictedAccountsRaw as any[]) || [];
    const cooldownAccounts = (cooldownAccountsRaw as any[]) || [];
    const frozenAccounts = (frozenAccountsRaw as any[]) || [];

    // Auto-reactivate accounts after their cooldown/restriction window ends
    const nowIso = now.toISOString();
    await supabase
      .from("telegram_accounts")
      .update({ status: "active", restricted_until: null })
      .in("status", ["restricted", "cooldown"])
      .lte("restricted_until", nowIso);

    const isTimeRestricted = (a: any) => {
      if (!a?.restricted_until) return false;
      return new Date(a.restricted_until) > now;
    };

    // CRITICAL SAFETY CHECK: Only use accounts with active proxies
    const hasActiveProxy = (a: any) => {
      if (!a.proxy_id) {
        console.log(`[get-next-task] Account ${a.phone_number} has NO PROXY - skipping for safety`);
        return false;
      }
      if (!a.proxies || a.proxies.status !== 'active') {
        console.log(`[get-next-task] Account ${a.phone_number} proxy is NOT ACTIVE (${a.proxies?.status || 'missing'}) - skipping`);
        return false;
      }
      return true;
    };

    // Filter all accounts to only those with active proxies
    const activeAccountsWithProxy = (activeAccounts || []).filter(hasActiveProxy);
    const restrictedAccountsWithProxy = (restrictedAccounts || []).filter(hasActiveProxy);
    const cooldownAccountsWithProxy = (cooldownAccounts || []).filter(hasActiveProxy);
    const frozenAccountsWithProxy = (frozenAccounts || []).filter(hasActiveProxy);

    // For LIVE CHAT: allow active + restricted + cooldown + frozen status accounts (with active proxy)
    // Cooldown/frozen accounts can still receive and reply to messages
    const allUsableAccounts = [...activeAccountsWithProxy, ...restrictedAccountsWithProxy, ...cooldownAccountsWithProxy, ...frozenAccountsWithProxy];

    // For CAMPAIGNS: only active accounts that are NOT temporarily restricted (with active proxy)
    // Also filter out auto-disabled accounts (low success rate)
    const accountsBeforeApiLimit = activeAccountsWithProxy.filter((a: any) => 
      !isTimeRestricted(a) && !a.auto_disabled
    );

    // ========== API-LEVEL RATE LIMITING (40 per API per 24h) ==========
    // Calculate how many messages each API credential has sent in the last 24 hours
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // Get all sent messages in last 24h with their account IDs
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("account_id")
      .eq("direction", "outgoing")
      .eq("status", "sent")
      .gte("created_at", cutoff24h);

    // Build a map: api_credential_id -> count of messages sent in last 24h
    const apiSendCounts = new Map<string, number>();
    const accountToApi = new Map<string, string>();
    
    // First map all accounts to their API credentials
    for (const acc of accountsBeforeApiLimit) {
      if (acc.api_credential_id) {
        accountToApi.set(acc.id, acc.api_credential_id);
      }
    }
    
    // Count messages per API
    for (const msg of (recentMessages || []) as any[]) {
      const apiId = accountToApi.get(msg.account_id);
      if (apiId) {
        apiSendCounts.set(apiId, (apiSendCounts.get(apiId) || 0) + 1);
      }
    }

    // Filter accounts: only include those whose API is under the 40/24h limit
    const accountsWithApiLimit = accountsBeforeApiLimit.filter((a: any) => {
      if (!a.api_credential_id) return true; // No API assigned = allow
      const apiSent = apiSendCounts.get(a.api_credential_id) || 0;
      if (apiSent >= API_DAILY_LIMIT) {
        console.log(`[get-next-task] Skipping account ${a.phone_number} - API at limit (${apiSent}/${API_DAILY_LIMIT})`);
        return false;
      }
      return true;
    });

    // Sort accounts by their API's usage (prefer least-used APIs) AND by success rate (prefer reliable accounts)
    accountsWithApiLimit.sort((a: any, b: any) => {
      const aSent = apiSendCounts.get(a.api_credential_id) || 0;
      const bSent = apiSendCounts.get(b.api_credential_id) || 0;
      
      // Primary sort: by API usage (ascending - prefer least used)
      if (aSent !== bSent) return aSent - bSent;
      
      // Secondary sort: by success rate (descending - prefer more reliable)
      const aRate = a.success_rate ?? 100;
      const bRate = b.success_rate ?? 100;
      return bRate - aRate;
    });

    const accounts = accountsWithApiLimit;
    
    console.log(`[get-next-task] API rate limits: ${Array.from(apiSendCounts.entries()).map(([id, count]) => `${id.slice(0,8)}:${count}/${API_DAILY_LIMIT}`).join(', ') || 'none tracked yet'}`);
    console.log(`[get-next-task] Eligible accounts after API limit: ${accounts.length}/${accountsBeforeApiLimit.length}`);

    if (activeAccountsError) {
      console.error("[get-next-task] Error fetching accounts:", activeAccountsError);
      return new Response(JSON.stringify({ task: "wait", seconds: 5, reason: "Database error" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!allUsableAccounts || allUsableAccounts.length === 0) {
      const totalAccounts = (activeAccounts?.length || 0) + (restrictedAccounts?.length || 0);
      const reason = totalAccounts > 0 
        ? `No accounts with active proxies (${totalAccounts} accounts exist but none have active proxy)`
        : "No usable accounts";
      console.log(`[get-next-task] ${reason}`);
      return new Response(JSON.stringify({ task: "wait", seconds: 30, reason }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Separate warmed-up accounts (>5 days old) from new accounts
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

    console.log(`[get-next-task] Accounts with active proxy: ${warmedUpAccounts.length} warmed-up, ${newAccounts.length} warming`);

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
          // Get accounts assigned to this specific campaign (include restricted_until for temp restriction check)
          const { data: campaignAccountLinks } = await supabase
            .from("campaign_accounts")
            .select("account_id, telegram_accounts!inner(id, status, messages_sent_today, daily_limit, restricted_until)")
            .eq("campaign_id", campaign.id);
          
          // Check if any assigned account is usable (active AND under daily limit AND not temporarily restricted)
          const now = new Date().toISOString();
          const hasUsableAccount = (campaignAccountLinks || []).some((ca: any) => {
            const acc = ca.telegram_accounts;
            if (!acc) return false;
            const limit = acc.daily_limit ?? DAILY_MESSAGE_LIMIT;
            const sentToday = acc.messages_sent_today ?? 0;
            // Must be active, under limit, and NOT temporarily restricted (restricted_until must be null or in past)
            const isRestricted = acc.restricted_until && acc.restricted_until > now;
            return acc.status === 'active' && sentToday < limit && !isRestricted;
          });
          
          if (!hasUsableAccount) {
            // Check if there are still pending recipients
            const { count: pendingCount } = await supabase
              .from("campaign_recipients")
              .select("id", { count: "exact", head: true })
              .eq("campaign_id", campaign.id)
              .eq("status", "pending");
            
            // If pending recipients exist, mark as FAILED (couldn't complete)
            // If no pending recipients, mark as completed (all were processed)
            const newStatus = (pendingCount && pendingCount > 0) ? "failed" : "completed";
            console.log(`[get-next-task] No usable accounts left for campaign "${campaign.name}" - marking as ${newStatus} (${pendingCount || 0} pending)`);
            await supabase
              .from("campaigns")
              .update({ status: newStatus })
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
        // LAZY ASSIGNMENT FLOW: 
        // 1. First check for already-assigned pending recipients (with sent_by_account_id)
        // 2. If none, pick an UNASSIGNED pending recipient and assign an account NOW
        // This distributes load: each runner request = 1 DB write max
        
        // Get all running campaign IDs first (lightweight query)
        const { data: runningCampaignIds } = await supabase
          .from("campaigns")
          .select("id")
          .eq("status", "running");
        
        const runningIds = (runningCampaignIds || []).map((c: { id: string }) => c.id);
        
        if (runningIds.length === 0) {
          // No running campaigns - skip to wait
          return new Response(JSON.stringify({ task: "wait", seconds: 5, reason: "No running campaigns" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // RECOVERY: if a runner crashed mid-send, recipients can get stuck in "sending" forever.
        // If there is no messages row for that campaign_recipient_id, it's safe to reset back to pending.
        const { data: stuckRecipients } = await supabase
          .from("campaign_recipients")
          .select("id")
          .eq("status", "sending")
          .in("campaign_id", runningIds)
          .limit(50);

        const stuckIds = (stuckRecipients || []).map((r: any) => r.id);
        if (stuckIds.length > 0) {
          const { data: existingMsgs } = await supabase
            .from("messages")
            .select("campaign_recipient_id")
            .in("campaign_recipient_id", stuckIds);

          const withMsg = new Set<string>((existingMsgs || []).map((m: any) => m.campaign_recipient_id).filter(Boolean));
          const toReset = stuckIds.filter((id: string) => !withMsg.has(id));

          if (toReset.length > 0) {
            await supabase
              .from("campaign_recipients")
              .update({ status: "pending" })
              .in("id", toReset);

            console.log(`[get-next-task] Reset ${toReset.length} stuck campaign recipient(s) back to pending`);
          }
        }
        
        // Step 1: Check for ALREADY ASSIGNED pending recipients (one at a time for sequential processing)
        const { data: assignedRecipients } = await supabase
          .from("campaign_recipients")
          .select("*, campaigns!inner(id, status, message_template)")
          .eq("status", "pending")
          .in("campaign_id", runningIds)
          .not("sent_by_account_id", "is", null)
          .limit(1);  // Only 1 at a time for sequential processing

        let recipient = assignedRecipients?.[0] || null;
        let account = null;
        
        if (recipient) {
          // Find the assigned account
          account = accounts.find((a: { id: string }) => a.id === recipient.sent_by_account_id);

          // If assigned account is not usable (missing / over daily limit / over per-campaign limit), reassign
          const accountLimit = account?.daily_limit ?? DAILY_MESSAGE_LIMIT;
          const accountSentToday = account?.messages_sent_today ?? 0;
          const overDailyLimit = !account || accountSentToday >= accountLimit;

          let overCampaignLimit = false;
          if (recipient?.campaign_id && account?.id && MESSAGES_PER_ACCOUNT > 0) {
            const { count } = await supabase
              .from("campaign_recipients")
              .select("id", { count: "exact", head: true })
              .eq("campaign_id", recipient.campaign_id)
              .eq("sent_by_account_id", account.id)
              .in("status", ["pending", "sending", "sent"]);

            overCampaignLimit = (count || 0) >= MESSAGES_PER_ACCOUNT;
          }

          if (overDailyLimit || overCampaignLimit) {
            // Get already-failed account IDs for this recipient (privacy errors, etc.)
            const failedAccountIds: string[] = recipient.failed_account_ids || [];
            
            // Find best fallback account (under daily limit AND under per-campaign limit AND not already failed)
            const eligibleAccounts = accounts.filter((a: any) => {
              const limit = a.daily_limit ?? DAILY_MESSAGE_LIMIT;
              const sentToday = a.messages_sent_today ?? 0;
              const notAlreadyFailed = !failedAccountIds.includes(a.id);
              return sentToday < limit && notAlreadyFailed;
            });

            // IMPORTANT: prevent parallel sends from the SAME account within the SAME campaign
            // (otherwise multiple runner processes can cause back-to-back sends and Telegram flood errors)
            let eligibleNotSending = eligibleAccounts;
            if (recipient?.campaign_id && eligibleAccounts.length > 0) {
              const ids = eligibleAccounts.map((a: any) => a.id);
              const { data: inflight } = await supabase
                .from("campaign_recipients")
                .select("sent_by_account_id")
                .eq("campaign_id", recipient.campaign_id)
                .eq("status", "sending")
                .in("sent_by_account_id", ids);

              const inFlightSet = new Set<string>((inflight || []).map((r: any) => r.sent_by_account_id).filter(Boolean));
              eligibleNotSending = eligibleAccounts.filter((a: any) => !inFlightSet.has(a.id));
            }

            let eligibleUnderCampaignLimit = eligibleNotSending;
            if (recipient?.campaign_id && MESSAGES_PER_ACCOUNT > 0 && eligibleNotSending.length > 0) {
              const ids = eligibleNotSending.map((a: any) => a.id);
              const { data: countsData } = await supabase
                .from("campaign_recipients")
                .select("sent_by_account_id, count:id")
                .eq("campaign_id", recipient.campaign_id)
                .in("sent_by_account_id", ids)
                .in("status", ["pending", "sending", "sent"]);

              const countsByAccount = new Map<string, number>();
              for (const row of (countsData || []) as any[]) {
                if (row?.sent_by_account_id) countsByAccount.set(row.sent_by_account_id, Number(row.count) || 0);
              }

              eligibleUnderCampaignLimit = eligibleNotSending.filter((a: any) => (countsByAccount.get(a.id) || 0) < MESSAGES_PER_ACCOUNT);
            }

            eligibleUnderCampaignLimit.sort((a: any, b: any) => (a.messages_sent_today || 0) - (b.messages_sent_today || 0));
            const fallback = eligibleUnderCampaignLimit[0] || null;

            if (fallback) {
              await supabase
                .from("campaign_recipients")
                .update({ sent_by_account_id: fallback.id })
                .eq("id", recipient.id);
              account = fallback;
              console.log(`[get-next-task] Reassigned recipient ${recipient.id.slice(0, 8)} to ${fallback.phone_number}`);
            } else {
              // No usable accounts, skip this recipient
              recipient = null;
            }
          }
        }
        
        // Step 2: If no assigned recipient, pick an UNASSIGNED one and assign NOW (lazy assignment)
        if (!recipient) {
          const { data: unassignedRecipients } = await supabase
            .from("campaign_recipients")
            .select("*, campaigns!inner(id, status, message_template)")
            .eq("status", "pending")
            .in("campaign_id", runningIds)
            .is("sent_by_account_id", null)
            .limit(1);  // Only 1 at a time
          
          if (unassignedRecipients && unassignedRecipients.length > 0) {
            recipient = unassignedRecipients[0];
            
            // Get already-failed account IDs for this recipient (privacy errors, etc.)
            const failedAccountIds: string[] = recipient.failed_account_ids || [];
            
            // Find best account (under daily limit, under per-campaign limit, AND not already failed for this recipient)
            const eligibleAccounts = accounts.filter((a: any) => {
              const limit = a.daily_limit ?? DAILY_MESSAGE_LIMIT;
              const sentToday = a.messages_sent_today ?? 0;
              const notAlreadyFailed = !failedAccountIds.includes(a.id);
              return sentToday < limit && notAlreadyFailed;
            });

            // IMPORTANT: prevent parallel sends from the SAME account within the SAME campaign
            // (otherwise multiple runner processes can cause back-to-back sends and Telegram flood errors)
            let eligibleNotSending = eligibleAccounts;
            if (recipient?.campaign_id && eligibleAccounts.length > 0) {
              const ids = eligibleAccounts.map((a: any) => a.id);
              const { data: inflight } = await supabase
                .from("campaign_recipients")
                .select("sent_by_account_id")
                .eq("campaign_id", recipient.campaign_id)
                .eq("status", "sending")
                .in("sent_by_account_id", ids);

              const inFlightSet = new Set<string>((inflight || []).map((r: any) => r.sent_by_account_id).filter(Boolean));
              eligibleNotSending = eligibleAccounts.filter((a: any) => !inFlightSet.has(a.id));
            }

            let eligibleUnderCampaignLimit = eligibleNotSending;
            if (MESSAGES_PER_ACCOUNT > 0 && eligibleNotSending.length > 0) {
              const ids = eligibleNotSending.map((a: any) => a.id);
              const { data: countsData } = await supabase
                .from("campaign_recipients")
                .select("sent_by_account_id, count:id")
                .eq("campaign_id", recipient.campaign_id)
                .in("sent_by_account_id", ids)
                .in("status", ["pending", "sending", "sent"]);

              const countsByAccount = new Map<string, number>();
              for (const row of (countsData || []) as any[]) {
                if (row?.sent_by_account_id) countsByAccount.set(row.sent_by_account_id, Number(row.count) || 0);
              }

              eligibleUnderCampaignLimit = eligibleNotSending.filter((a: any) => (countsByAccount.get(a.id) || 0) < MESSAGES_PER_ACCOUNT);
            }

            if (eligibleUnderCampaignLimit.length > 0) {
              // Pick the account with fewest messages sent today (load balancing)
              eligibleUnderCampaignLimit.sort((a: any, b: any) =>
                (a.messages_sent_today || 0) - (b.messages_sent_today || 0)
              );
              account = eligibleUnderCampaignLimit[0];

              // Assign this account to the recipient (LAZY ASSIGNMENT)
              await supabase
                .from("campaign_recipients")
                .update({ sent_by_account_id: account.id })
                .eq("id", recipient.id)
                .eq("status", "pending");

              console.log(`[get-next-task] LAZY ASSIGN: recipient ${recipient.id.slice(0, 8)} -> account ${account.phone_number}`);
            } else {
              // No eligible accounts available
              recipient = null;
            }
          }
        }
        
        // If we have a recipient and account, return the task
        if (recipient && account) {
          const campaign = recipient.campaigns;
          
          // SERVER-SIDE RATE LIMITING: Check if enough time has passed since last send
          // This prevents runners from sending too fast even if they poll aggressively
          const lastSendAt = account.last_campaign_send_at ? new Date(account.last_campaign_send_at).getTime() : 0;
          const nowMs = Date.now();
          const elapsedSeconds = (nowMs - lastSendAt) / 1000;
          
          if (lastSendAt > 0 && elapsedSeconds < MESSAGE_DELAY_MIN_SECONDS) {
            const waitTime = Math.ceil(MESSAGE_DELAY_MIN_SECONDS - elapsedSeconds);
            console.log(`[get-next-task] Account ${account.phone_number} rate limited - sent ${elapsedSeconds.toFixed(1)}s ago, need ${MESSAGE_DELAY_MIN_SECONDS}s minimum. Wait ${waitTime}s`);
            return new Response(JSON.stringify({
              task: "wait",
              seconds: waitTime,
              reason: `Rate limit: wait ${waitTime}s before next send`,
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          
          // Mark recipient as "sending" to prevent duplicate picks
          await supabase
            .from("campaign_recipients")
            .update({ status: "sending" })
            .eq("id", recipient.id)
            .eq("status", "pending");
          
          // Update last_campaign_send_at for rate limiting
          await supabase
            .from("telegram_accounts")
            .update({ last_campaign_send_at: new Date().toISOString() })
            .eq("id", account.id);

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
            proxy: account.proxies ? {
              host: account.proxies.host,
              port: account.proxies.port,
              username: account.proxies.username,
              password: account.proxies.password,
              type: account.proxies.proxy_type,
            } : null,
            mode: "campaign",
            delay_after: delaySeconds,
            settings: {
              minDelaySeconds: MESSAGE_DELAY_MIN_SECONDS,
              maxDelaySeconds: MESSAGE_DELAY_MAX_SECONDS,
              accountSwitchDelaySeconds: ACCOUNT_SWITCH_DELAY_SECONDS,
              maxMessagesBeforeRotation: MAX_MESSAGES_BEFORE_ROTATION,
              cooldownDuration: COOLDOWN_DURATION_SECONDS,
              schedulerEnabled: SCHEDULER_ENABLED,
              messagesPerAccount: MESSAGES_PER_ACCOUNT,
              dailyMessageLimit: DAILY_MESSAGE_LIMIT,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
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

      // Calculate delay based on settings (backend controls all timing)
      const waitSeconds = Math.floor(
        Math.random() * (MESSAGE_DELAY_MAX_SECONDS - MESSAGE_DELAY_MIN_SECONDS + 1) + MESSAGE_DELAY_MIN_SECONDS
      );
      
      return new Response(JSON.stringify({
        task: "wait",
        seconds: waitSeconds,
        accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RUNNER: warmup_chat - 1-to-1 pair chat warmup system
    if (runner === "warmup_chat") {
      // Get next pending warmup message that's due to be sent
      const { data: warmupMessages } = await supabase
        .from("warmup_messages")
        .select(`
          *,
          warmup_pairs(*),
          sender:telegram_accounts!warmup_messages_sender_account_id_fkey(*, telegram_api_credentials(*)),
          receiver:telegram_accounts!warmup_messages_receiver_account_id_fkey(phone_number, telegram_id, username)
        `)
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(1);

      if (warmupMessages && warmupMessages.length > 0) {
        const msg = warmupMessages[0] as any;
        const senderAccount = msg.sender;
        const receiverAccount = msg.receiver;

        if (senderAccount && senderAccount.status === "active" && receiverAccount) {
          const apiCred = senderAccount.telegram_api_credentials;

          // Mark as in_progress
          await supabase
            .from("warmup_messages")
            .update({ status: "in_progress" })
            .eq("id", msg.id);

          console.log(`[get-next-task] Warmup chat: ${senderAccount.phone_number} -> ${receiverAccount.phone_number}`);
          return new Response(JSON.stringify({
            task: "warmup_chat",
            task_id: msg.id,
            pair_id: msg.pair_id,
            task_data: {
              recipient_phone: receiverAccount.phone_number,
              recipient_telegram_id: receiverAccount.telegram_id,
              recipient_username: receiverAccount.username,
              message: msg.message_content,
              message_type: msg.message_type,
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
        } else {
          // Account not usable, cancel this message
          await supabase
            .from("warmup_messages")
            .update({ status: "cancelled" })
            .eq("id", msg.id);
        }
      }

      // No warmup chat tasks
      return new Response(JSON.stringify({
        task: "wait",
        seconds: 5,
        reason: "No pending warmup chat messages",
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
        .select("*, telegram_accounts(*, telegram_api_credentials(*), proxies!fk_proxy(*))")
        .eq("status", "pending")
        .in("task_type", ["spambot_check", "change_name", "privacy_settings", "change_password", "logout_sessions", "change_photo", "sync_profile", "verify_session"])
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
            const proxyData = accountData.proxies;

            // Mark task as in_progress to avoid being served repeatedly while runner is working
            await supabase
              .from("account_check_tasks")
              .update({ status: "in_progress" })
              .eq("id", task.id)
              .eq("status", "pending");

            console.log(`[get-next-task] ${taskType} for ${task.account_id}`);
            return new Response(
              JSON.stringify({
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
                  proxy_id: accountData.proxy_id,
                },
                proxy: proxyData
                  ? {
                      host: proxyData.host,
                      port: proxyData.port,
                      username: proxyData.username,
                      password: proxyData.password,
                      // Backwards compatible: python expects proxy_type, older code may use type
                      proxy_type: proxyData.proxy_type,
                      type: proxyData.proxy_type,
                    }
                  : null,
              }),
              {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              }
            );
          }
        }
      }

      // Check for contact import tasks with account fallback support
      // NOTE: Contact imports can use temporarily restricted accounts (they only read, not send)
      const { data: importTasks } = await supabase
        .from("contact_import_tasks")
        .select("*")
        .in("status", ["pending", "processing"])
        .order("created_at", { ascending: true })
        .limit(1);

      if (importTasks && importTasks.length > 0) {
        const task = importTasks[0];
        const failedAccountIds: string[] = task.failed_account_ids || [];
        
        // Get phone numbers to validate (remaining or all)
        const phoneNumbers: string[] = (task.remaining_numbers && task.remaining_numbers.length > 0)
          ? task.remaining_numbers
          : task.phone_numbers;
        
        if (phoneNumbers.length === 0) {
          // All done
          await supabase
            .from("contact_import_tasks")
            .update({ status: "completed", completed_at: new Date().toISOString() })
            .eq("id", task.id);
        } else {
          // Find an active account that hasn't failed for this task
          // Use allUsableAccounts for contact validation - includes temporarily restricted accounts
          // Contact import is READ-ONLY (doesn't send messages) so restricted accounts can do it
          const eligibleAccounts = (allUsableAccounts || []).filter((a: any) => !failedAccountIds.includes(a.id));
          
          if (eligibleAccounts.length === 0) {
            // No accounts left - fail the task
            await supabase
              .from("contact_import_tasks")
              .update({ 
                status: "failed", 
                result: "All accounts failed or restricted",
                completed_at: new Date().toISOString()
              })
              .eq("id", task.id);
            console.log(`[get-next-task] Contact import task ${task.id.slice(0,8)} failed - no eligible accounts`);
          } else {
            // Pick first eligible account (or prefer the originally assigned one if still eligible)
            let account = eligibleAccounts.find((a: { id: string }) => a.id === task.account_id);
            if (!account) {
              account = eligibleAccounts[0];
            }
            
            const apiCred = account.telegram_api_credentials;
            
            // Mark as processing
            await supabase
              .from("contact_import_tasks")
              .update({ 
                status: "processing",
                current_account_id: account.id
              })
              .eq("id", task.id);
            
            console.log(`[get-next-task] Contact import task: ${phoneNumbers.length} numbers with account ${account.phone_number}`);
            
            return new Response(JSON.stringify({
              task: "contact_import",
              task_id: task.id,
              tag_id: task.tag_id,
              phone_numbers: phoneNumbers,
              valid_numbers: task.valid_numbers || [],
              invalid_numbers: task.invalid_numbers || [],
              failed_account_ids: failedAccountIds,
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
      // Prioritize by: 1) priority column DESC (seat messages = 10), 2) created_at ASC
      const { data: pendingMessages, error: pendingError } = await supabase
        .from("messages")
        .select("*, conversations(*)")
        .eq("status", "pending")
        .eq("direction", "outgoing")
        .is("campaign_recipient_id", null)  // Non-campaign messages only
        .order("priority", { ascending: false })  // High priority first (seat = 10)
        .order("created_at", { ascending: true })
        .limit(20);  // Fetch more messages to find one with available account

      if (pendingError) {
        console.log(`[get-next-task] Livechat query error: ${pendingError.message}`);
      }

      if (pendingMessages && pendingMessages.length > 0) {
        console.log(`[get-next-task] Livechat: found ${pendingMessages.length} pending messages`);
        
        // Loop through messages to find one with an available account
        for (const msg of pendingMessages) {
          const conv = msg.conversations || {};
          // Use allUsableAccounts (includes restricted) for live chat
          const account = allUsableAccounts.find((a: { id: string }) => a.id === msg.account_id);

          if (!account) {
            console.log(`[get-next-task] Livechat: message ${msg.id.slice(0, 8)} account ${msg.account_id?.slice(0, 8)} NOT in usable accounts (${allUsableAccounts.length} available)`);
            continue;
          }

          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id)
            .eq("status", "pending");

          console.log(`[get-next-task] Live chat task: message ${msg.id.slice(0, 8)} to ${conv.recipient_phone || conv.recipient_username} (priority=${msg.priority}, account=${account.status})`);
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
            // Backwards-compatible string target (username or phone)
            recipient: conv.recipient_username || conv.recipient_phone,
            // Preferred fast path for replies (avoids slow phone contact imports)
            recipient_telegram_id: conv.recipient_telegram_id,
            recipient_username: conv.recipient_username,
            recipient_phone: conv.recipient_phone,
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
              proxy: account.proxies,
            },
            mode: "live",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        
        // If we got here, we had pending messages but no usable accounts for them
        console.log(`[get-next-task] Livechat: ${pendingMessages.length} pending messages but none matched available accounts`);
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 0,  // No artificial delay - poll as fast as network allows
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

    // Priority 0: HIGH PRIORITY messages (admin/seat chat - priority >= 10) - INSTANT delivery
    // This MUST come before liveConvIds check because admin chat sends to any conversation
    const { data: highPriorityMessages } = await supabase
      .from("messages")
      .select("*, conversations(*)")
      .eq("status", "pending")
      .eq("direction", "outgoing")
      .gte("priority", 10)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(5);

    if (highPriorityMessages && highPriorityMessages.length > 0) {
      for (const msg of highPriorityMessages) {
        const conv = msg.conversations || {};
        // Use allUsableAccounts for high-priority messages (includes restricted)
        const account = allUsableAccounts.find((a: { id: string }) => a.id === msg.account_id);

        if (account) {
          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id)
            .eq("status", "pending");

          console.log(`[get-next-task] HIGH PRIORITY task: message ${msg.id.slice(0, 8)} (priority=${msg.priority})`);
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
            mode: "live",  // No delay for high-priority
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

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
        const account = allUsableAccounts.find((a: { id: string }) => a.id === msg.account_id);

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
        .not("campaign_recipient_id", "is", null) // IMPORTANT: only campaign-linked messages
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
            settings: {
              minDelaySeconds: MESSAGE_DELAY_MIN_SECONDS,
              maxDelaySeconds: MESSAGE_DELAY_MAX_SECONDS,
              accountSwitchDelaySeconds: ACCOUNT_SWITCH_DELAY_SECONDS,
              maxMessagesBeforeRotation: MESSAGES_PER_ACCOUNT,
              messagesPerAccount: MESSAGES_PER_ACCOUNT,
              dailyMessageLimit: DAILY_MESSAGE_LIMIT,
            },
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
