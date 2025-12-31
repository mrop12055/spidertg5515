import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface AccountData {
  phone_number: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  session_data: string;
  api_id?: string;
  api_hash?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    
    const accounts: AccountData[] = body.accounts || [];
    
    if (!accounts.length) {
      return new Response(
        JSON.stringify({ error: 'No accounts provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-account-upload] Processing ${accounts.length} accounts`);

    const results = {
      successful: 0,
      failed: 0,
      errors: [] as string[],
      accounts: [] as any[]
    };

    for (const account of accounts) {
      try {
        // Validate required fields
        if (!account.phone_number || !account.session_data) {
          results.failed++;
          results.errors.push(`${account.phone_number || 'Unknown'}: Missing required fields`);
          continue;
        }

        // Check if account already exists
        const { data: existing } = await supabase
          .from('telegram_accounts')
          .select('id')
          .eq('phone_number', account.phone_number)
          .single();

        if (existing) {
          // Update existing account
          const { data, error } = await supabase
            .from('telegram_accounts')
            .update({
              session_data: account.session_data,
              first_name: account.first_name,
              last_name: account.last_name,
              username: account.username,
              api_id: account.api_id,
              api_hash: account.api_hash,
              status: 'active',
            })
            .eq('id', existing.id)
            .select()
            .single();

          if (error) throw error;
          results.successful++;
          results.accounts.push(data);
        } else {
          // Insert new account
          const { data, error } = await supabase
            .from('telegram_accounts')
            .insert({
              phone_number: account.phone_number,
              session_data: account.session_data,
              first_name: account.first_name,
              last_name: account.last_name,
              username: account.username,
              api_id: account.api_id,
              api_hash: account.api_hash,
              status: 'active',
              maturity_score: 0,
              maturity_days: 0,
              daily_limit: 25,
              messages_sent_today: 0,
            })
            .select()
            .single();

          if (error) throw error;
          results.successful++;
          results.accounts.push(data);
        }
      } catch (err) {
        const error = err as Error;
        console.error(`[process-account-upload] Error processing ${account.phone_number}:`, error.message);
        results.failed++;
        results.errors.push(`${account.phone_number}: ${error.message}`);
      }
    }

    console.log(`[process-account-upload] Completed: ${results.successful} successful, ${results.failed} failed`);

    return new Response(
      JSON.stringify(results),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const error = err as Error;
    console.error('[process-account-upload] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
