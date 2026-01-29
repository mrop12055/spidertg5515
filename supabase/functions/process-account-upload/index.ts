import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Account upload processor - Per-Account System (JSON + Session)
 * 
 * BUILD: 2026-01-29-per-account-v2
 * 
 * ARCHITECTURE: Each account brings its own identity from JSON metadata:
 * - api_id & api_hash (per-account API credentials)
 * - device_model, system_version, app_version (device fingerprint)
 * - lang_code, system_lang_code (language settings)
 * - twoFA (2FA password if enabled)
 * 
 * This eliminates the need for:
 * - Shared API credential pools
 * - Fingerprint generation code
 * - API assignment logic
 */

interface AccountData {
  phone_number: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  session_data: string;
  // Per-account API credentials from JSON metadata
  api_id?: string;
  api_hash?: string;
  // Device fingerprint from JSON metadata
  device_model?: string;
  system_version?: string;
  app_version?: string;
  lang_code?: string;
  system_lang_code?: string;
  // 2FA password from JSON metadata
  two_fa_password?: string;
}

// Extract country code from phone number
function extractPhoneCountry(phoneNumber: string): string | null {
  const cleaned = phoneNumber.replace(/\D/g, '');
  
  // Common country code prefixes
  const countryPrefixes: Record<string, string> = {
    '1': 'US', '7': 'RU', '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL',
    '32': 'BE', '33': 'FR', '34': 'ES', '36': 'HU', '39': 'IT', '40': 'RO',
    '41': 'CH', '43': 'AT', '44': 'GB', '45': 'DK', '46': 'SE', '47': 'NO',
    '48': 'PL', '49': 'DE', '51': 'PE', '52': 'MX', '53': 'CU', '54': 'AR',
    '55': 'BR', '56': 'CL', '57': 'CO', '58': 'VE', '60': 'MY', '61': 'AU',
    '62': 'ID', '63': 'PH', '64': 'NZ', '65': 'SG', '66': 'TH', '81': 'JP',
    '82': 'KR', '84': 'VN', '86': 'CN', '90': 'TR', '91': 'IN', '92': 'PK',
    '93': 'AF', '94': 'LK', '95': 'MM', '98': 'IR', '212': 'MA', '213': 'DZ',
    '216': 'TN', '218': 'LY', '220': 'GM', '221': 'SN', '234': 'NG', '249': 'SD',
    '254': 'KE', '255': 'TZ', '256': 'UG', '260': 'ZM', '263': 'ZW', '351': 'PT',
    '352': 'LU', '353': 'IE', '354': 'IS', '358': 'FI', '359': 'BG', '370': 'LT',
    '371': 'LV', '372': 'EE', '373': 'MD', '374': 'AM', '375': 'BY', '380': 'UA',
    '381': 'RS', '385': 'HR', '386': 'SI', '387': 'BA', '389': 'MK', '420': 'CZ',
    '421': 'SK', '502': 'GT', '503': 'SV', '504': 'HN', '505': 'NI', '506': 'CR',
    '507': 'PA', '509': 'HT', '590': 'GP', '591': 'BO', '593': 'EC', '594': 'GF',
    '595': 'PY', '597': 'SR', '598': 'UY', '599': 'CW', '852': 'HK', '853': 'MO',
    '855': 'KH', '856': 'LA', '880': 'BD', '886': 'TW', '960': 'MV', '961': 'LB',
    '962': 'JO', '963': 'SY', '964': 'IQ', '965': 'KW', '966': 'SA', '967': 'YE',
    '968': 'OM', '971': 'AE', '972': 'IL', '973': 'BH', '974': 'QA', '976': 'MN',
    '977': 'NP', '992': 'TJ', '993': 'TM', '994': 'AZ', '995': 'GE', '996': 'KG',
    '998': 'UZ',
  };
  
  // Try 3-digit, then 2-digit, then 1-digit prefixes
  for (const len of [3, 2, 1]) {
    const prefix = cleaned.substring(0, len);
    if (countryPrefixes[prefix]) {
      return countryPrefixes[prefix];
    }
  }
  
  return null;
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
      
      // DO NOT try to extract username/names from SQLite binary data
      // The session file contains encrypted/binary data that looks like random text
      // The username/names should come from the uploaded file metadata, not session extraction
      
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
    const tags: string[] = body.tags || []; // Accept tags from request
    
    if (!accounts.length) {
      return new Response(
        JSON.stringify({ error: 'No accounts provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[process-account-upload] Processing ${accounts.length} accounts`);

    // Per-account system: API credentials and fingerprints come from JSON metadata
    // No pool assignment or fingerprint generation needed
    console.log(`[process-account-upload] Using per-account credentials (from JSON metadata)`);

    // Fetch available unassigned proxies for auto-assignment (1:1 policy)
    const { data: availableProxies } = await supabase
      .from('proxies')
      .select('id')
      .eq('status', 'active')
      .is('assigned_account_id', null)
      .order('created_at', { ascending: true });
    
    const proxyQueue = [...(availableProxies || [])];
    console.log(`[process-account-upload] Found ${proxyQueue.length} available proxies for auto-assignment`);

    const results = {
      successful: 0,
      failed: 0,
      errors: [] as string[],
      accounts: [] as any[],
      account_ids: [] as string[],
      proxies_assigned: 0,
      proxies_unavailable: 0,
      // Metadata stats for enhanced feedback
      metadata_stats: {
        with_json_api: 0,
        with_json_fingerprint: 0,
        missing_fingerprint: 0, // Accounts without JSON fingerprint
        with_2fa: 0,
      },
    };

    // Fetch all existing accounts in one query for faster lookup
    const phoneNumbers = accounts.map(a => a.phone_number).filter(Boolean);
    const { data: existingAccountsList } = await supabase
      .from('telegram_accounts')
      .select('id, phone_number, device_model, status, proxy_id')
      .in('phone_number', phoneNumbers);
    
    const existingAccountsMap = new Map<string, { id: string; device_model: string | null; status: string; proxy_id: string | null }>();
    existingAccountsList?.forEach(acc => {
      existingAccountsMap.set(acc.phone_number, { id: acc.id, device_model: acc.device_model, status: acc.status || 'disconnected', proxy_id: acc.proxy_id });
    });

    console.log(`[process-account-upload] Found ${existingAccountsMap.size} existing accounts out of ${accounts.length}`);

    // Prepare batch data
    const accountsToInsert: any[] = [];
    const accountsToUpdate: { id: string; data: any }[] = [];
    const proxyAssignments: { accountId: string; proxyId: string }[] = [];

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
        
        // Extract phone country
        const phoneCountry = extractPhoneCountry(account.phone_number);
        
        // Check if account already exists
        const existing = existingAccountsMap.get(account.phone_number);

        // Track metadata presence
        const hasJsonFingerprint = !!(account.device_model && account.system_version);
        const hasJsonApi = !!(account.api_id && account.api_hash);
        const has2fa = !!account.two_fa_password;
        
        if (hasJsonApi) results.metadata_stats.with_json_api++;
        if (hasJsonFingerprint) results.metadata_stats.with_json_fingerprint++;
        else results.metadata_stats.missing_fingerprint++;
        if (has2fa) results.metadata_stats.with_2fa++;

        // Determine the status - PRESERVE existing status for restricted/banned/frozen accounts
        let finalStatus: string;
        if (existing) {
          const preserveStatuses = ['banned', 'restricted', 'frozen', 'cooldown'];
          if (preserveStatuses.includes(existing.status)) {
            finalStatus = existing.status;
          } else if (existing.status === 'disconnected' && extracted.isValid) {
            finalStatus = 'active';
          } else {
            finalStatus = existing.status;
          }
        } else {
          finalStatus = extracted.isValid ? 'active' : 'disconnected';
        }

        // Log fingerprint and API credential status
        if (hasJsonFingerprint) {
          console.log(`[process-account-upload] ${account.phone_number}: JSON fingerprint (${account.device_model} | ${account.system_version})`);
        } else {
          console.log(`[process-account-upload] ${account.phone_number}: ⚠️ NO FINGERPRINT in JSON - account may have issues`);
        }
        
        if (hasJsonApi) {
          console.log(`[process-account-upload] ${account.phone_number}: Per-account API (${account.api_id})`);
        } else {
          console.log(`[process-account-upload] ${account.phone_number}: ⚠️ NO API credentials - will use pool fallback`);
        }
        
        if (has2fa) {
          console.log(`[process-account-upload] ${account.phone_number}: 2FA password stored`);
        }

        const accountData = {
          session_data: account.session_data,
          first_name: extracted.firstName || account.first_name || null,
          last_name: extracted.lastName || account.last_name || null,
          username: extracted.username || account.username || null,
          telegram_id: extracted.telegramId || null,
          // Per-account API credentials from JSON (ALWAYS update if provided)
          ...(hasJsonApi ? { api_id: account.api_id, api_hash: account.api_hash } : {}),
          // 2FA password from JSON (ALWAYS update if provided)
          ...(has2fa ? { two_fa_password: account.two_fa_password } : {}),
          status: finalStatus,
          last_active: extracted.isValid ? new Date().toISOString() : null,
          phone_country: phoneCountry,
          ...(existing ? {} : {
            warmup_phase: 0,
            warmup_started_at: new Date().toISOString(),
          }),
          // Fingerprint from JSON metadata (if provided)
          ...(hasJsonFingerprint ? {
            device_model: account.device_model,
            system_version: account.system_version,
            app_version: account.app_version || null,
            lang_code: account.lang_code || 'en',
            system_lang_code: account.system_lang_code || 'en-US',
            build_id: null,
          } : {}),
        };

        // Auto-assign proxy for NEW accounts only (if available)
        let assignedProxyId: string | null = null;
        if (!existing && proxyQueue.length > 0) {
          const nextProxy = proxyQueue.shift()!;
          assignedProxyId = nextProxy.id;
          results.proxies_assigned++;
        } else if (!existing && proxyQueue.length === 0) {
          results.proxies_unavailable++;
        }

        if (existing) {
          accountsToUpdate.push({ id: existing.id, data: accountData });
        } else {
          accountsToInsert.push({
            phone_number: account.phone_number,
            ...accountData,
            proxy_id: assignedProxyId,
            maturity_score: 0,
            maturity_days: 0,
            daily_limit: 25,
            messages_sent_today: 0,
            tags: tags.length > 0 ? tags : [],
          });
          
          if (assignedProxyId) {
            proxyAssignments.push({ accountId: account.phone_number, proxyId: assignedProxyId });
          }
        }
      } catch (err) {
        const error = err as Error;
        console.error(`[process-account-upload] Error preparing ${account.phone_number}:`, error.message);
        results.failed++;
        results.errors.push(`${account.phone_number}: ${error.message}`);
      }
    }

    // Batch insert new accounts using upsert for speed (skip duplicates)
    const BATCH_SIZE = 100;
    for (let i = 0; i < accountsToInsert.length; i += BATCH_SIZE) {
      const batch = accountsToInsert.slice(i, i + BATCH_SIZE);
      const { data: insertedBatch, error: insertError } = await supabase
        .from('telegram_accounts')
        .upsert(batch, { 
          onConflict: 'phone_number',
          ignoreDuplicates: true
        })
        .select('id, phone_number');
      
      if (insertError) {
        console.error(`[process-account-upload] Batch upsert error:`, insertError.message);
        results.failed += batch.length;
        results.errors.push(`Batch error: ${insertError.message}`);
      } else if (insertedBatch) {
        results.successful += insertedBatch.length;
        insertedBatch.forEach(acc => results.account_ids.push(acc.id));
        console.log(`[process-account-upload] Batch upserted ${insertedBatch.length} accounts`);
        
        // Update proxy assignments with actual account IDs (parallel for speed)
        const proxyUpdates = insertedBatch
          .map(inserted => {
            const assignment = proxyAssignments.find(a => a.accountId === inserted.phone_number);
            if (assignment) {
              return supabase
                .from('proxies')
                .update({ assigned_account_id: inserted.id })
                .eq('id', assignment.proxyId);
            }
            return null;
          })
          .filter(Boolean);
        
        if (proxyUpdates.length > 0) {
          await Promise.all(proxyUpdates);
        }
      }
    }

    // Batch update existing accounts (parallel updates)
    const updatePromises = accountsToUpdate.map(async ({ id, data }) => {
      const { error } = await supabase
        .from('telegram_accounts')
        .update(data)
        .eq('id', id);
      
      if (error) {
        results.failed++;
        results.errors.push(`Update ${id}: ${error.message}`);
      } else {
        results.successful++;
        results.account_ids.push(id);
      }
    });

    // Process updates in parallel batches
    for (let i = 0; i < updatePromises.length; i += BATCH_SIZE) {
      await Promise.all(updatePromises.slice(i, i + BATCH_SIZE));
    }

    console.log(`[process-account-upload] Completed: ${results.successful} successful, ${results.failed} failed, ${results.proxies_assigned} proxies assigned, ${results.proxies_unavailable} accounts without proxy`);
    console.log(`[process-account-upload] Metadata: ${results.metadata_stats.with_json_api} with JSON API, ${results.metadata_stats.with_json_fingerprint} with JSON fingerprint, ${results.metadata_stats.missing_fingerprint} missing fingerprint, ${results.metadata_stats.with_2fa} with 2FA`);

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
