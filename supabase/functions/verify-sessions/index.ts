import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Note: User data extraction from session files is unreliable due to SQLite structure
// Profile data (name, username) should be fetched via Python runner using client.get_me()
// This function only validates the session file format, not the actual Telegram connection

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { account_ids } = await req.json();

    if (!account_ids || !Array.isArray(account_ids)) {
      return new Response(
        JSON.stringify({ error: 'account_ids array required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Verifying ${account_ids.length} accounts...`);

    // Fetch accounts with session data
    const { data: accounts, error: fetchError } = await supabase
      .from('telegram_accounts')
      .select('id, phone_number, session_data, status')
      .in('id', account_ids);

    if (fetchError) {
      console.error('Error fetching accounts:', fetchError);
      throw fetchError;
    }

    const results: { id: string; status: 'active' | 'disconnected' | 'banned'; reason: string }[] = [];

    for (const account of accounts || []) {
      let newStatus: 'active' | 'disconnected' | 'banned' = 'disconnected';
      let reason = 'No session data';

      if (account.session_data) {
        try {
          // Decode base64 to check if it's a valid SQLite database
          const binaryString = atob(account.session_data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          // Check SQLite magic header: "SQLite format 3\0"
          const header = new TextDecoder().decode(bytes.slice(0, 16));
          
          if (header.startsWith('SQLite format 3')) {
            // Valid SQLite session file
            // Check file size - Telethon sessions are usually 20KB+
            if (bytes.length >= 10000) {
              newStatus = 'active';
              reason = 'Valid Telethon session';
            } else if (bytes.length >= 1000) {
              newStatus = 'active';
              reason = 'Valid session (small)';
            } else {
              newStatus = 'disconnected';
              reason = 'Session file too small';
            }
          } else if (account.session_data.length > 200) {
            // Could be a Pyrogram string session or other format
            newStatus = 'active';
            reason = 'String session detected';
          } else {
            newStatus = 'disconnected';
            reason = 'Invalid session format';
          }
        } catch (e) {
          console.error(`Error validating session for ${account.phone_number}:`, e);
          newStatus = 'disconnected';
          reason = 'Failed to parse session';
        }
      }

      results.push({ 
        id: account.id, 
        status: newStatus, 
        reason
      });

      // Only update status - profile data should be fetched via Python runner
      const updateData: Record<string, unknown> = { 
        status: newStatus,
        last_active: newStatus === 'active' ? new Date().toISOString() : null
      };

      // Update account in database
      const { error: updateError } = await supabase
        .from('telegram_accounts')
        .update(updateData)
        .eq('id', account.id);

      if (updateError) {
        console.error(`Error updating account ${account.id}:`, updateError);
      }
    }

    const validCount = results.filter(r => r.status === 'active').length;
    const invalidCount = results.filter(r => r.status !== 'active').length;

    console.log(`Verification complete: ${validCount} valid, ${invalidCount} invalid`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        results,
        summary: { valid: validCount, invalid: invalidCount }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in verify-sessions:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
