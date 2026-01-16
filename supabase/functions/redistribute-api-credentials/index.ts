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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('[redistribute-api-credentials] Starting 1:1 redistribution (max 1 account per API)...');

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

    // Fetch ALL active accounts with valid sessions
    const { data: allAccounts, error: accError } = await supabase
      .from('telegram_accounts')
      .select('id, phone_number, status, session_data, api_credential_id')
      .in('status', ['active', 'restricted', 'cooldown'])
      .not('session_data', 'is', null)
      .order('created_at', { ascending: true }); // Oldest accounts get priority

    if (accError) {
      throw accError;
    }

    if (!allAccounts || allAccounts.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No accounts found to redistribute', assigned: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[redistribute-api-credentials] Found ${allAccounts.length} accounts with valid sessions`);

    // Get 24h usage for each API to prioritize low-usage APIs
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
    apiCredentials.forEach(c => apiUsage24h.set(c.id, 0));
    (recipientsData || []).forEach((rec: any) => {
      if (rec.api_credential_id) {
        apiUsage24h.set(rec.api_credential_id, (apiUsage24h.get(rec.api_credential_id) || 0) + 1);
      }
    });

    // Sort APIs by 24h usage (lowest first - these get accounts first)
    const sortedApis = [...apiCredentials].sort((a, b) => {
      const usageA = apiUsage24h.get(a.id) || 0;
      const usageB = apiUsage24h.get(b.id) || 0;
      return usageA - usageB; // Lowest usage first
    });

    console.log('[redistribute-api-credentials] APIs sorted by 24h usage:', 
      sortedApis.map(api => `${api.name}: ${apiUsage24h.get(api.id) || 0} used`));

    // Track which APIs have been assigned (1:1 limit)
    const assignedApis = new Set<string>();
    const assignments: { accountId: string; apiId: string }[] = [];
    const unassignedAccounts: string[] = [];

    // Assign 1 account per API (round-robin with 1:1 limit)
    for (let i = 0; i < allAccounts.length; i++) {
      const account = allAccounts[i];
      
      // Find the first available API that hasn't been assigned yet
      let assignedApi: typeof sortedApis[0] | null = null;
      
      for (const api of sortedApis) {
        if (!assignedApis.has(api.id)) {
          assignedApi = api;
          assignedApis.add(api.id);
          break;
        }
      }

      if (assignedApi) {
        assignments.push({
          accountId: account.id,
          apiId: assignedApi.id
        });
      } else {
        // No more APIs available - account goes unassigned
        unassignedAccounts.push(account.id);
      }
    }

    console.log(`[redistribute-api-credentials] Assignments: ${assignments.length} accounts to APIs, ${unassignedAccounts.length} unassigned (exceeded API count)`);

    // STEP 1: First, unassign ALL accounts (clean slate)
    await supabase
      .from('telegram_accounts')
      .update({ api_credential_id: null })
      .in('status', ['active', 'restricted', 'cooldown']);

    // STEP 2: Assign accounts to APIs (1:1)
    for (const assignment of assignments) {
      await supabase
        .from('telegram_accounts')
        .update({ api_credential_id: assignment.apiId })
        .eq('id', assignment.accountId);
    }

    console.log(`[redistribute-api-credentials] Completed ${assignments.length} account assignments`);

    // STEP 3: Update credential counts based on ACTUAL assigned accounts
    for (const cred of apiCredentials) {
      const { count } = await supabase
        .from('telegram_accounts')
        .select('*', { count: 'exact', head: true })
        .eq('api_credential_id', cred.id);
      
      await supabase
        .from('telegram_api_credentials')
        .update({ accounts_count: count || 0 })
        .eq('id', cred.id);
    }
    
    console.log(`[redistribute-api-credentials] Updated all credential counts (should be 0 or 1)`);

    // Fetch final distribution
    const { data: finalDist } = await supabase
      .from('telegram_api_credentials')
      .select('name, client_type, accounts_count')
      .eq('is_active', true)
      .order('accounts_count', { ascending: false });

    // Warn if there are unassigned accounts
    if (unassignedAccounts.length > 0) {
      console.warn(`[redistribute-api-credentials] WARNING: ${unassignedAccounts.length} accounts are UNASSIGNED because there aren't enough APIs. Need ${unassignedAccounts.length} more API credentials!`);
    }

    return new Response(
      JSON.stringify({ 
        success: true,
        assigned: assignments.length,
        unassigned: unassignedAccounts.length,
        maxPerApi: MAX_ACCOUNTS_PER_API,
        message: unassignedAccounts.length > 0 
          ? `⚠️ ${unassignedAccounts.length} accounts have NO API assigned. Add ${unassignedAccounts.length} more API credentials!`
          : `All ${assignments.length} accounts assigned (1:1 limit enforced)`,
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
