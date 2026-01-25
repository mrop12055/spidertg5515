import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Batch size for parallel processing
const BATCH_SIZE = 100;

// Helper: Process array in parallel batches
async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

// Helper: Safe delete with retry
async function safeDeleteWithRetry(
  supabase: any,
  table: string,
  ids: string[],
  maxRetries = 3
): Promise<{ success: boolean; deleted: number }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase
        .from(table)
        .delete()
        .in('id', ids)
        .select('id');
      
      if (error) throw error;
      return { success: true, deleted: data?.length || 0 };
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(`[system-maintenance] Failed to delete from ${table} after ${maxRetries} attempts:`, err);
        return { success: false, deleted: 0 };
      }
      await new Promise(r => setTimeout(r, 100 * attempt)); // Exponential backoff
    }
  }
  return { success: false, deleted: 0 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[system-maintenance] Starting automated maintenance (advanced v2)...');
    
    const stats = {
      daily_counts_reset: 0,
      stuck_messages_reset: 0,
      stale_account_tasks_cancelled: 0,
      stale_block_tasks_cancelled: 0,
      stale_contact_import_tasks_cancelled: 0,
      old_completed_tasks_cleaned: 0,
      old_heartbeats_cleaned: 0,
      old_conversations_deleted: 0,
      old_messages_deleted: 0,
      expired_restrictions_recovered: 0,
      stale_ban_reasons_cleared: 0,
      proxy_errors_cleaned: 0,
      warmup_errors_cleaned: 0,
      vps_logs_cleaned: 0,
      api_daily_usage_reset: 0,
    };

    // Calculate time boundaries once (avoid repeated Date calculations)
    const now = new Date();
    const nowIso = now.toISOString();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ==================== PHASE 1: QUICK FIXES (parallel) ====================
    console.log('[system-maintenance] Phase 1: Quick fixes...');
    
    const [
      resetAccountsResult,
      stuckMessagesResult,
      expiredRestrictionsResult,
      staleReasonsResult,
      apiDailyResetResult
    ] = await Promise.all([
      // 0. Reset daily message counts for ALL accounts with messages_sent_today > 0
      supabase
        .from('telegram_accounts')
        .update({ messages_sent_today: 0 })
        .gt('messages_sent_today', 0)
        .select('id'),
      
      // 1. Reset stuck "sending" messages older than 2 minutes back to "pending"
      supabase
        .from('messages')
        .update({ status: 'pending' })
        .eq('status', 'sending')
        .lt('created_at', twoMinutesAgo)
        .select('id'),
      
      // 10. Auto-recover frozen/restricted accounts with expired restriction timers
      supabase
        .from('telegram_accounts')
        .update({ status: 'active', restricted_until: null, ban_reason: null })
        .in('status', ['restricted', 'cooldown', 'frozen'])
        .not('restricted_until', 'is', null)
        .lte('restricted_until', nowIso)
        .select('id, phone_number'),
      
      // 11. Fix active accounts that have ban_reason but NO valid restriction timer
      supabase
        .from('telegram_accounts')
        .update({ ban_reason: null })
        .eq('status', 'active')
        .not('ban_reason', 'is', null)
        .neq('ban_reason', '')
        .or('restricted_until.is.null,restricted_until.lte.' + nowIso)
        .select('id, phone_number'),
      
      // Reset API daily usage counts at midnight (if running at midnight)
      now.getUTCHours() === 0 ? supabase
        .from('telegram_api_credentials')
        .update({ daily_usage: 0, daily_usage_reset_at: nowIso })
        .gt('daily_usage', 0)
        .select('id') : Promise.resolve({ data: null }),
    ]);

    stats.daily_counts_reset = resetAccountsResult.data?.length || 0;
    stats.stuck_messages_reset = stuckMessagesResult.data?.length || 0;
    stats.expired_restrictions_recovered = expiredRestrictionsResult.data?.length || 0;
    stats.stale_ban_reasons_cleared = staleReasonsResult.data?.length || 0;
    stats.api_daily_usage_reset = apiDailyResetResult?.data?.length || 0;

    if (stats.daily_counts_reset > 0) {
      console.log(`[system-maintenance] Reset daily message counts for ${stats.daily_counts_reset} accounts`);
    }
    if (stats.stuck_messages_reset > 0) {
      console.log(`[system-maintenance] Reset ${stats.stuck_messages_reset} stuck messages`);
    }
    if (stats.expired_restrictions_recovered > 0) {
      console.log(`[system-maintenance] Recovered ${stats.expired_restrictions_recovered} accounts with expired restrictions`);
    }

    // ==================== PHASE 2: STALE TASK CANCELLATION (parallel) ====================
    console.log('[system-maintenance] Phase 2: Cancelling stale tasks...');
    
    const [
      staleAccountTasksResult,
      staleBlockTasksResult,
      staleImportTasksResult
    ] = await Promise.all([
      // 2. Cancel stale pending account_check_tasks older than 24 hours
      supabase
        .from('account_check_tasks')
        .update({ status: 'cancelled', result: 'Cancelled: stale task (24h timeout)' })
        .eq('status', 'pending')
        .lt('created_at', oneDayAgo)
        .select('id'),
      
      // 3. Cancel stale pending block_contact_tasks older than 24 hours
      supabase
        .from('block_contact_tasks')
        .update({ status: 'cancelled', result: 'Cancelled: stale task (24h timeout)' })
        .eq('status', 'pending')
        .lt('created_at', oneDayAgo)
        .select('id'),
      
      // 4. Cancel stale pending contact_import_tasks older than 48 hours (longer for large imports)
      supabase
        .from('contact_import_tasks')
        .update({ status: 'cancelled', result: 'Cancelled: stale task (48h timeout)' })
        .eq('status', 'pending')
        .lt('created_at', twoDaysAgo)
        .select('id'),
    ]);

    stats.stale_account_tasks_cancelled = staleAccountTasksResult.data?.length || 0;
    stats.stale_block_tasks_cancelled = staleBlockTasksResult.data?.length || 0;
    stats.stale_contact_import_tasks_cancelled = staleImportTasksResult.data?.length || 0;

    // ==================== PHASE 3: OLD DATA CLEANUP (parallel batched) ====================
    console.log('[system-maintenance] Phase 3: Cleaning old data...');
    
    const [
      oldAccountTasksResult,
      oldBlockTasksResult,
      oldImportTasksResult,
      oldHeartbeatsResult,
      oldProxyErrorsResult,
      oldWarmupErrorsResult,
      oldVpsLogsResult
    ] = await Promise.all([
      // Clean old completed account_check_tasks (7 days)
      supabase
        .from('account_check_tasks')
        .delete()
        .in('status', ['completed', 'cancelled', 'failed'])
        .lt('created_at', sevenDaysAgo)
        .select('id'),
      
      // Clean old completed block_contact_tasks (7 days)
      supabase
        .from('block_contact_tasks')
        .delete()
        .in('status', ['completed', 'cancelled', 'failed'])
        .lt('created_at', sevenDaysAgo)
        .select('id'),
      
      // Clean old completed contact_import_tasks (7 days)
      supabase
        .from('contact_import_tasks')
        .delete()
        .in('status', ['completed', 'cancelled', 'failed'])
        .lt('created_at', sevenDaysAgo)
        .select('id'),
      
      // Clean old runner heartbeats (1 day)
      supabase
        .from('runner_heartbeats')
        .delete()
        .lt('last_seen', oneDayAgo)
        .select('id'),
      
      // Clean old proxy_errors (30 days)
      supabase
        .from('proxy_errors')
        .delete()
        .lt('created_at', thirtyDaysAgo)
        .select('id'),
      
      // Clean old warmup_errors (30 days)
      supabase
        .from('warmup_errors')
        .delete()
        .lt('created_at', thirtyDaysAgo)
        .select('id'),
      
      // Clean old vps_logs (7 days)
      supabase
        .from('vps_logs')
        .delete()
        .lt('created_at', sevenDaysAgo)
        .select('id'),
    ]);

    stats.old_completed_tasks_cleaned = 
      (oldAccountTasksResult.data?.length || 0) + 
      (oldBlockTasksResult.data?.length || 0) + 
      (oldImportTasksResult.data?.length || 0);
    stats.old_heartbeats_cleaned = oldHeartbeatsResult.data?.length || 0;
    stats.proxy_errors_cleaned = oldProxyErrorsResult.data?.length || 0;
    stats.warmup_errors_cleaned = oldWarmupErrorsResult.data?.length || 0;
    stats.vps_logs_cleaned = oldVpsLogsResult.data?.length || 0;

    // Additional parallel cleanup for warmup/interaction/maturation (no count tracking)
    await Promise.all([
      supabase
        .from('warmup_schedule')
        .delete()
        .eq('status', 'completed')
        .lt('completed_at', sevenDaysAgo),
      
      supabase
        .from('interaction_scheduler')
        .delete()
        .eq('status', 'completed')
        .lt('sent_at', sevenDaysAgo),
      
      supabase
        .from('maturation_tasks')
        .delete()
        .eq('status', 'completed')
        .lt('completed_at', sevenDaysAgo),
      
      supabase
        .from('scheduled_interactions')
        .delete()
        .eq('status', 'completed')
        .lt('sent_at', sevenDaysAgo),
    ]);

    // ==================== PHASE 4: CONVERSATION CLEANUP (cascading) ====================
    console.log('[system-maintenance] Phase 4: Cleaning old conversations...');
    
    // Get conversation IDs to delete (5 days old)
    const { data: oldConversations } = await supabase
      .from('conversations')
      .select('id')
      .lt('last_message_at', fiveDaysAgo)
      .limit(500); // Process in batches to avoid timeout

    if (oldConversations && oldConversations.length > 0) {
      const convIds = oldConversations.map(c => c.id);
      
      // Delete messages first (foreign key constraint) - in batches
      for (let i = 0; i < convIds.length; i += BATCH_SIZE) {
        const batch = convIds.slice(i, i + BATCH_SIZE);
        const { data: deletedMessages } = await supabase
          .from('messages')
          .delete()
          .in('conversation_id', batch)
          .select('id');
        
        stats.old_messages_deleted += deletedMessages?.length || 0;
      }
      
      // Now delete conversations
      const { data: deletedConvs } = await supabase
        .from('conversations')
        .delete()
        .in('id', convIds)
        .select('id');
      
      stats.old_conversations_deleted = deletedConvs?.length || 0;
      console.log(`[system-maintenance] Deleted ${stats.old_conversations_deleted} conversations and ${stats.old_messages_deleted} messages`);
    }

    // ==================== PHASE 5: ACCOUNT HEALTH RECALCULATION ====================
    console.log('[system-maintenance] Phase 5: Recalculating account health...');
    
    // Fix accounts with null success_rate but positive success/failure counts
    const { data: accountsWithNullRate } = await supabase
      .from('telegram_accounts')
      .select('id, success_count, failure_count')
      .is('success_rate', null)
      .or('success_count.gt.0,failure_count.gt.0');
    
    if (accountsWithNullRate && accountsWithNullRate.length > 0) {
      const healthUpdates = accountsWithNullRate.map((a: any) => {
        const total = (a.success_count || 0) + (a.failure_count || 0);
        const rate = total > 0 ? Math.round(((a.success_count || 0) / total) * 1000) / 10 : null;
        return { id: a.id, success_rate: rate };
      });
      
      // Update in batches
      for (const update of healthUpdates) {
        await supabase
          .from('telegram_accounts')
          .update({ success_rate: update.success_rate })
          .eq('id', update.id);
      }
      
      console.log(`[system-maintenance] Recalculated health for ${healthUpdates.length} accounts`);
    }

    // ==================== SUMMARY ====================
    const duration = Date.now() - startTime;
    const totalCleaned = Object.values(stats).reduce((a, b) => a + b, 0);

    if (totalCleaned > 0) {
      console.log(`[system-maintenance] Maintenance complete in ${duration}ms:`, stats);
    } else {
      console.log(`[system-maintenance] No maintenance needed (${duration}ms), system is clean`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        stats,
        duration_ms: duration,
        timestamp: nowIso,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    console.error(`[system-maintenance] Error after ${duration}ms:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage, duration_ms: duration }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
