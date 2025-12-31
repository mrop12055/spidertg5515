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

// Extract user data from Telethon session file
function extractUserDataFromSession(sessionData: string): {
  firstName?: string;
  lastName?: string;
  username?: string;
  telegramId?: number;
  isValid: boolean;
} {
  const result: { firstName?: string; lastName?: string; username?: string; telegramId?: number; isValid: boolean } = { isValid: false };
  
  try {
    const binaryString = atob(sessionData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Check SQLite magic header
    const header = new TextDecoder().decode(bytes.slice(0, 16));
    
    if (header.startsWith('SQLite format 3')) {
      // Valid SQLite session - check size
      result.isValid = bytes.length >= 1000;
      
      // Extract readable content
      const fileContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      
      // Look for username pattern
      const usernameMatch = fileContent.match(/[a-zA-Z][a-zA-Z0-9_]{4,31}/g);
      if (usernameMatch) {
        const filtered = usernameMatch.filter(u => 
          !u.match(/^(sqlite|format|table|create|index|integer|primary|unique|text|blob|null|version|sessions|entities|sent_files|update_state|dc_id|server_address|auth_key|takeout_id|pts|qts|date|seq|unread_count|api_layer)$/i) &&
          u.length >= 5 && u.length <= 32
        );
        if (filtered.length > 0) {
          result.username = filtered[0];
        }
      }

      // Look for name patterns
      const namePattern = /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g;
      const nameMatches = fileContent.match(namePattern);
      if (nameMatches) {
        const validNames = nameMatches.filter(n => 
          n.length >= 2 && n.length <= 64 &&
          !n.match(/^(SQLite|Session|Version|Create|Table|Index|Primary|Integer|Update|Delete|Select|Insert)$/i)
        );
        if (validNames.length > 0) {
          const parts = validNames[0].split(' ');
          result.firstName = parts[0];
          if (parts[1]) result.lastName = parts[1];
        }
      }

      // Look for Telegram ID
      const idPattern = /\b([1-9]\d{6,10})\b/g;
      const idMatches = fileContent.match(idPattern);
      if (idMatches) {
        const validIds = idMatches.filter(id => {
          const num = parseInt(id);
          return num > 1000000 && num < 10000000000;
        });
        if (validIds.length > 0) {
          result.telegramId = parseInt(validIds[0]);
        }
      }
    } else if (sessionData.length > 200) {
      // Might be a Pyrogram string session
      result.isValid = true;
    }
  } catch (e) {
    console.error('Error extracting user data:', e);
  }
  
  return result;
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

        // Extract and verify session data immediately
        const extracted = extractUserDataFromSession(account.session_data);
        const status = extracted.isValid ? 'active' : 'disconnected';
        
        console.log(`[process-account-upload] ${account.phone_number}: valid=${extracted.isValid}, username=${extracted.username}, firstName=${extracted.firstName}`);

        // Check if account already exists
        const { data: existing } = await supabase
          .from('telegram_accounts')
          .select('id')
          .eq('phone_number', account.phone_number)
          .single();

        const accountData = {
          session_data: account.session_data,
          first_name: extracted.firstName || account.first_name || null,
          last_name: extracted.lastName || account.last_name || null,
          username: extracted.username || account.username || null,
          telegram_id: extracted.telegramId || null,
          api_id: account.api_id,
          api_hash: account.api_hash,
          status: status,
          last_active: extracted.isValid ? new Date().toISOString() : null,
        };

        if (existing) {
          // Update existing account
          const { data, error } = await supabase
            .from('telegram_accounts')
            .update(accountData)
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
              ...accountData,
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
