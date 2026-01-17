import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[system-maintenance] Starting automated maintenance...');
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
    };

    // 0. Reset daily message counts for accounts whose last send was yesterday or earlier
    // This ensures "messages_sent_today" reflects only today's activity
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartIso = todayStart.toISOString();
    
    const { data: resetAccounts, error: resetError } = await supabase
      .from('telegram_accounts')
      .update({ messages_sent_today: 0 })
      .gt('messages_sent_today', 0)
      .or(`last_campaign_send_at.is.null,last_campaign_send_at.lt.${todayStartIso}`)
      .select('id');
    
    if (resetError) {
      console.error('[system-maintenance] Error resetting daily counts:', resetError);
    } else {
      stats.daily_counts_reset = resetAccounts?.length || 0;
      if (stats.daily_counts_reset > 0) {
        console.log(`[system-maintenance] Reset daily message counts for ${stats.daily_counts_reset} accounts`);
      }
    }

    // 1. Reset stuck "sending" messages older than 2 minutes back to "pending"
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuckMessages, error: stuckError } = await supabase
      .from('messages')
      .update({ status: 'pending' })
      .eq('status', 'sending')
      .lt('created_at', twoMinutesAgo)
      .select('id');
    
    if (stuckError) {
      console.error('[system-maintenance] Error resetting stuck messages:', stuckError);
    } else {
      stats.stuck_messages_reset = stuckMessages?.length || 0;
      if (stats.stuck_messages_reset > 0) {
        console.log(`[system-maintenance] Reset ${stats.stuck_messages_reset} stuck messages`);
      }
    }

    // 2. Cancel stale pending account_check_tasks older than 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: staleAccountTasks, error: accountTasksError } = await supabase
      .from('account_check_tasks')
      .update({ status: 'cancelled', result: 'Cancelled: stale task' })
      .eq('status', 'pending')
      .lt('created_at', oneDayAgo)
      .select('id');
    
    if (accountTasksError) {
      console.error('[system-maintenance] Error cancelling stale account tasks:', accountTasksError);
    } else {
      stats.stale_account_tasks_cancelled = staleAccountTasks?.length || 0;
    }

    // 3. Cancel stale pending block_contact_tasks older than 24 hours
    const { data: staleBlockTasks, error: blockTasksError } = await supabase
      .from('block_contact_tasks')
      .update({ status: 'cancelled', result: 'Cancelled: stale task' })
      .eq('status', 'pending')
      .lt('created_at', oneDayAgo)
      .select('id');
    
    if (blockTasksError) {
      console.error('[system-maintenance] Error cancelling stale block tasks:', blockTasksError);
    } else {
      stats.stale_block_tasks_cancelled = staleBlockTasks?.length || 0;
    }

    // 4. Cancel stale pending contact_import_tasks older than 24 hours
    const { data: staleImportTasks, error: importTasksError } = await supabase
      .from('contact_import_tasks')
      .update({ status: 'cancelled', result: 'Cancelled: stale task' })
      .eq('status', 'pending')
      .lt('created_at', oneDayAgo)
      .select('id');
    
    if (importTasksError) {
      console.error('[system-maintenance] Error cancelling stale import tasks:', importTasksError);
    } else {
      stats.stale_contact_import_tasks_cancelled = staleImportTasks?.length || 0;
    }

    // 5. Clean completed tasks older than 7 days - RUN IN PARALLEL
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Execute all cleanup operations in parallel for speed
    const [
      oldAccountTasksResult,
      oldBlockTasksResult,
      oldImportTasksResult,
      oldHeartbeatsResult,
      // These don't return data but run in parallel
      ..._cleanupResults
    ] = await Promise.all([
      // Clean old completed account_check_tasks
      supabase
        .from('account_check_tasks')
        .delete()
        .in('status', ['completed', 'cancelled', 'failed'])
        .lt('created_at', sevenDaysAgo)
        .select('id'),
      
      // Clean old completed block_contact_tasks
      supabase
        .from('block_contact_tasks')
        .delete()
        .in('status', ['completed', 'cancelled', 'failed'])
        .lt('created_at', sevenDaysAgo)
        .select('id'),
      
      // Clean old completed contact_import_tasks
      supabase
        .from('contact_import_tasks')
        .delete()
        .in('status', ['completed', 'cancelled', 'failed'])
        .lt('created_at', sevenDaysAgo)
        .select('id'),
      
      // Clean old runner heartbeats older than 1 day
      supabase
        .from('runner_heartbeats')
        .delete()
        .lt('last_seen', oneDayAgo)
        .select('id'),
      
      // Clean old completed warmup_schedule tasks older than 7 days
      supabase
        .from('warmup_schedule')
        .delete()
        .eq('status', 'completed')
        .lt('completed_at', sevenDaysAgo),
      
      // Clean old completed interaction_scheduler tasks older than 7 days
      supabase
        .from('interaction_scheduler')
        .delete()
        .eq('status', 'completed')
        .lt('sent_at', sevenDaysAgo),
      
      // Clean old completed maturation_tasks older than 7 days
      supabase
        .from('maturation_tasks')
        .delete()
        .eq('status', 'completed')
        .lt('completed_at', sevenDaysAgo),
    ]);

    stats.old_completed_tasks_cleaned = 
      (oldAccountTasksResult.data?.length || 0) + 
      (oldBlockTasksResult.data?.length || 0) + 
      (oldImportTasksResult.data?.length || 0);
    
    stats.old_heartbeats_cleaned = oldHeartbeatsResult.data?.length || 0;

    // 10. Auto-recover frozen/restricted accounts with expired restriction timers
    // These are accounts that got temporary FloodWait errors and should be back to active
    const nowIso = new Date().toISOString();
    const { data: expiredRestrictions, error: expiredError } = await supabase
      .from('telegram_accounts')
      .update({ status: 'active', restricted_until: null, ban_reason: null })
      .in('status', ['restricted', 'cooldown', 'frozen'])
      .not('restricted_until', 'is', null)
      .lte('restricted_until', nowIso)
      .select('id, phone_number');
    
    if (expiredError) {
      console.error('[system-maintenance] Error recovering expired restrictions:', expiredError);
    } else if (expiredRestrictions && expiredRestrictions.length > 0) {
      console.log(`[system-maintenance] Recovered ${expiredRestrictions.length} accounts with expired restrictions:`,
        expiredRestrictions.map(a => a.phone_number));
    }

    // 11. Fix active accounts that have ban_reason but NO valid restriction timer
    // These are edge cases - clear the stale ban_reason to prevent confusion
    const { data: staleReasons, error: staleError } = await supabase
      .from('telegram_accounts')
      .update({ ban_reason: null })
      .eq('status', 'active')
      .not('ban_reason', 'is', null)
      .neq('ban_reason', '')
      .or('restricted_until.is.null,restricted_until.lte.' + nowIso)
      .select('id, phone_number, ban_reason');
    
    if (staleError) {
      console.error('[system-maintenance] Error clearing stale ban_reasons:', staleError);
    } else if (staleReasons && staleReasons.length > 0) {
      console.log(`[system-maintenance] Cleared stale ban_reasons from ${staleReasons.length} active accounts:`,
        staleReasons.map(a => `${a.phone_number}: ${a.ban_reason}`));
    }

    // 12. Delete old conversations and their messages older than 5 days
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    
    // First, get conversation IDs to delete
    const { data: oldConversations, error: oldConvError } = await supabase
      .from('conversations')
      .select('id')
      .lt('last_message_at', fiveDaysAgo);
    
    if (oldConvError) {
      console.error('[system-maintenance] Error fetching old conversations:', oldConvError);
    } else if (oldConversations && oldConversations.length > 0) {
      const convIds = oldConversations.map(c => c.id);
      
      // Delete messages first (foreign key constraint)
      const { data: deletedMessages, error: msgDeleteError } = await supabase
        .from('messages')
        .delete()
        .in('conversation_id', convIds)
        .select('id');
      
      if (msgDeleteError) {
        console.error('[system-maintenance] Error deleting old messages:', msgDeleteError);
      } else {
        stats.old_messages_deleted = deletedMessages?.length || 0;
        console.log(`[system-maintenance] Deleted ${stats.old_messages_deleted} old messages`);
      }
      
      // Now delete conversations
      const { data: deletedConvs, error: convDeleteError } = await supabase
        .from('conversations')
        .delete()
        .in('id', convIds)
        .select('id');
      
      if (convDeleteError) {
        console.error('[system-maintenance] Error deleting old conversations:', convDeleteError);
      } else {
        stats.old_conversations_deleted = deletedConvs?.length || 0;
        console.log(`[system-maintenance] Deleted ${stats.old_conversations_deleted} conversations older than 5 days`);
      }
    }

    // Log summary
    const totalCleaned = 
      stats.daily_counts_reset +
      stats.stuck_messages_reset +
      stats.stale_account_tasks_cancelled +
      stats.stale_block_tasks_cancelled +
      stats.stale_contact_import_tasks_cancelled +
      stats.old_completed_tasks_cleaned +
      stats.old_heartbeats_cleaned +
      stats.old_conversations_deleted +
      stats.old_messages_deleted;

    if (totalCleaned > 0) {
      console.log('[system-maintenance] Maintenance complete:', stats);
    } else {
      console.log('[system-maintenance] No maintenance needed, system is clean');
    }

    return new Response(
      JSON.stringify({
        success: true,
        stats,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    console.error('[system-maintenance] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
