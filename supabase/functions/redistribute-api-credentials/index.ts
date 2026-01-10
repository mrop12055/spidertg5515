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

    console.log('[redistribute-api-credentials] Starting redistribution based on least 24h usage...');

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

    // Get 24h usage for each API from campaign_recipients
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

    console.log('[redistribute-api-credentials] 24h API usage:', Object.fromEntries(apiUsage24h));

    // Fetch ALL active accounts for redistribution (not just unassigned)
    // Exclude accounts with expired/null sessions
    const { data: allAccounts, error: accError } = await supabase
      .from('telegram_accounts')
      .select('id, device_model, status, session_data')
      .in('status', ['active', 'restricted', 'cooldown'])
      .not('session_data', 'is', null);

    if (accError) {
      throw accError;
    }

    if (!allAccounts || allAccounts.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No accounts found to redistribute', assigned: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[redistribute-api-credentials] Found ${allAccounts.length} accounts with valid sessions to redistribute`);

    const API_DAILY_LIMIT = 80; // Max messages per API per 24 hours
    
    // Calculate remaining capacity for each API (limit - usage)
    // APIs with more remaining capacity should get MORE accounts
    const apiCapacity = apiCredentials.map(cred => {
      const usage = apiUsage24h.get(cred.id) || 0;
      const remaining = Math.max(0, API_DAILY_LIMIT - usage);
      return { id: cred.id, name: cred.name, usage, remaining };
    });

    // Sort by remaining capacity DESC (most capacity first)
    apiCapacity.sort((a, b) => b.remaining - a.remaining);
    
    console.log('[redistribute-api-credentials] API capacity (remaining):', 
      apiCapacity.map(c => `${c.name}: ${c.remaining} remaining (${c.usage} used)`));

    // Calculate total remaining capacity
    const totalCapacity = apiCapacity.reduce((sum, c) => sum + c.remaining, 0);
    
    // Reset assignment counts for fresh redistribution
    const assignmentCounts = new Map<string, number>();
    apiCredentials.forEach(c => assignmentCounts.set(c.id, 0));

    const assignments: { id: string; api_credential_id: string }[] = [];

    // Distribute accounts proportionally based on remaining capacity
    // APIs with more remaining capacity get more accounts
    for (let i = 0; i < allAccounts.length; i++) {
      const account = allAccounts[i];
      
      // Find the API with the highest remaining capacity that hasn't been over-assigned
      // Weighted: pick API with best (remaining capacity / assigned ratio)
      let bestApi = apiCapacity[0];
      let bestScore = -1;
      
      for (const api of apiCapacity) {
        const assigned = assignmentCounts.get(api.id) || 0;
        // Score = remaining capacity - already assigned accounts (prefer APIs with more room)
        const score = api.remaining - assigned;
        if (score > bestScore) {
          bestScore = score;
          bestApi = api;
        }
      }

      assignmentCounts.set(bestApi.id, (assignmentCounts.get(bestApi.id) || 0) + 1);
      
      assignments.push({
        id: account.id,
        api_credential_id: bestApi.id
      });
    }

    // Group assignments by API credential for batch updates
    const assignmentsByApi = new Map<string, string[]>();
    for (const assignment of assignments) {
      const existing = assignmentsByApi.get(assignment.api_credential_id) || [];
      existing.push(assignment.id);
      assignmentsByApi.set(assignment.api_credential_id, existing);
    }

    console.log(`[redistribute-api-credentials] Grouped into ${assignmentsByApi.size} API batches`);

    // Build all update functions
    // deno-lint-ignore no-explicit-any
    const updateFns: (() => PromiseLike<any>)[] = [];
    
    // Batch update accounts by API (one query per API instead of one per account)
    for (const [apiId, accountIds] of assignmentsByApi) {
      updateFns.push(() =>
        supabase
          .from('telegram_accounts')
          .update({ api_credential_id: apiId })
          .in('id', accountIds)
      );
    }
    
    // Execute account updates in parallel batches of 20
    const BATCH_SIZE = 20;
    for (let i = 0; i < updateFns.length; i += BATCH_SIZE) {
      const batch = updateFns.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(fn => fn()));
    }
    
    console.log(`[redistribute-api-credentials] Completed ${updateFns.length} account batch updates`);

    // Now update credential counts based on ACTUAL assigned accounts (query DB for accuracy)
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
    
    console.log(`[redistribute-api-credentials] Updated all credential counts from actual assignments`);
    const successCount = assignments.length;

    console.log(`[redistribute-api-credentials] Assigned ${successCount} accounts across ${apiCredentials.length} APIs`);

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
