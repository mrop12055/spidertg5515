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

    // Sort APIs by 24h usage (least used first) for assignment
    const sortedCredentials = [...apiCredentials].sort((a, b) => {
      const usageA = apiUsage24h.get(a.id) || 0;
      const usageB = apiUsage24h.get(b.id) || 0;
      return usageA - usageB; // Least used first
    });

    // Reset assignment counts for fresh redistribution
    const assignmentCounts = new Map<string, number>();
    apiCredentials.forEach(c => assignmentCounts.set(c.id, 0));

    const assignments: { id: string; api_credential_id: string }[] = [];

    // Distribute accounts evenly across all credentials, preferring least-used APIs
    for (let i = 0; i < allAccounts.length; i++) {
      const account = allAccounts[i];
      
      // Round-robin through sorted credentials (least used get accounts first)
      const credIndex = i % sortedCredentials.length;
      const selectedCred = sortedCredentials[credIndex];

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
