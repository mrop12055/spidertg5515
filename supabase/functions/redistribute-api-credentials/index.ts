import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// STRICT LIMIT: Maximum 1 account per API credential
const MAX_ACCOUNTS_PER_API = 1;

// Batch size for parallel operations (50 at a time)
const BATCH_SIZE = 50;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('[redistribute-api-credentials] Starting SAFE redistribution (preserving existing 1:1 mappings)...');

    // Fetch all active API credentials
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

    // Fetch accounts that ALREADY have API credentials assigned (DO NOT TOUCH THESE)
    const { data: assignedAccounts, error: assignedError } = await supabase
      .from('telegram_accounts')
      .select('id, api_credential_id')
      .in('status', ['active', 'restricted', 'cooldown'])
      .not('session_data', 'is', null)
      .not('api_credential_id', 'is', null);

    if (assignedError) {
      throw assignedError;
    }

    // Build set of already-used API credentials
    const usedApiIds = new Set<string>();
    (assignedAccounts || []).forEach(acc => {
      if (acc.api_credential_id) {
        usedApiIds.add(acc.api_credential_id);
      }
    });

    console.log(`[redistribute-api-credentials] ${assignedAccounts?.length || 0} accounts already have API credentials (preserving these)`);
    console.log(`[redistribute-api-credentials] ${usedApiIds.size} API credentials are in use`);

    // Fetch accounts WITHOUT API credentials (ONLY THESE WILL BE ASSIGNED)
    const { data: unassignedAccounts, error: unassignedError } = await supabase
      .from('telegram_accounts')
      .select('id, phone_number, status, session_data')
      .in('status', ['active', 'restricted', 'cooldown'])
      .not('session_data', 'is', null)
      .is('api_credential_id', null)
      .order('created_at', { ascending: true }); // Oldest accounts get priority

    if (unassignedError) {
      throw unassignedError;
    }

    if (!unassignedAccounts || unassignedAccounts.length === 0) {
      // Update counts for all APIs
      await updateAllApiCounts(supabase, apiCredentials);
      
      return new Response(
        JSON.stringify({ 
          message: 'All accounts already have API credentials assigned', 
          assigned: 0,
          alreadyAssigned: assignedAccounts?.length || 0,
          unassigned: 0
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[redistribute-api-credentials] Found ${unassignedAccounts.length} accounts WITHOUT API credentials`);

    // Get available APIs (not yet assigned to any account)
    const availableApis = apiCredentials.filter(api => !usedApiIds.has(api.id));
    
    console.log(`[redistribute-api-credentials] ${availableApis.length} API credentials are available for assignment`);

    if (availableApis.length === 0) {
      // Update counts for all APIs
      await updateAllApiCounts(supabase, apiCredentials);
      
      return new Response(
        JSON.stringify({ 
          message: `No available API credentials. All ${apiCredentials.length} APIs are already assigned.`,
          assigned: 0,
          alreadyAssigned: assignedAccounts?.length || 0,
          unassigned: unassignedAccounts.length,
          needMoreApis: unassignedAccounts.length
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get 24h usage for available APIs to prioritize low-usage APIs
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    
    const { data: recipientsData } = await supabase
      .from('campaign_recipients')
      .select('api_credential_id')
      .in('status', ['sent', 'failed'])
      .not('api_credential_id', 'is', null)
      .gte('sent_at', yesterday.toISOString());

    // Count 24h usage per API
    const apiUsage24h = new Map<string, number>();
    availableApis.forEach(c => apiUsage24h.set(c.id, 0));
    (recipientsData || []).forEach((rec: any) => {
      if (rec.api_credential_id && apiUsage24h.has(rec.api_credential_id)) {
        apiUsage24h.set(rec.api_credential_id, (apiUsage24h.get(rec.api_credential_id) || 0) + 1);
      }
    });

    // Sort available APIs by 24h usage (lowest first - these get accounts first)
    const sortedApis = [...availableApis].sort((a, b) => {
      const usageA = apiUsage24h.get(a.id) || 0;
      const usageB = apiUsage24h.get(b.id) || 0;
      return usageA - usageB; // Lowest usage first
    });

    console.log('[redistribute-api-credentials] Available APIs sorted by 24h usage:', 
      sortedApis.map(api => `${api.name}: ${apiUsage24h.get(api.id) || 0} used`));

    // Build assignments (1 account per available API)
    const assignments: { accountId: string; apiId: string; phone: string }[] = [];
    const stillUnassigned: string[] = [];

    for (let i = 0; i < unassignedAccounts.length; i++) {
      const account = unassignedAccounts[i];
      
      if (i < sortedApis.length) {
        // There's an available API for this account
        assignments.push({
          accountId: account.id,
          apiId: sortedApis[i].id,
          phone: account.phone_number
        });
      } else {
        // No more APIs available
        stillUnassigned.push(account.id);
      }
    }

    console.log(`[redistribute-api-credentials] Will assign ${assignments.length} accounts, ${stillUnassigned.length} will remain unassigned`);

    // Assign accounts to APIs in PARALLEL BATCHES
    console.log(`[redistribute-api-credentials] Assigning ${assignments.length} accounts in parallel batches of ${BATCH_SIZE}...`);
    
    for (let i = 0; i < assignments.length; i += BATCH_SIZE) {
      const batch = assignments.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(assignments.length / BATCH_SIZE);
      
      console.log(`[redistribute-api-credentials] Processing batch ${batchNum}/${totalBatches} (${batch.length} accounts)`);
      
      // Process entire batch in parallel
      await Promise.all(
        batch.map(assignment => 
          supabase
            .from('telegram_accounts')
            .update({ api_credential_id: assignment.apiId })
            .eq('id', assignment.accountId)
        )
      );
    }

    console.log(`[redistribute-api-credentials] Completed all account assignments`);

    // Update all API credential counts
    await updateAllApiCounts(supabase, apiCredentials);

    // Fetch final distribution
    const { data: finalDist } = await supabase
      .from('telegram_api_credentials')
      .select('name, client_type, accounts_count')
      .eq('is_active', true)
      .order('accounts_count', { ascending: false });

    // Summary message
    let message = `✅ Assigned ${assignments.length} accounts to APIs`;
    if (stillUnassigned.length > 0) {
      message += `. ⚠️ ${stillUnassigned.length} accounts still need APIs - add ${stillUnassigned.length} more API credentials!`;
    }

    return new Response(
      JSON.stringify({ 
        success: true,
        assigned: assignments.length,
        alreadyAssigned: assignedAccounts?.length || 0,
        unassigned: stillUnassigned.length,
        maxPerApi: MAX_ACCOUNTS_PER_API,
        message,
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

// Helper function to update all API credential counts
async function updateAllApiCounts(supabase: any, apiCredentials: any[]) {
  console.log(`[redistribute-api-credentials] Updating ${apiCredentials.length} API credential counts...`);
  
  for (let i = 0; i < apiCredentials.length; i += BATCH_SIZE) {
    const batch = apiCredentials.slice(i, i + BATCH_SIZE);
    
    await Promise.all(
      batch.map(async (cred) => {
        const { count } = await supabase
          .from('telegram_accounts')
          .select('*', { count: 'exact', head: true })
          .eq('api_credential_id', cred.id);
        
        await supabase
          .from('telegram_api_credentials')
          .update({ accounts_count: count || 0 })
          .eq('id', cred.id);
      })
    );
  }
  
  console.log(`[redistribute-api-credentials] Updated all credential counts`);
}
