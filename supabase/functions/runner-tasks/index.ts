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
    campaignPollingInterval: 3,
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

// Get API credentials for account (per-account first, then pool)
async function getApiCredentialsForAccount(supabase: any, account: any) {
  if (account.api_id && account.api_hash) {
    return { api_id: account.api_id, api_hash: account.api_hash, api_credential_id: null };
  }
  const { data: apis } = await supabase
    .from('telegram_api_credentials')
    .select('id, api_id, api_hash')
    .eq('is_active', true)
    .order('usage_count', { ascending: true })
    .limit(1);
  if (apis && apis.length > 0) {
    return { api_id: apis[0].api_id, api_hash: apis[0].api_hash, api_credential_id: apis[0].id };
  }
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
      const { runner } = body;
      if (runner) {
        await supabase.from("runner_heartbeats").upsert(
          { runner_name: runner, last_seen: new Date().toISOString(), status: 'online' },
          { onConflict: 'runner_name' }
        );
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
  const { runner, batch_size = 100, account_ids } = body;
  const nowIso = new Date().toISOString();

  console.log(`[runner-tasks/get] Runner: ${runner}, batch_size: ${batch_size}`);

  // Record heartbeat
  if (runner) {
    supabase.from("runner_heartbeats")
      .upsert({ runner_name: runner, last_seen: nowIso, status: 'online' }, { onConflict: 'runner_name' })
      .then(() => {});
  }

  const settingsData = await getCachedSettings(supabase);
  const config = parseSettings(settingsData);

  // Auto-restore expired cooldowns
  const { data: expiredCooldowns } = await supabase
    .from("telegram_accounts")
    .select("id")
    .in("status", ["cooldown", "restricted"])
    .lt("restricted_until", nowIso);
  
  if (expiredCooldowns?.length > 0) {
    await supabase.from("telegram_accounts")
      .update({ status: "active", restricted_until: null, ban_reason: null })
      .in("id", expiredCooldowns.map((a: any) => a.id));
  }

  // Load accounts with proxies
  const isLivechat = runner === "livechat";
  let accountsQuery = supabase.from("telegram_accounts").select("*, proxies!fk_proxy(*)");
  
  if (isLivechat) {
    accountsQuery = accountsQuery.in("status", ["active", "restricted", "cooldown", "frozen"]);
  } else {
    accountsQuery = accountsQuery.eq("status", "active");
  }
  
  if (account_ids?.length > 0) {
    accountsQuery = accountsQuery.in("id", account_ids);
  }

  const { data: accounts, error: accountsError } = await accountsQuery;

  if (accountsError || !accounts?.length) {
    return jsonResponse({ tasks: [], accounts: [], delay_after: 30, reason: "No active accounts" });
  }

  // Filter accounts with active proxy
  const usableAccounts = accounts.filter((a: any) => {
    if (!a.proxy_id || !a.proxies || a.proxies.status !== 'active') return false;
    if (!isLivechat) {
      const limit = config.campaignMessagesPerAccountPerDay || a.daily_limit || config.dailyLimit;
      if ((a.messages_sent_today ?? 0) >= limit) return false;
    }
    return true;
  });

  if (usableAccounts.length === 0) {
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
      // Track how many tasks we've assigned to each account in this batch
      // This enables round-robin distribution across accounts
      const assignedCountByAccountId: Record<string, number> = {};
      
      for (const r of recipients) {
        // Find the account with the lowest effective usage (sent_today + assigned_in_batch)
        // This distributes tasks evenly across all available accounts
        const dailyLimit = config.campaignMessagesPerAccountPerDay || config.dailyLimit;
        
        let bestAccount: any = null;
        let lowestUsage = Infinity;
        
        for (const acc of usableAccounts) {
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

        const content = (r.campaigns.message_template || '')
          .replace(/{name}/g, r.name || 'there')
          .replace(/{phone}/g, r.phone_number);

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
            phone: r.phone_number,
            name: r.name,
            telegram_id: null,
            username: null,
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
        if (!sender?.session_data || !sender?.proxies || sender.proxies.status !== 'active') continue;

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
        if (!account?.proxies || account.proxies.status !== 'active') continue;

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
        if (!account?.proxies || account.proxies.status !== 'active') continue;

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

  // Build accounts list for listening
  const listeningAccounts = await Promise.all(usableAccounts.map(async (acc: any) => {
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
    };
  })).then(results => results.filter(Boolean));

  console.log(`[runner-tasks/get] Returning ${tasks.length} tasks, ${listeningAccounts.length} accounts`);

  return jsonResponse({
    tasks,
    accounts: listeningAccounts,
    delay_after: tasks.length > 0 ? config.campaignPollingInterval : 5,
    settings: config.livechatSettings,
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
        // Campaign message success
        await supabase.from("campaign_recipients")
          .update({ status: "sent", sent_at: now, api_credential_id: r.api_credential_id })
          .eq("id", r.campaign_recipient_id);

        // Create/update conversation
        let conversationId: string | null = null;
        const { data: existingConv } = await supabase
          .from("conversations")
          .select("id")
          .eq("account_id", r.account_id)
          .eq("recipient_phone", r.recipient_phone)
          .maybeSingle();

        if (existingConv) {
          conversationId = existingConv.id;
          if (r.recipient_telegram_id) {
            await supabase.from("conversations")
              .update({ recipient_telegram_id: r.recipient_telegram_id })
              .eq("id", conversationId);
          }
        } else {
          const { data: newConv } = await supabase.from("conversations").insert({
            account_id: r.account_id,
            recipient_phone: r.recipient_phone,
            recipient_name: r.recipient_name,
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

        // Update campaign count
        await supabase.rpc('increment_campaign_sent_count', { cid: r.campaign_id });

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

    // Check for frozen account
    if (errorLower.includes('frozen')) {
      await supabase.from("telegram_accounts")
        .update({ status: "frozen", ban_reason: r.error })
        .eq("id", r.account_id);
    }

    if (taskType === "send") {
      if (r.campaign_recipient_id) {
        await supabase.from("campaign_recipients")
          .update({ status: "failed", failed_reason: r.error })
          .eq("id", r.campaign_recipient_id);
        await supabase.rpc('increment_campaign_failed_count', { cid: r.campaign_id });
      } else if (r.message_id) {
        await supabase.from("messages")
          .update({ status: "failed", failed_reason: r.error })
          .eq("id", r.message_id);
      }

      if (r.account_id) {
        await supabase.rpc('increment_account_failure', { acc_id: r.account_id });
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

  return jsonResponse({
    success: true,
    processed: allResults.length,
    succeeded: successResults.length,
    failed: failedResults.length,
    incoming: incomingMessages.length,
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
    // Get account's seat_id for new conversation
    const { data: account } = await supabase
      .from("telegram_accounts")
      .select("id")
      .eq("id", accountId)
      .single();

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
    await supabase.rpc('increment_unread_count', { conv_id: conversationId }).catch(() => {
      // Fallback if RPC doesn't exist - just update to at least 1
      supabase.from("conversations").update({ unread_count: 1 }).eq("id", conversationId).eq("unread_count", 0);
    });

    console.log(`[incoming] Updated conversation ${conversationId}`);
  }

  // Insert the incoming message
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
    });

  if (msgError) {
    console.log(`[incoming] Error inserting message: ${msgError.message}`);
  } else {
    console.log(`[incoming] Saved message from ${senderName || senderId} to conversation ${conversationId}`);
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
