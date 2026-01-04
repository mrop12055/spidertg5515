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
      stuck_messages_reset: 0,
      stale_account_tasks_cancelled: 0,
      stale_block_tasks_cancelled: 0,
      stale_contact_import_tasks_cancelled: 0,
      old_completed_tasks_cleaned: 0,
      old_heartbeats_cleaned: 0,
    };

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

    // 5. Clean completed tasks older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Clean old completed account_check_tasks
    const { data: oldAccountTasks } = await supabase
      .from('account_check_tasks')
      .delete()
      .in('status', ['completed', 'cancelled', 'failed'])
      .lt('created_at', sevenDaysAgo)
      .select('id');
    
    // Clean old completed block_contact_tasks
    const { data: oldBlockTasks } = await supabase
      .from('block_contact_tasks')
      .delete()
      .in('status', ['completed', 'cancelled', 'failed'])
      .lt('created_at', sevenDaysAgo)
      .select('id');
    
    // Clean old completed contact_import_tasks
    const { data: oldImportTasks } = await supabase
      .from('contact_import_tasks')
      .delete()
      .in('status', ['completed', 'cancelled', 'failed'])
      .lt('created_at', sevenDaysAgo)
      .select('id');

    stats.old_completed_tasks_cleaned = 
      (oldAccountTasks?.length || 0) + 
      (oldBlockTasks?.length || 0) + 
      (oldImportTasks?.length || 0);

    // 6. Clean old runner heartbeats older than 1 day
    const { data: oldHeartbeats } = await supabase
      .from('runner_heartbeats')
      .delete()
      .lt('last_seen', oneDayAgo)
      .select('id');
    
    stats.old_heartbeats_cleaned = oldHeartbeats?.length || 0;

    // 7. Clean old completed warmup_schedule tasks older than 7 days
    await supabase
      .from('warmup_schedule')
      .delete()
      .eq('status', 'completed')
      .lt('completed_at', sevenDaysAgo);

    // 8. Clean old completed interaction_scheduler tasks older than 7 days
    await supabase
      .from('interaction_scheduler')
      .delete()
      .eq('status', 'completed')
      .lt('sent_at', sevenDaysAgo);

    // 9. Clean old completed maturation_tasks older than 7 days
    await supabase
      .from('maturation_tasks')
      .delete()
      .eq('status', 'completed')
      .lt('completed_at', sevenDaysAgo);

    // 10. Fix stuck accounts that are marked "active" but have a ban_reason set
    // These are accounts that got frozen/restricted but somehow reverted to active status
    // EXCLUDE accounts that have a valid future restricted_until (they're legitimately restricted, not stuck)
    // First, get candidates that are active with a ban_reason
    const { data: activeWithBanReason, error: fetchError } = await supabase
      .from('telegram_accounts')
      .select('id, phone_number, ban_reason, restricted_until')
      .eq('status', 'active')
      .not('ban_reason', 'is', null)
      .neq('ban_reason', '');
    
    if (fetchError) {
      console.error('[system-maintenance] Error fetching active accounts with ban_reason:', fetchError);
    } else if (activeWithBanReason && activeWithBanReason.length > 0) {
      const now = new Date();
      // Filter out accounts that have a valid future restricted_until
      const accountsToFreeze = activeWithBanReason.filter(acc => {
        if (!acc.restricted_until) return true; // No restriction date = should be frozen
        const restrictedUntil = new Date(acc.restricted_until);
        return restrictedUntil <= now; // Already expired = should be frozen
      });
      
      if (accountsToFreeze.length > 0) {
        const { data: stuckActiveAccounts, error: stuckAccountsError } = await supabase
          .from('telegram_accounts')
          .update({ status: 'frozen' })
          .in('id', accountsToFreeze.map(a => a.id))
          .select('id, phone_number, ban_reason');
        
        if (stuckAccountsError) {
          console.error('[system-maintenance] Error fixing stuck active accounts:', stuckAccountsError);
        } else if (stuckActiveAccounts && stuckActiveAccounts.length > 0) {
          console.log(`[system-maintenance] Fixed ${stuckActiveAccounts.length} stuck active accounts with ban_reason:`, 
            stuckActiveAccounts.map(a => `${a.phone_number}: ${a.ban_reason}`));
        }
      }
    }
    
    if (stuckAccountsError) {
      console.error('[system-maintenance] Error fixing stuck active accounts:', stuckAccountsError);
    } else if (stuckActiveAccounts && stuckActiveAccounts.length > 0) {
      console.log(`[system-maintenance] Fixed ${stuckActiveAccounts.length} stuck active accounts with ban_reason:`, 
        stuckActiveAccounts.map(a => `${a.phone_number}: ${a.ban_reason}`));
    }

    // Log summary
    const totalCleaned = 
      stats.stuck_messages_reset +
      stats.stale_account_tasks_cancelled +
      stats.stale_block_tasks_cancelled +
      stats.stale_contact_import_tasks_cancelled +
      stats.old_completed_tasks_cleaned +
      stats.old_heartbeats_cleaned;

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
