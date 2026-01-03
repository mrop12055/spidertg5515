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

    console.log('[auto-verify-accounts] Starting automatic account verification...');

    // Get all active accounts to verify
    const { data: accounts, error: accountsError } = await supabase
      .from('telegram_accounts')
      .select('id, phone_number, status')
      .eq('status', 'active')
      .limit(100); // Process in batches to avoid overload

    if (accountsError) {
      console.error('[auto-verify-accounts] Error fetching accounts:', accountsError);
      throw accountsError;
    }

    if (!accounts || accounts.length === 0) {
      console.log('[auto-verify-accounts] No accounts need verification');
      return new Response(
        JSON.stringify({ success: true, message: 'No accounts need verification', queued: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check for existing pending verify_session tasks to avoid duplicates
    const accountIds = accounts.map(a => a.id);
    const { data: existingTasks } = await supabase
      .from('account_check_tasks')
      .select('account_id')
      .eq('task_type', 'verify_session')
      .eq('status', 'pending')
      .in('account_id', accountIds);

    const existingAccountIds = new Set(existingTasks?.map(t => t.account_id) || []);
    const accountsToVerify = accounts.filter(a => !existingAccountIds.has(a.id));

    if (accountsToVerify.length === 0) {
      console.log('[auto-verify-accounts] All accounts already have pending verification tasks');
      return new Response(
        JSON.stringify({ success: true, message: 'Verification already pending', queued: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Queue verify_session tasks for accounts that need verification
    const tasks = accountsToVerify.map(account => ({
      account_id: account.id,
      task_type: 'verify_session',
      status: 'pending',
    }));

    const { error: insertError } = await supabase
      .from('account_check_tasks')
      .insert(tasks);

    if (insertError) {
      console.error('[auto-verify-accounts] Error queuing tasks:', insertError);
      throw insertError;
    }

    console.log(`[auto-verify-accounts] Queued ${tasks.length} verification tasks for accounts:`, 
      accountsToVerify.map(a => a.phone_number));

    return new Response(
      JSON.stringify({
        success: true,
        message: `Queued ${tasks.length} account verifications`,
        queued: tasks.length,
        accounts: accountsToVerify.map(a => a.phone_number),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('[auto-verify-accounts] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
