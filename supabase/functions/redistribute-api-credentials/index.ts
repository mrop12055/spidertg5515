import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('[redistribute-api-credentials] Starting redistribution...');

    // Fetch all API credentials
    const { data: apiCredentials, error: credError } = await supabase
      .from('telegram_api_credentials')
      .select('*')
      .eq('is_active', true);

    if (credError || !apiCredentials || apiCredentials.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No API credentials found' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[redistribute-api-credentials] Found ${apiCredentials.length} API credentials`);

    // Fetch all accounts without API credential assignment
    const { data: unassignedAccounts, error: accError } = await supabase
      .from('telegram_accounts')
      .select('id, device_model')
      .is('api_credential_id', null);

    if (accError) {
      throw accError;
    }

    if (!unassignedAccounts || unassignedAccounts.length === 0) {
      return new Response(
        JSON.stringify({ message: 'All accounts already have API credentials assigned', assigned: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[redistribute-api-credentials] Found ${unassignedAccounts.length} accounts to assign`);

    // Group credentials by type for matching
    const androidCreds = apiCredentials.filter(c => c.client_type === 'android' || c.client_type === 'desktop');
    const iosCreds = apiCredentials.filter(c => c.client_type === 'ios' || c.client_type === 'macos');

    // Track assignments per credential for load balancing
    const assignmentCounts = new Map<string, number>();
    apiCredentials.forEach(c => assignmentCounts.set(c.id, c.accounts_count || 0));

    const assignments: { id: string; api_credential_id: string }[] = [];

    for (const account of unassignedAccounts) {
      // Determine if this is an iOS device
      const isIos = account.device_model?.toLowerCase().includes('iphone') || false;
      
      // Select matching credentials pool
      let pool = isIos && iosCreds.length > 0 ? iosCreds : 
                 !isIos && androidCreds.length > 0 ? androidCreds : 
                 apiCredentials;

      // Find credential with lowest count (load balancing)
      let minCount = Infinity;
      let selectedCred = pool[0];
      
      for (const cred of pool) {
        const count = assignmentCounts.get(cred.id) || 0;
        if (count < minCount) {
          minCount = count;
          selectedCred = cred;
        }
      }

      // Increment count for selected credential
      assignmentCounts.set(selectedCred.id, (assignmentCounts.get(selectedCred.id) || 0) + 1);
      
      assignments.push({
        id: account.id,
        api_credential_id: selectedCred.id
      });
    }

    // Batch update accounts
    let successCount = 0;
    for (const assignment of assignments) {
      const { error } = await supabase
        .from('telegram_accounts')
        .update({ api_credential_id: assignment.api_credential_id })
        .eq('id', assignment.id);
      
      if (!error) successCount++;
    }

    // Update credential counts
    for (const cred of apiCredentials) {
      const newCount = assignmentCounts.get(cred.id) || 0;
      await supabase
        .from('telegram_api_credentials')
        .update({ accounts_count: newCount })
        .eq('id', cred.id);
    }

    console.log(`[redistribute-api-credentials] Assigned ${successCount}/${assignments.length} accounts`);

    // Fetch final distribution
    const { data: finalDist } = await supabase
      .from('telegram_api_credentials')
      .select('name, client_type, accounts_count')
      .eq('is_active', true);

    return new Response(
      JSON.stringify({ 
        success: true,
        assigned: successCount,
        distribution: finalDist
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const error = err as Error;
    console.error('[redistribute-api-credentials] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
