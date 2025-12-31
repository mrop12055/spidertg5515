import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Extract user data from Telethon session file content
function extractUserDataFromSession(fileContent: string, bytes: Uint8Array): {
  firstName?: string;
  lastName?: string;
  username?: string;
  telegramId?: string;
} {
  const result: { firstName?: string; lastName?: string; username?: string; telegramId?: string } = {};
  
  try {
    // Telethon stores session data in SQLite tables
    // The 'sessions' table contains: dc_id, server_address, port, auth_key
    // The 'entities' table contains cached user/chat data
    // The 'self' info is often stored with the session
    
    // Look for username pattern - usernames are ASCII and appear as @username or just username
    const usernameMatch = fileContent.match(/[a-zA-Z][a-zA-Z0-9_]{4,31}/g);
    if (usernameMatch) {
      // Filter out common false positives
      const filtered = usernameMatch.filter(u => 
        !u.match(/^(sqlite|format|table|create|index|integer|primary|unique|text|blob|null|version|sessions|entities|sent_files|update_state|dc_id|server_address|auth_key|takeout_id|pts|qts|date|seq|unread_count|api_layer)$/i) &&
        u.length >= 5 && u.length <= 32
      );
      if (filtered.length > 0) {
        result.username = filtered[0];
      }
    }

    // Look for readable name strings - these are UTF-8 encoded in the SQLite blob
    // Names are usually stored after specific byte patterns
    // Try to find sequences of readable characters that look like names
    
    // Search for name-like patterns (capitalized words)
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
        if (parts[1]) {
          result.lastName = parts[1];
        }
      }
    }

    // Try to extract Telegram ID - it's stored as a 64-bit integer
    // Look for large numbers that could be Telegram IDs (usually 7-10 digits)
    const idPattern = /\b([1-9]\d{6,10})\b/g;
    const idMatches = fileContent.match(idPattern);
    if (idMatches) {
      // Telegram IDs are typically in the billions now for newer accounts
      const validIds = idMatches.filter(id => {
        const num = parseInt(id);
        return num > 1000000 && num < 10000000000;
      });
      if (validIds.length > 0) {
        result.telegramId = validIds[0];
      }
    }

  } catch (e) {
    console.error('Error extracting user data:', e);
  }
  
  return result;
}

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

    const results: { id: string; status: 'active' | 'disconnected' | 'banned'; reason: string; firstName?: string; lastName?: string; username?: string }[] = [];

    for (const account of accounts || []) {
      let newStatus: 'active' | 'disconnected' | 'banned' = 'disconnected';
      let reason = 'No session data';
      let extractedData: { firstName?: string; lastName?: string; username?: string; telegramId?: string } = {};

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

            // Try to extract user data from session file
            // Telethon stores user data as readable strings in the SQLite file
            const fileContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            
            // Look for self user data patterns in the session
            // Telethon sessions contain the logged-in user's info
            extractedData = extractUserDataFromSession(fileContent, bytes);
            
            if (extractedData.firstName || extractedData.username) {
              console.log(`Extracted data for ${account.phone_number}:`, extractedData);
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
        reason,
        firstName: extractedData.firstName,
        lastName: extractedData.lastName,
        username: extractedData.username
      });

      // Build update object with status and extracted data
      const updateData: Record<string, unknown> = { 
        status: newStatus,
        last_active: newStatus === 'active' ? new Date().toISOString() : null
      };

      // Add extracted data if available
      if (extractedData.firstName) {
        updateData.first_name = extractedData.firstName;
      }
      if (extractedData.lastName) {
        updateData.last_name = extractedData.lastName;
      }
      if (extractedData.username) {
        updateData.username = extractedData.username;
      }
      if (extractedData.telegramId) {
        updateData.telegram_id = parseInt(extractedData.telegramId);
      }

      // Update account in database
      const { error: updateError } = await supabase
        .from('telegram_accounts')
        .update(updateData)
        .eq('id', account.id);

      if (updateError) {
        console.error(`Error updating account ${account.id}:`, updateError);
      } else if (extractedData.firstName || extractedData.username) {
        console.log(`Updated account ${account.phone_number} with extracted data`);
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
