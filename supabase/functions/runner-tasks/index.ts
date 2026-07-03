import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * UNIFIED RUNNER-TASKS ENDPOINT
 * 
 * Consolidates: get-batch-tasks, get-next-task, report-task-result, report-batch-results
 * 
 * Routes:
 * - POST /get - Get batch of tasks for processing
 * - POST /report - Report task results (single or batch)
 * - POST /heartbeat - Runner heartbeat
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Account action types that the Python runner handles
const ACCOUNT_ACTION_TYPES = [
  "change_name", "change_photo", "change_bio", "change_username",
  "spambot_check", "session_check", "sync_profile", "get_me",
  "privacy_settings", "change_password", "logout_sessions",
  "add_contact", "delete_contact", "block_contact", "unblock_contact",
  "join_channel", "leave_channel", "react", "view_channel",
  "get_dialogs", "read_messages", "delete_chat"
];

function isAccountActionType(taskType: string): boolean {
  return ACCOUNT_ACTION_TYPES.includes(taskType);
}

// Settings cache
interface CachedSettings {
  data: Record<string, any>[];
  timestamp: number;
}
let settingsCache: CachedSettings | null = null;
const SETTINGS_CACHE_TTL_MS = 30 * 1000;

async function getCachedSettings(supabase: any): Promise<Record<string, any>[]> {
  const now = Date.now();
  if (settingsCache && (now - settingsCache.timestamp) < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.data;
  }
  const { data: settingsData } = await supabase.from("app_settings").select("key, value");
  settingsCache = { data: settingsData || [], timestamp: now };
  return settingsCache.data;
}

function parseSettings(settingsData: Record<string, any>[]) {
  const config = {
    messageDelayMin: 5,
    messageDelayMax: 15,
    dailyLimit: 25,
    warmupBatchSize: 100,
    campaignBatchSize: 100,
    campaignPollingInterval: 10,
    campaignMessagesPerAccountPerDay: 25,
    livechatSettings: { sameAccountStaggerMin: 1, sameAccountStaggerMax: 2, enableParallel: true },
  };
  
  for (const setting of settingsData) {
    const value = setting.value as Record<string, unknown>;
    switch (setting.key) {
      case "message_timing":
        if (value) {
          config.messageDelayMin = (value.minDelaySeconds as number) || config.messageDelayMin;
          config.messageDelayMax = (value.maxDelaySeconds as number) || config.messageDelayMax;
        }
        break;
      case "account_limits":
        if (value) config.dailyLimit = (value.dailyMessageLimit as number) || config.dailyLimit;
        break;
      case "warmup_batch_size":
        if (value) config.warmupBatchSize = (value.batchSize as number) || config.warmupBatchSize;
        break;
      case "campaign_speed":
        if (value) {
          config.campaignPollingInterval = (value.pollingInterval as number) ?? config.campaignPollingInterval;
          config.campaignBatchSize = (value.batchSize as number) ?? config.campaignBatchSize;
          config.campaignMessagesPerAccountPerDay = (value.messagesPerAccountPerDay as number) ?? config.campaignMessagesPerAccountPerDay;
        }
        break;
      case "livechat":
        if (value) {
          config.livechatSettings = {
            sameAccountStaggerMin: (value.sameAccountStaggerMin as number) ?? 1,
            sameAccountStaggerMax: (value.sameAccountStaggerMax as number) ?? 2,
            enableParallel: (value.enableParallel as boolean) ?? true,
          };
        }
        break;
    }
  }
  return config;
}

// Get API credentials for account (per-account only - no pool fallback)
async function getApiCredentialsForAccount(supabase: any, account: any) {
  if (account.api_id && account.api_hash) {
    console.log(`[api] Using per-account API for ${account.phone_number}: ${account.api_id}`);
    return { api_id: account.api_id, api_hash: account.api_hash, api_credential_id: null };
  }
  console.warn(`[api] Account ${account.phone_number} has no API credentials - skipping`);
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/runner-tasks', '');

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json().catch(() => ({}));

    // Route: GET TASKS
    if (path === '/get' || path === '') {
      return await handleGetTasks(supabase, body);
    }

    // Route: REPORT RESULTS
    if (path === '/report') {
      return await handleReportResults(supabase, body);
    }

    // Route: HEARTBEAT
    if (path === '/heartbeat') {
      const { runner, server_id } = body;
      if (runner) {
        await supabase.from("runner_heartbeats").upsert(
          { runner_name: runner, last_seen: new Date().toISOString(), status: 'online', server_id: server_id || 'legacy' },
          { onConflict: 'runner_name' }
        );
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Route: LOCK ACCOUNTS (runner claims accounts on connect)
    if (path === '/lock') {
      const { account_ids: lockIds, server_id: lockServerId } = body;
      if (lockIds?.length && lockServerId) {
        const nowIso = new Date().toISOString();
        await supabase.from("telegram_accounts")
          .update({ locked_by: lockServerId, locked_at: nowIso })
          .in("id", lockIds)
          .or(`locked_by.is.null,locked_by.eq.${lockServerId}`);
        console.log(`[session-lock] Locked ${lockIds.length} accounts for ${lockServerId}`);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Route: UNLOCK ACCOUNTS (runner releases accounts on shutdown)
    if (path === '/unlock') {
      const { server_id: unlockServerId } = body;
      if (unlockServerId) {
        const { data: unlocked } = await supabase.from("telegram_accounts")
          .update({ locked_by: null, locked_at: null })
          .eq("locked_by", unlockServerId)
          .select("id");
        console.log(`[session-lock] Unlocked ${unlocked?.length || 0} accounts for ${unlockServerId}`);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found", path }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error(`[runner-tasks] Error:`, error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ==================== GET TASKS ====================
async function handleGetTasks(supabase: any, body: any) {
  const { runner, account_ids, server_id } = body;
  // IMPORTANT: for large fleets (500+ accounts), returning the full accounts payload every poll
  // can be huge and make the Python runner appear "stuck" after CATCHUP (JSON parse / IO).
  // Default is backwards compatible (include accounts). Runner can opt-out by sending include_accounts=false.
  const includeAccounts: boolean = body?.include_accounts !== false;
  const nowIso = new Date().toISOString();

  // Get settings first to use admin-configured batch size
  const settingsData = await getCachedSettings(supabase);
  const config = parseSettings(settingsData);
  const batch_size = config.campaignBatchSize;

  console.log(`[runner-tasks/get] Runner: ${runner}, server_id: ${server_id || 'legacy'}, batch_size: ${batch_size} (from settings)`);

  // Fetch last_offline_at BEFORE updating heartbeat (to know when we were last offline)
  let lastOfflineAt: string | null = null;
  if (runner) {
    const { data: heartbeat } = await supabase
      .from("runner_heartbeats")
      .select("last_offline_at, server_id, last_seen")
      .eq("runner_name", runner)
      .single();
    
    lastOfflineAt = heartbeat?.last_offline_at || null;
    
    // BLOCK duplicate runner: if another instance was active within the last 15 seconds, reject this one
    const existingServerId = heartbeat?.server_id;
    const lastSeen = heartbeat?.last_seen;
    if (existingServerId && server_id && existingServerId !== server_id && existingServerId !== 'legacy' && lastSeen) {
      const lastSeenAge = (Date.now() - new Date(lastSeen).getTime()) / 1000;
      if (lastSeenAge < 15) {
        console.warn(`[runner-tasks/get] ⛔ BLOCKING DUPLICATE RUNNER! Active: ${existingServerId} (${lastSeenAge.toFixed(0)}s ago), Rejected: ${server_id}`);
        return new Response(JSON.stringify({
          tasks: [],
          accounts: [],
          duplicate_runner: true,
          active_instance: existingServerId,
          message: `Another runner instance (${existingServerId}) is already active. This instance (${server_id}) is blocked. Stop the other runner first.`
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    
    // Now record the heartbeat (this updates last_seen + server_id)
    supabase.from("runner_heartbeats")
      .upsert({ runner_name: runner, last_seen: nowIso, status: 'online', server_id: server_id || 'legacy' }, { onConflict: 'runner_name' })
      .then(() => {});
  }


  // Auto-restore expired cooldowns (check both restricted_until and cooldown_until)
  const { data: expiredCooldowns } = await supabase
    .from("telegram_accounts")
    .select("id, status, restricted_until, cooldown_until")
    .in("status", ["cooldown", "restricted"]);
  
  // Filter accounts where either cooldown has expired
  const accountsToRestore = (expiredCooldowns || []).filter((a: any) => {
    const restrictedExpired = a.restricted_until && new Date(a.restricted_until) < new Date(nowIso);
    const cooldownExpired = a.cooldown_until && new Date(a.cooldown_until) < new Date(nowIso);
    // Restore if either timer expired (or both null for legacy accounts stuck in cooldown)
    return restrictedExpired || cooldownExpired || (!a.restricted_until && !a.cooldown_until);
  });
  
  if (accountsToRestore.length > 0) {
    await supabase.from("telegram_accounts")
      .update({ status: "active", restricted_until: null, cooldown_until: null, ban_reason: null })
      .in("id", accountsToRestore.map((a: any) => a.id));
    console.log(`[runner-tasks/get] Restored ${accountsToRestore.length} accounts from cooldown`);
  }

  // === SELF-HEALING: Recover stale messages stuck in 'sending' for 3+ minutes ===
  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  
  // Recover stale LiveChat messages
  const { data: staleMessages } = await supabase
    .from("messages")
    .update({ status: "pending" })
    .eq("status", "sending")
    .lt("created_at", threeMinutesAgo)
    .select("id");
  
  if (staleMessages?.length) {
    console.log(`[runner-tasks/get] Recovered ${staleMessages.length} stale messages from sending→pending`);
  }

  // Recover stale campaign recipients (includes NULL sending_started_at which means they were never actually picked up)
  const { data: staleRecipients } = await supabase
    .from("campaign_recipients")
    .update({ status: "pending", sending_started_at: null })
    .eq("status", "sending")
    .or(`sending_started_at.lt.${threeMinutesAgo},sending_started_at.is.null`)
    .select("id");
  
  if (staleRecipients?.length) {
    console.log(`[runner-tasks/get] Recovered ${staleRecipients.length} stale recipients from sending→pending`);
  }

  // Load accounts with proxies
  const isLivechat = runner === "livechat";
  let accountsQuery = supabase.from("telegram_accounts").select("*, proxies!fk_proxy(*)");
  
  if (isLivechat) {
    accountsQuery = accountsQuery.in("status", ["active", "restricted", "cooldown", "frozen"]);
  } else {
    // Include restricted/cooldown accounts so they can LISTEN for incoming messages
    // Campaign task assignment will still filter them out (only 'active' can send to new recipients)
    accountsQuery = accountsQuery.in("status", ["active", "cooldown", "restricted"]);
  }
  
  if (account_ids?.length > 0) {
    accountsQuery = accountsQuery.in("id", account_ids);
  }

  const { data: accounts, error: accountsError } = await accountsQuery;

  // SESSION LOCK: Filter out accounts locked by a DIFFERENT runner instance
  // An account is considered "stale locked" if locked_at is older than 60 seconds
  // (the runner sends lock renewals every poll cycle ~10s)
  const staleLockThreshold = new Date(Date.now() - 60 * 1000).toISOString();
  const filteredAccounts = (accounts || []).filter((a: any) => {
    // No lock = available
    if (!a.locked_by) return true;
    // Locked by THIS instance = available
    if (a.locked_by === server_id) return true;
    // Stale lock (other instance crashed) = available, clear the lock
    if (a.locked_at && a.locked_at < staleLockThreshold) return true;
    // Locked by another active instance = BLOCKED
    console.log(`[session-lock] Account ${a.phone_number} locked by ${a.locked_by}, skipping for ${server_id}`);
    return false;
  });

  if (accountsError || !filteredAccounts?.length) {
    return jsonResponse({ tasks: [], accounts: [], delay_after: 30, reason: "No active accounts" });
  }

  // Accounts that can SEND new campaign messages (active only, under daily limit)
  // Proxy is optional: if account has proxy_id assigned, it must be active; otherwise run direct (VPS IP)
  const hasUsableProxy = (a: any) => !a.proxy_id || (a.proxies && a.proxies.status === 'active');

  const sendableAccounts = filteredAccounts.filter((a: any) => {
    if (!hasUsableProxy(a)) return false;
    if (a.status !== 'active') return false; // Only active accounts can send to new recipients
    const limit = config.campaignMessagesPerAccountPerDay || a.daily_limit || config.dailyLimit;
    if ((a.messages_sent_today ?? 0) >= limit) return false;
    return true;
  });

  // Accounts that can LISTEN for incoming messages (broader list includes cooldown/restricted)
  const connectableAccounts = filteredAccounts.filter((a: any) => {
    if (!hasUsableProxy(a)) return false;
    // cooldown/restricted accounts can still listen for incoming messages
    return ['active', 'cooldown', 'restricted'].includes(a.status);
  });

  // For livechat, we use all connectable accounts as "usable" for reply purposes
  const usableAccounts = isLivechat ? connectableAccounts : sendableAccounts;

  if (connectableAccounts.length === 0) {
    return jsonResponse({ tasks: [], accounts: [], delay_after: 30, reason: "No usable accounts" });
  }

  const tasks: any[] = [];

  // ===== CAMPAIGN TASKS =====
  if (runner === "campaign" || runner === "unified") {
    const { data: recipients } = await supabase
      .from("campaign_recipients")
      .select(`*, campaigns!inner(id, name, message_template, status, seat_id)`)
      .eq("status", "pending")
      .eq("campaigns.status", "running")
      .order("scheduled_at", { ascending: true, nullsFirst: true })
      .limit(batch_size);

    if (recipients?.length > 0) {
      // === CAMPAIGN ACCOUNT FILTERING ===
      // Fetch linked accounts for each campaign to respect user's account selection
      const uniqueCampaignIds = [...new Set(recipients.map((r: any) => r.campaigns.id))];
      
      const { data: campaignAccountLinks } = await supabase
        .from("campaign_accounts")
        .select("campaign_id, account_id")
        .in("campaign_id", uniqueCampaignIds);
      
      // Build a map: campaign_id -> Set of allowed account IDs
      const campaignAccountMap: Record<string, Set<string>> = {};
      for (const link of (campaignAccountLinks || [])) {
        if (!campaignAccountMap[link.campaign_id]) {
          campaignAccountMap[link.campaign_id] = new Set();
        }
        campaignAccountMap[link.campaign_id].add(link.account_id);
      }
      
      // Log the campaign account filtering for debugging
      for (const cid of uniqueCampaignIds) {
        const cidStr = cid as string;
        const linkedCount = campaignAccountMap[cidStr]?.size || 0;
        console.log(`[runner-tasks/get] Campaign ${cidStr}: ${linkedCount} linked accounts (${linkedCount === 0 ? 'using all' : 'filtering'})`);
      }

      // === GLOBAL DEDUPLICATION: Check if any of these phone numbers were already sent globally ===
      // This prevents sending to the same recipient from multiple accounts if one succeeds first
      const phoneNumbers = recipients.map((r: any) => r.phone_number);
      
      // Check if any of these phones have been successfully sent in ANY campaign
      const { data: alreadySentPhones } = await supabase
        .from("campaign_recipients")
        .select("phone_number")
        .in("phone_number", phoneNumbers)
        .eq("status", "sent");
      
      const sentPhoneSet = new Set((alreadySentPhones || []).map((r: any) => r.phone_number));
      
      // Filter out any recipients whose phone is already sent globally
      // Mark them as 'sent' to prevent future retries
      const phonesToSkip: string[] = [];
      const recipientsToProcess: any[] = [];
      
      for (const r of recipients) {
        if (sentPhoneSet.has(r.phone_number)) {
          phonesToSkip.push(r.id);
        } else {
          recipientsToProcess.push(r);
        }
      }
      
      // Mark skipped recipients as 'sent' (already handled by another campaign/account)
      if (phonesToSkip.length > 0) {
        console.log(`[runner-tasks/get] Skipping ${phonesToSkip.length} recipients already sent globally`);
        await supabase
          .from("campaign_recipients")
          .update({ status: "sent", failed_reason: "Already sent via another campaign" })
          .in("id", phonesToSkip);
      }
      
      // Track how many tasks we've assigned to each account in this batch
      // This enables round-robin distribution across accounts
      const assignedCountByAccountId: Record<string, number> = {};
      
      for (const r of recipientsToProcess) {
        // Find the account with the lowest effective usage (sent_today + assigned_in_batch)
        // This distributes tasks evenly across all available accounts
        const dailyLimit = config.campaignMessagesPerAccountPerDay || config.dailyLimit;
        
        let bestAccount: any = null;
        let lowestUsage = Infinity;
        
        // Get the list of accounts that already failed for this recipient (e.g., due to PeerFlood)
        const failedAccountIds = r.failed_account_ids || [];
        
        // === FILTER BY CAMPAIGN-LINKED ACCOUNTS ===
        // If this campaign has specific accounts selected, only use those
        const campaignId = r.campaigns.id;
        const allowedAccountIds = campaignAccountMap[campaignId];
        const accountPool = allowedAccountIds && allowedAccountIds.size > 0
          ? usableAccounts.filter((acc: any) => allowedAccountIds.has(acc.id))
          : usableAccounts; // Fallback to all accounts if none selected
        
        for (const acc of accountPool) {
          // Skip accounts that already failed for this recipient
          if (failedAccountIds.includes(acc.id)) continue;
          
          const sentToday = acc.messages_sent_today ?? 0;
          const assignedInBatch = assignedCountByAccountId[acc.id] ?? 0;
          const effectiveUsage = sentToday + assignedInBatch;
          
          // Skip if account would exceed daily limit
          if (effectiveUsage >= dailyLimit) continue;
          
          // Pick the account with lowest effective usage (round-robin effect)
          if (effectiveUsage < lowestUsage) {
            lowestUsage = effectiveUsage;
            bestAccount = acc;
          }
        }
        
        if (!bestAccount) continue;

        const creds = await getApiCredentialsForAccount(supabase, bestAccount);
        if (!creds) continue;

        // Increment the assigned count for this account
        assignedCountByAccountId[bestAccount.id] = (assignedCountByAccountId[bestAccount.id] ?? 0) + 1;

        const isUsername = r.phone_number.startsWith('@');
        const content = (r.campaigns.message_template || '')
          .replace(/{name}/g, r.name || 'there')
          .replace(/{phone}/g, r.phone_number)
          .replace(/{username}/g, isUsername ? r.phone_number : '');

        tasks.push({
          task_type: "send",
          task_id: r.id,
          campaign_recipient_id: r.id,
          campaign_id: r.campaigns.id,
          campaign_name: r.campaigns.name,
          campaign_seat_id: r.seat_id || r.campaigns.seat_id,
          account: {
            id: bestAccount.id,
            phone_number: bestAccount.phone_number,
            session_data: bestAccount.session_data,
            device_model: bestAccount.device_model,
            system_version: bestAccount.system_version,
            build_id: bestAccount.build_id,
            app_version: bestAccount.app_version,
            lang_code: bestAccount.lang_code,
            system_lang_code: bestAccount.system_lang_code,
            api_id: creds.api_id,
            api_hash: creds.api_hash,
            api_credential_id: creds.api_credential_id,
          },
          proxy: bestAccount.proxies,
          recipient: {
            phone: isUsername ? null : r.phone_number,
            name: r.name,
            telegram_id: null,
            username: isUsername ? r.phone_number : null,
          },
          content,
          media_url: null,
        });

        // Mark as sending
        await supabase.from("campaign_recipients").update({ status: "sending" }).eq("id", r.id);
      }
    }
  }

  // ===== WARMUP TASKS =====
  if (runner === "warmup_chat" || runner === "unified") {
    const { data: warmupMessages } = await supabase
      .from("warmup_messages")
      .select(`*, sender:telegram_accounts!warmup_messages_sender_account_id_fkey(*, proxies!fk_proxy(*)), 
               receiver:telegram_accounts!warmup_messages_receiver_account_id_fkey(id, phone_number, telegram_id, username, first_name)`)
      .eq("status", "pending")
      .lte("scheduled_at", nowIso)
      .order("scheduled_at", { ascending: true })
      .limit(batch_size);

    if (warmupMessages?.length > 0) {
      for (const msg of warmupMessages) {
        const sender = msg.sender;
        // Proxy is optional — accounts without a proxy connect directly.
        // Only skip when a proxy IS assigned but is not active (broken proxy).
        if (!sender?.session_data) continue;
        if (sender?.proxies && sender.proxies.status !== 'active') continue;

        const creds = await getApiCredentialsForAccount(supabase, sender);
        if (!creds) continue;

        tasks.push({
          task_type: msg.message_type === "add_contact" ? "warmup_add_contact" : "warmup_chat",
          task_id: msg.id,
          pair_id: msg.pair_id,
          account: {
            id: sender.id,
            phone_number: sender.phone_number,
            session_data: sender.session_data,
            device_model: sender.device_model,
            system_version: sender.system_version,
            build_id: sender.build_id,
            app_version: sender.app_version,
            lang_code: sender.lang_code,
            system_lang_code: sender.system_lang_code,
            api_id: creds.api_id,
            api_hash: creds.api_hash,
            api_credential_id: creds.api_credential_id,
          },
          proxy: sender.proxies,
          recipient: {
            phone: msg.receiver?.phone_number,
            telegram_id: msg.receiver?.telegram_id,
            username: msg.receiver?.username,
            name: msg.receiver?.first_name || msg.message_content,
          },
          content: msg.message_content,
          is_cycle_last: msg.is_cycle_last,
        });

        await supabase.from("warmup_messages").update({ status: "sending", claimed_at: nowIso }).eq("id", msg.id);
      }
    }
  }

  // ===== LIVECHAT TASKS =====
  if (runner === "livechat" || runner === "unified") {
    const { data: pendingMessages } = await supabase
      .from("messages")
      .select("id, content, media_url, media_type, account_id, conversations!inner(id, recipient_phone, recipient_username, recipient_telegram_id, recipient_name)")
      .eq("status", "pending")
      .eq("direction", "outgoing")
      .is("campaign_recipient_id", null)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(batch_size);

    if (pendingMessages?.length > 0) {
      const accountIds = [...new Set(pendingMessages.map((m: any) => m.account_id))];
      const { data: msgAccounts } = await supabase
        .from("telegram_accounts")
        .select("*, proxies!fk_proxy(*)")
        .in("id", accountIds)
        .in("status", ["active", "restricted", "cooldown", "frozen"]);

      const accountMap = new Map((msgAccounts || []).map((a: any) => [a.id, a]));

      for (const msg of pendingMessages) {
        const account: any = accountMap.get(msg.account_id);
        // Proxy is optional — accounts without a proxy send directly via runner IP.
        if (!account) continue;
        if (account.proxies && account.proxies.status !== 'active') continue;

        const creds = await getApiCredentialsForAccount(supabase, account);
        if (!creds) continue;

        const conv = (msg as any).conversations;
        tasks.push({
          task_type: "send",
          task_id: msg.id,
          message_id: msg.id,
          account: {
            id: account.id,
            phone_number: account.phone_number,
            session_data: account.session_data,
            device_model: account.device_model,
            system_version: account.system_version,
            build_id: account.build_id,
            app_version: account.app_version,
            lang_code: account.lang_code,
            system_lang_code: account.system_lang_code,
            api_id: creds.api_id,
            api_hash: creds.api_hash,
            api_credential_id: creds.api_credential_id,
          },
          proxy: account.proxies,
          recipient: {
            phone: conv.recipient_phone,
            telegram_id: conv.recipient_telegram_id,
            username: conv.recipient_username,
            name: conv.recipient_name,
          },
          content: msg.content,
          media_url: msg.media_url,
          media_type: msg.media_type,
        });

        await supabase.from("messages").update({ status: "sending" }).eq("id", msg.id);
      }
    }
  }

  // ===== ACCOUNT ACTION TASKS =====
  if (runner === "account_actions" || runner === "unified") {
    const { data: actionTasks } = await supabase
      .from("account_check_tasks")
      .select(`*, account:telegram_accounts!inner(*, proxies!fk_proxy(*))`)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(batch_size);

    if (actionTasks?.length > 0) {
      for (const task of actionTasks) {
        const account = task.account;
        if (!account?.session_data) continue;
        if (account.proxies && account.proxies.status !== 'active') continue;

        const creds = await getApiCredentialsForAccount(supabase, account);
        if (!creds) continue;

        // Parse result field for task-specific data (e.g., first_name, last_name, photo_url)
        let taskData: Record<string, any> = {};
        try {
          taskData = JSON.parse(task.result || '{}');
        } catch {
          taskData = {};
        }

        tasks.push({
          task_type: task.task_type, // change_name, change_photo, spambot_check, session_check, etc.
          task_id: task.id,
          account: {
            id: account.id,
            phone_number: account.phone_number,
            session_data: account.session_data,
            device_model: account.device_model,
            system_version: account.system_version,
            build_id: account.build_id,
            app_version: account.app_version,
            lang_code: account.lang_code,
            system_lang_code: account.system_lang_code,
            api_id: creds.api_id,
            api_hash: creds.api_hash,
            api_credential_id: creds.api_credential_id,
          },
          proxy: account.proxies,
          task_data: taskData, // Contains first_name, last_name, photo_url, privacy settings, etc.
        });

        // Mark as in_progress
        await supabase.from("account_check_tasks")
          .update({ status: "in_progress", updated_at: nowIso })
          .eq("id", task.id);
      }
    }
  }

  // Build accounts list for listening only when requested
  // (tasks always include the per-task account payload needed to send)
  let listeningAccounts: any[] = [];
  if (includeAccounts) {
    // use connectableAccounts to include cooldown/restricted (they can still LISTEN)
    listeningAccounts = await Promise.all(connectableAccounts.map(async (acc: any) => {
      const creds = await getApiCredentialsForAccount(supabase, acc);
      if (!creds) return null;
      return {
        id: acc.id,
        phone_number: acc.phone_number,
        session_data: acc.session_data,
        device_model: acc.device_model,
        system_version: acc.system_version,
        build_id: acc.build_id,
        app_version: acc.app_version,
        lang_code: acc.lang_code,
        system_lang_code: acc.system_lang_code,
        api_id: creds.api_id,
        api_hash: creds.api_hash,
        api_credential_id: creds.api_credential_id,
        proxy: acc.proxies,
        status: acc.status,
      };
    })).then(results => results.filter(Boolean));
  }

  console.log(`[runner-tasks/get] Returning ${tasks.length} tasks, ${includeAccounts ? listeningAccounts.length : 0} accounts (includeAccounts=${includeAccounts})`);

  // Aggressive polling for responsiveness:
  // - When we just processed tasks, poll again in 1s so livechat sends feel instant
  // - When idle, poll every 5s (was 30s) so a newly-queued message picks up quickly
  return jsonResponse({
    tasks,
    accounts: listeningAccounts,
    delay_after: tasks.length > 0 ? 1 : 5,
    settings: config.livechatSettings,
    last_offline_at: lastOfflineAt,  // Include runner's last offline time for smart catch-up
    config: {
      campaignBatchSize: config.campaignBatchSize,
      warmupBatchSize: config.warmupBatchSize,
      dailyLimit: config.dailyLimit,
      campaignMessagesPerAccountPerDay: config.campaignMessagesPerAccountPerDay,
    },
  });
}

// ==================== REPORT RESULTS ====================
async function handleReportResults(supabase: any, body: any) {
  const { results, task_type, result } = body;
  const now = new Date().toISOString();

  // Support both batch and single result
  const allResults = results || (result ? [{ ...result, task_type }] : []);
  
  if (allResults.length === 0) {
    return jsonResponse({ error: "No results provided" }, 400);
  }

  console.log(`[runner-tasks/report] Processing ${allResults.length} results`);
  
  // Track campaign IDs that were affected for completion check
  const affectedCampaignIds = new Set<string>();

  // Handle incoming messages separately (they don't have success/failure status in same way)
  const incomingMessages = allResults.filter((r: any) => 
    (r.task_type || task_type) === "incoming" || (r.task_type || task_type) === "incoming_message"
  );
  const otherResults = allResults.filter((r: any) => 
    (r.task_type || task_type) !== "incoming" && (r.task_type || task_type) !== "incoming_message"
  );

  // Process incoming messages
  for (const r of incomingMessages) {
    await processIncomingMessage(supabase, r, now);
  }

  const successResults = otherResults.filter((r: any) => r.success);
  const failedResults = otherResults.filter((r: any) => !r.success);

  // Process successes
  for (const r of successResults) {
    const taskType = r.task_type || task_type;

    if (taskType === "send") {
      if (r.campaign_recipient_id) {
        // Campaign message success - check if already counted to prevent double-counting on retries
        const { data: recipientData } = await supabase
          .from("campaign_recipients")
          .select("status, campaign_id")
          .eq("id", r.campaign_recipient_id)
          .single();

        // Track campaign for completion check
        if (recipientData?.campaign_id) {
          affectedCampaignIds.add(recipientData.campaign_id);
        }

        // Only update and count if recipient wasn't already marked as sent
        const wasAlreadySent = recipientData?.status === 'sent';
        
        if (!wasAlreadySent) {
          await supabase.from("campaign_recipients")
            .update({ status: "sent", sent_at: now, sent_by_account_id: r.account_id, api_credential_id: r.api_credential_id })
            .eq("id", r.campaign_recipient_id);
        }

        // Create/update conversation
        let conversationId: string | null = null;
        let existingConvQuery = supabase
          .from("conversations")
          .select("id, recipient_phone")
          .eq("account_id", r.account_id);

        if (r.recipient_phone) {
          existingConvQuery = existingConvQuery.eq("recipient_phone", r.recipient_phone);
        } else if (r.recipient_username) {
          existingConvQuery = existingConvQuery.eq("recipient_username", r.recipient_username);
        } else if (r.recipient_telegram_id) {
          existingConvQuery = existingConvQuery.eq("recipient_telegram_id", r.recipient_telegram_id);
        }

        const { data: existingConv } = await existingConvQuery.maybeSingle();

        if (existingConv) {
          conversationId = existingConv.id;
          const convUpdates: Record<string, any> = {};
          if (r.recipient_telegram_id) convUpdates.recipient_telegram_id = r.recipient_telegram_id;
          if (r.recipient_username) convUpdates.recipient_username = r.recipient_username;
          if (r.recipient_phone && !existingConv.recipient_phone) convUpdates.recipient_phone = r.recipient_phone;
          if (Object.keys(convUpdates).length > 0) {
            await supabase.from("conversations").update(convUpdates).eq("id", conversationId);
          }
        } else {
          const { data: newConv } = await supabase.from("conversations").insert({
            account_id: r.account_id,
            recipient_phone: r.recipient_phone || null,
            recipient_name: r.recipient_name,
            recipient_username: r.recipient_username || null,
            recipient_telegram_id: r.recipient_telegram_id,
            is_active: true,
            first_message_sent: true,
            seat_id: r.campaign_seat_id,
            campaign_id: r.campaign_id,
            campaign_name: r.campaign_name,
          }).select().single();
          conversationId = newConv?.id;
        }

        if (conversationId) {
          await supabase.from("messages").insert({
            account_id: r.account_id,
            conversation_id: conversationId,
            content: r.content || '',
            direction: 'outgoing',
            status: 'sent',
            delivered_at: now,
            campaign_recipient_id: r.campaign_recipient_id,
            api_credential_id: r.api_credential_id,
          });
        }

        // Update account daily counter - ONLY if not already counted
        // NOTE: Campaign counts (sent_count, failed_count, pending_count) are now handled 
        // automatically by the campaign_recipients_sync_counts trigger - do NOT call 
        // increment_campaign_sent_count or increment_campaign_failed_count here as it causes double-counting
        if (!wasAlreadySent) {
          // Increment account's daily message counter for limit enforcement
          if (r.account_id) {
            await supabase.rpc('increment_messages_sent_today', { acc_id: r.account_id });
          }
        }

      } else if (r.message_id) {
        // Livechat message success
        await supabase.from("messages")
          .update({ status: "sent", delivered_at: now })
          .eq("id", r.message_id);
      }

      // Record API usage
      if (r.api_credential_id) {
        await supabase.rpc('increment_api_usage', { p_api_id: r.api_credential_id });
      }

      // Increment account success
      if (r.account_id) {
        await supabase.rpc('increment_account_success', { acc_id: r.account_id });
      }

    } else if (taskType === "warmup_chat" || taskType === "warmup_add_contact") {
      await supabase.from("warmup_messages")
        .update({ status: "sent", sent_at: now })
        .eq("id", r.task_id);

      if (r.is_cycle_last && r.pair_id) {
        await supabase.from("warmup_pairs")
          .update({ contacts_exchanged: true })
          .eq("id", r.pair_id);
      }
    } else if (isAccountActionType(taskType)) {
      // Account action success - update task and account fields
      await supabase.from("account_check_tasks")
        .update({ 
          status: "completed", 
          completed_at: now,
          result: JSON.stringify(r.data || r)
        })
        .eq("id", r.task_id);

      // Update telegram_accounts based on action type
      if (r.account_id) {
        const accountUpdates: Record<string, any> = {};

        if (taskType === "change_name") {
          if (r.first_name) accountUpdates.first_name = r.first_name;
          if (r.last_name !== undefined) accountUpdates.last_name = r.last_name;
        } else if (taskType === "sync_profile" || taskType === "get_me") {
          if (r.first_name) accountUpdates.first_name = r.first_name;
          if (r.last_name !== undefined) accountUpdates.last_name = r.last_name;
          if (r.username !== undefined) accountUpdates.username = r.username;
          if (r.telegram_id) accountUpdates.telegram_id = r.telegram_id;
          
          // Handle avatar from sync_profile
          if (r.avatar_url) {
            if (r.avatar_url.startsWith('data:image')) {
              // Base64 image - upload to storage
              try {
                const base64Data = r.avatar_url.split(',')[1];
                const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
                const filename = `avatars/${r.account_id}_${Date.now()}.jpg`;
                
                const { error: uploadError } = await supabase.storage
                  .from('message-attachments')
                  .upload(filename, binaryData, { contentType: 'image/jpeg', upsert: true });
                
                if (!uploadError) {
                  const { data: urlData } = supabase.storage
                    .from('message-attachments')
                    .getPublicUrl(filename);
                  accountUpdates.avatar_url = urlData.publicUrl;
                  console.log(`[sync_profile] Avatar uploaded: ${filename}`);
                } else {
                  console.error('[sync_profile] Avatar upload error:', uploadError);
                }
              } catch (e) {
                console.error('[sync_profile] Avatar upload failed:', e);
              }
            } else {
              // Direct URL
              accountUpdates.avatar_url = r.avatar_url;
            }
          }
        } else if (taskType === "spambot_check") {
          if (r.status) accountUpdates.spambot_status = r.status;
          accountUpdates.last_spambot_check = now;
        } else if (taskType === "session_check") {
          // Session is valid - ensure account is active
          accountUpdates.status = "active";
          accountUpdates.ban_reason = null;
        } else if (taskType === "change_photo") {
          if (r.photo_url) accountUpdates.avatar_url = r.photo_url;
        } else if (taskType === "change_username") {
          if (r.username !== undefined) accountUpdates.username = r.username;
        }

        if (Object.keys(accountUpdates).length > 0) {
          await supabase.from("telegram_accounts")
            .update(accountUpdates)
            .eq("id", r.account_id);
        }
      }
    }
  }

  // Process failures
  for (const r of failedResults) {
    const taskType = r.task_type || task_type;
    const errorLower = (r.error || '').toLowerCase();

    // === ACCOUNT-LEVEL ERRORS (PeerFlood, FloodWait, etc.) ===
    // These errors mean the SENDER account is rate-limited, not that the recipient is unreachable
    const accountLevelErrors = ['peerflood', 'floodwait', 'userdeactivated', 'authkeyunregistered'];
    const isAccountError = accountLevelErrors.some(e => errorLower.includes(e.toLowerCase()));

    // Check for frozen account
    if (errorLower.includes('frozen')) {
      await supabase.from("telegram_accounts")
        .update({ status: "frozen", ban_reason: r.error })
        .eq("id", r.account_id);
    }

    if (taskType === "send") {
      if (isAccountError && r.account_id) {
        // === ACCOUNT ERROR: Put account in cooldown/restricted, reset recipient for retry ===
        const isPeerFlood = errorLower.includes('peerflood');
        
        // PeerFlood = 12 hours (serious restriction, can't message new users)
        // FloodWait = extract duration + 5 min buffer
        // Other errors = 30 minutes default
        let cooldownMinutes = isPeerFlood ? 720 : 30; // 720 = 12 hours
        const floodWaitMatch = (r.error || '').match(/floodwait[:\s]*(\d+)/i);
        if (floodWaitMatch) {
          const waitSeconds = parseInt(floodWaitMatch[1], 10);
          cooldownMinutes = Math.ceil(waitSeconds / 60) + 5; // Add 5 min buffer
        }
        
        const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();
        const newStatus = isPeerFlood ? "restricted" : "cooldown";
        
        console.log(`[runner-tasks/report] Account error: ${r.error} - setting ${r.account_id} to ${newStatus} for ${cooldownMinutes} minutes`);
        
        // Put account in cooldown or restricted
        await supabase.from("telegram_accounts")
          .update({ 
            status: newStatus, 
            cooldown_until: cooldownUntil,
            restricted_until: cooldownUntil, // Set both for compatibility
            ban_reason: r.error 
          })
          .eq("id", r.account_id);
        
        // Reset recipient to pending for retry by another account
        if (r.campaign_recipient_id) {
          await supabase.from("campaign_recipients")
            .update({ 
              status: "pending", 
              failed_reason: null,
              sent_by_account_id: null,
              // Add the failed account to failed_account_ids to avoid retrying with same account
            })
            .eq("id", r.campaign_recipient_id);
          
          // Also append this account to failed_account_ids array
          const { data: recipient } = await supabase
            .from("campaign_recipients")
            .select("failed_account_ids")
            .eq("id", r.campaign_recipient_id)
            .single();
          
          const failedIds = recipient?.failed_account_ids || [];
          if (!failedIds.includes(r.account_id)) {
            failedIds.push(r.account_id);
            await supabase.from("campaign_recipients")
              .update({ failed_account_ids: failedIds })
              .eq("id", r.campaign_recipient_id);
          }
          
          console.log(`[runner-tasks/report] Reset recipient ${r.campaign_recipient_id} to pending for retry`);
        } else if (r.message_id) {
          // For livechat, just mark as failed since we can't reassign to another account
          await supabase.from("messages")
            .update({ status: "failed", failed_reason: `Account cooldown: ${r.error}` })
            .eq("id", r.message_id);
        }
        
        // Increment failure for the account
        await supabase.rpc('increment_account_failure', { acc_id: r.account_id });
        
      } else {
        // === RECIPIENT ERROR ===
        // NOTE: Campaign counts are updated automatically by trigger when recipient status changes
        
        // Check if this is a "recipient not found" error - needs special retry handling
        const isRecipientNotFound = errorLower.includes('recipient not found') || 
                                     errorLower.includes('no user') || 
                                     errorLower.includes('user not found') ||
                                     errorLower.includes('phone not registered');
        
        if (isRecipientNotFound && r.campaign_recipient_id) {
          // === "RECIPIENT NOT FOUND" ERROR - RETRY WITH DIFFERENT ACCOUNT ===
          // Get current recipient state including retry info
          const { data: recipientInfo } = await supabase
            .from("campaign_recipients")
            .select("campaign_id, phone_number, retry_count, failed_account_ids")
            .eq("id", r.campaign_recipient_id)
            .single();

          if (recipientInfo?.campaign_id) {
            affectedCampaignIds.add(recipientInfo.campaign_id);
          }

          const currentRetryCount = recipientInfo?.retry_count || 0;
          const currentFailedAccounts: string[] = recipientInfo?.failed_account_ids || [];

          // ALWAYS restrict the sender account for 12 hours (treat like PeerFlood)
          if (r.account_id) {
            const cooldownUntil = new Date(Date.now() + 720 * 60 * 1000).toISOString(); // 12 hours
            console.log(`[runner-tasks/report] "Recipient not found" - restricting account ${r.account_id} for 12 hours`);
            
            await supabase.from("telegram_accounts")
              .update({ 
                status: "restricted", 
                cooldown_until: cooldownUntil,
                restricted_until: cooldownUntil,
                ban_reason: `Recipient not found: ${r.error}` 
              })
              .eq("id", r.account_id);
            
            await supabase.rpc('increment_account_failure', { acc_id: r.account_id });
          }

          if (currentRetryCount === 0) {
            // FIRST FAILURE: Retry with different account
            console.log(`[runner-tasks/report] First "recipient not found" for ${recipientInfo?.phone_number}, will retry with different account`);
            
            const updatedFailedAccounts = r.account_id && !currentFailedAccounts.includes(r.account_id) 
              ? [...currentFailedAccounts, r.account_id] 
              : currentFailedAccounts;

            await supabase.from("campaign_recipients")
              .update({ 
                status: "pending",
                retry_count: 1,
                failed_account_ids: updatedFailedAccounts,
                failed_reason: null,
                sent_by_account_id: null
              })
              .eq("id", r.campaign_recipient_id);
              
          } else {
            // SECOND+ FAILURE: Multiple accounts failed, permanent failure
            console.log(`[runner-tasks/report] Multiple accounts failed for ${recipientInfo?.phone_number}, marking as permanently failed`);
            
            const updatedFailedAccounts = r.account_id && !currentFailedAccounts.includes(r.account_id) 
              ? [...currentFailedAccounts, r.account_id] 
              : currentFailedAccounts;

            await supabase.from("campaign_recipients")
              .update({ 
                status: "failed", 
                sent_by_account_id: r.account_id, 
                failed_reason: "Recipient not found (confirmed by multiple accounts)",
                failed_account_ids: updatedFailedAccounts
              })
              .eq("id", r.campaign_recipient_id);

            // Mark contact as used
            if (recipientInfo?.phone_number) {
              await supabase.from("contacts_data")
                .update({ 
                  is_used: true, 
                  used_at: now, 
                  notes: 'Auto-marked: Recipient not found (verified by multiple accounts)' 
                })
                .eq("phone_number", recipientInfo.phone_number);
            }
          }
          
        } else if (r.campaign_recipient_id) {
          // === OTHER RECIPIENT ERRORS - Fail immediately ===
          const { data: recipientInfo } = await supabase
            .from("campaign_recipients")
            .select("campaign_id")
            .eq("id", r.campaign_recipient_id)
            .single();
          
          if (recipientInfo?.campaign_id) {
            affectedCampaignIds.add(recipientInfo.campaign_id);
          }
          
          await supabase.from("campaign_recipients")
            .update({ status: "failed", sent_by_account_id: r.account_id, failed_reason: r.error })
            .eq("id", r.campaign_recipient_id);
          
          // Increment account failure for other recipient errors
          if (r.account_id) {
            await supabase.rpc('increment_account_failure', { acc_id: r.account_id });
          }
        } else if (r.message_id) {
          await supabase.from("messages")
            .update({ status: "failed", failed_reason: r.error })
            .eq("id", r.message_id);
          
          if (r.account_id) {
            await supabase.rpc('increment_account_failure', { acc_id: r.account_id });
          }
        }
      }

    } else if (taskType === "warmup_chat" || taskType === "warmup_add_contact") {
      await supabase.from("warmup_messages")
        .update({ status: "failed", error_message: r.error })
        .eq("id", r.task_id);

      if (r.pair_id) {
        await supabase.from("warmup_pairs")
          .update({ status: "failed", failed_reason: r.error })
          .eq("id", r.pair_id);
      }
      
      // Also put account in cooldown/restricted for account-level errors during warmup
      if (isAccountError && r.account_id) {
        const isPeerFlood = errorLower.includes('peerflood');
        const cooldownMinutes = isPeerFlood ? 720 : 30;
        const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();
        
        await supabase.from("telegram_accounts")
          .update({ 
            status: isPeerFlood ? "restricted" : "cooldown", 
            cooldown_until: cooldownUntil,
            restricted_until: cooldownUntil,
            ban_reason: r.error 
          })
          .eq("id", r.account_id);
      }
    } else if (isAccountActionType(taskType)) {
      // Account action failure
      await supabase.from("account_check_tasks")
        .update({ 
          status: "failed", 
          completed_at: now,
          result: r.error || "Unknown error"
        })
        .eq("id", r.task_id);

      // Handle specific error types that affect account status
      if (r.account_id) {
        if (errorLower.includes('banned') || errorLower.includes('deactivated')) {
          await supabase.from("telegram_accounts")
            .update({ status: "banned", ban_reason: r.error })
            .eq("id", r.account_id);
        } else if (errorLower.includes('session') || errorLower.includes('auth key')) {
          await supabase.from("telegram_accounts")
            .update({ status: "disconnected", ban_reason: r.error })
            .eq("id", r.account_id);
        }
      }
    }
  }

  console.log(`[runner-tasks/report] Processed: ${successResults.length} success, ${failedResults.length} failed, ${incomingMessages.length} incoming`);

  // === AUTO-COMPLETE CAMPAIGNS ===
  // Check if any affected campaigns are now complete (0 pending recipients)
  let campaignsCompleted = 0;
  for (const campaignId of affectedCampaignIds) {
    // Check if campaign is still running and has no pending recipients
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, status')
      .eq('id', campaignId)
      .eq('status', 'running')
      .single();
    
    if (campaign) {
      const { count: pendingCount } = await supabase
        .from('campaign_recipients')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'sending', 'queued']);

      if (pendingCount === 0) {
        await supabase.from('campaigns')
          .update({ status: 'completed', updated_at: now })
          .eq('id', campaignId);
        campaignsCompleted++;
        console.log(`[runner-tasks/report] Campaign ${campaignId} auto-completed (0 pending recipients)`);
      }
    }
  }

  return jsonResponse({
    success: true,
    processed: allResults.length,
    succeeded: successResults.length,
    failed: failedResults.length,
    incoming: incomingMessages.length,
    campaignsCompleted,
  });
}

// ==================== PROCESS INCOMING MESSAGE ====================
async function processIncomingMessage(supabase: any, r: any, now: string) {
  const accountId = r.account_id;
  const senderId = r.sender_id || r.recipient_telegram_id;
  const senderPhone = r.sender_phone || r.recipient_phone;
  const senderName = r.sender_name || r.recipient_name;
  const senderUsername = r.sender_username || r.recipient_username;
  const content = r.content || "[Media]";
  const telegramMessageId = r.telegram_message_id;

  // Process media if provided
  let mediaUrl: string | null = null;
  let mediaType: string | null = r.media_type || null;
  
  if (r.media_url && r.media_url.startsWith('data:')) {
    try {
      const base64Data = r.media_url.split(',')[1];
      const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      
      const ext = mediaType === 'image' ? 'jpg' : mediaType === 'video' ? 'mp4' : 'bin';
      const filename = `incoming/${accountId}/${Date.now()}_${telegramMessageId || 'msg'}.${ext}`;
      
      const { error: uploadError } = await supabase.storage
        .from('message-attachments')
        .upload(filename, binaryData, { 
          contentType: mediaType === 'image' ? 'image/jpeg' : 
                       mediaType === 'video' ? 'video/mp4' : 
                       'application/octet-stream',
          upsert: true 
        });
      
      if (!uploadError) {
        const { data: urlData } = supabase.storage
          .from('message-attachments')
          .getPublicUrl(filename);
        mediaUrl = urlData.publicUrl;
        console.log(`[incoming] Uploaded media: ${filename}`);
      } else {
        console.error('[incoming] Media upload error:', uploadError);
      }
    } catch (e) {
      console.error('[incoming] Media processing failed:', e);
    }
  } else if (r.media_url) {
    // Direct URL (already hosted)
    mediaUrl = r.media_url;
  }

  if (!accountId) {
    console.log("[incoming] Skipping - no account_id");
    return;
  }

  if (!senderId && !senderPhone) {
    console.log("[incoming] Skipping - no sender identifier");
    return;
  }

  // Deduplicate by telegram_message_id if provided
  if (telegramMessageId) {
    const { data: existingMsg } = await supabase
      .from("messages")
      .select("id")
      .eq("account_id", accountId)
      .eq("telegram_message_id", telegramMessageId)
      .maybeSingle();

    if (existingMsg) {
      console.log(`[incoming] Duplicate message ${telegramMessageId}, skipping`);
      return;
    }
  }

  // Find existing conversation by account_id + sender (telegram_id or phone)
  let conversationId: string | null = null;
  
  if (senderId) {
    const { data: convByTgId } = await supabase
      .from("conversations")
      .select("id")
      .eq("account_id", accountId)
      .eq("recipient_telegram_id", senderId)
      .maybeSingle();
    
    if (convByTgId) {
      conversationId = convByTgId.id;
    }
  }

  if (!conversationId && senderUsername) {
    const { data: convByUsername } = await supabase
      .from("conversations")
      .select("id")
      .eq("account_id", accountId)
      .eq("recipient_username", senderUsername)
      .maybeSingle();
    
    if (convByUsername) {
      conversationId = convByUsername.id;
    }
  }

  if (!conversationId && senderPhone) {
    const { data: convByPhone } = await supabase
      .from("conversations")
      .select("id")
      .eq("account_id", accountId)
      .eq("recipient_phone", senderPhone)
      .maybeSingle();
    
    if (convByPhone) {
      conversationId = convByPhone.id;
    }
  }

  // Create new conversation if not found
  if (!conversationId) {
    // Try to find seat_id from campaign_recipients that sent to this recipient
    let seatId: string | null = null;
    
    // Normalize phone for lookup (strip +, spaces, etc.)
    const normalizedPhone = (senderPhone || '').replace(/[^0-9]/g, '');
    
    if (normalizedPhone) {
      // Find campaign_recipient that was sent to this phone number by this account
      const { data: campaignRecipient } = await supabase
        .from("campaign_recipients")
        .select("seat_id, campaigns(seat_id)")
        .eq("sent_by_account_id", accountId)
        .eq("status", "sent")
        .or(`phone_number.eq.${senderPhone},phone_number.eq.+${normalizedPhone},phone_number.like.%${normalizedPhone}`)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (campaignRecipient) {
        seatId = campaignRecipient.seat_id || (campaignRecipient.campaigns as any)?.seat_id || null;
        console.log(`[incoming] Found seat_id ${seatId} from campaign_recipients (by phone)`);
      }
    }

    // Also try to find seat_id by username if phone lookup didn't work
    if (!seatId && senderUsername) {
      const usernameWithAt = senderUsername.startsWith('@') ? senderUsername : `@${senderUsername}`;
      const usernameWithoutAt = senderUsername.replace(/^@/, '');
      const { data: campaignRecipient } = await supabase
        .from("campaign_recipients")
        .select("seat_id, campaigns(seat_id)")
        .eq("sent_by_account_id", accountId)
        .eq("status", "sent")
        .or(`phone_number.eq.${usernameWithAt},phone_number.eq.${usernameWithoutAt}`)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (campaignRecipient) {
        seatId = campaignRecipient.seat_id || (campaignRecipient.campaigns as any)?.seat_id || null;
        console.log(`[incoming] Found seat_id ${seatId} from campaign_recipients (by username)`);
      }
    }

    const { data: newConv, error: convError } = await supabase
      .from("conversations")
      .insert({
        account_id: accountId,
        recipient_telegram_id: senderId,
        recipient_phone: senderPhone,
        recipient_name: senderName,
        recipient_username: senderUsername,
        is_active: true,
        has_reply: true,
        last_message_at: now,
        last_message_content: content.substring(0, 200),
        last_message_direction: 'incoming',
        unread_count: 1,
        seat_id: seatId,
      })
      .select()
      .single();

    if (convError) {
      console.log(`[incoming] Error creating conversation: ${convError.message}`);
      return;
    }
    
    conversationId = newConv.id;
    console.log(`[incoming] Created new conversation ${conversationId}`);
  } else {
    // Update existing conversation
    await supabase
      .from("conversations")
      .update({
        last_message_at: now,
        last_message_content: content.substring(0, 200),
        last_message_direction: 'incoming',
        has_reply: true,
        unread_count: supabase.rpc ? undefined : 1, // Will use raw SQL increment below
        recipient_telegram_id: senderId || undefined,
        recipient_name: senderName || undefined,
        recipient_username: senderUsername || undefined,
      })
      .eq("id", conversationId);

    // Increment unread_count atomically
    try {
      const { error: rpcError } = await supabase.rpc('increment_unread_count', { conv_id: conversationId });
      if (rpcError) {
        // Fallback if RPC doesn't exist - just update to at least 1
        await supabase.from("conversations").update({ unread_count: 1 }).eq("id", conversationId).eq("unread_count", 0);
      }
    } catch {
      // Fallback if RPC doesn't exist
      await supabase.from("conversations").update({ unread_count: 1 }).eq("id", conversationId).eq("unread_count", 0);
    }

    console.log(`[incoming] Updated conversation ${conversationId}`);
  }

  // Insert the incoming message with media
  const { error: msgError } = await supabase
    .from("messages")
    .insert({
      account_id: accountId,
      conversation_id: conversationId,
      content: content,
      direction: 'incoming',
      status: 'delivered',
      delivered_at: now,
      telegram_message_id: telegramMessageId,
      media_url: mediaUrl,
      media_type: mediaType,
    });

  if (msgError) {
    console.log(`[incoming] Error inserting message: ${msgError.message}`);
  } else {
    console.log(`[incoming] Saved message from ${senderName || senderId} to conversation ${conversationId}${mediaUrl ? ' (with media)' : ''}`);
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
