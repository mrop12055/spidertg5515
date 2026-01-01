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

// Device fingerprint pools for realistic randomization
const ANDROID_DEVICES = [
  { model: "Samsung SM-G991B", versions: ["Android 11", "Android 12", "Android 13"] },
  { model: "Samsung SM-G998B", versions: ["Android 11", "Android 12", "Android 13"] },
  { model: "Samsung SM-A525F", versions: ["Android 11", "Android 12", "Android 13"] },
  { model: "Samsung SM-A536B", versions: ["Android 12", "Android 13", "Android 14"] },
  { model: "Samsung SM-S911B", versions: ["Android 13", "Android 14"] },
  { model: "Samsung SM-S918B", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi 12", versions: ["Android 12", "Android 13"] },
  { model: "Xiaomi 12 Pro", versions: ["Android 12", "Android 13"] },
  { model: "Xiaomi 13", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi 13 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi Redmi Note 12", versions: ["Android 12", "Android 13"] },
  { model: "Xiaomi Redmi Note 12 Pro", versions: ["Android 12", "Android 13"] },
  { model: "OnePlus 9", versions: ["Android 11", "Android 12", "Android 13"] },
  { model: "OnePlus 9 Pro", versions: ["Android 11", "Android 12", "Android 13"] },
  { model: "OnePlus 10 Pro", versions: ["Android 12", "Android 13"] },
  { model: "OnePlus 11", versions: ["Android 13", "Android 14"] },
  { model: "Google Pixel 6", versions: ["Android 12", "Android 13", "Android 14"] },
  { model: "Google Pixel 6 Pro", versions: ["Android 12", "Android 13", "Android 14"] },
  { model: "Google Pixel 7", versions: ["Android 13", "Android 14"] },
  { model: "Google Pixel 7 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Google Pixel 8", versions: ["Android 14"] },
  { model: "Google Pixel 8 Pro", versions: ["Android 14"] },
  { model: "HUAWEI P40 Pro", versions: ["Android 10", "Android 11"] },
  { model: "HUAWEI Mate 50 Pro", versions: ["Android 12", "Android 13"] },
  { model: "OPPO Find X5 Pro", versions: ["Android 12", "Android 13"] },
  { model: "vivo X80 Pro", versions: ["Android 12", "Android 13"] },
  { model: "Realme GT 3", versions: ["Android 13"] },
  { model: "Motorola Edge 40 Pro", versions: ["Android 13"] },
  { model: "Sony Xperia 1 V", versions: ["Android 13", "Android 14"] },
  { model: "Nothing Phone (2)", versions: ["Android 13", "Android 14"] },
];

const IOS_DEVICES = [
  { model: "iPhone 12", versions: ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"] },
  { model: "iPhone 12 Pro", versions: ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"] },
  { model: "iPhone 13", versions: ["iOS 15.0", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"] },
  { model: "iPhone 13 Pro", versions: ["iOS 15.0", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"] },
  { model: "iPhone 14", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"] },
  { model: "iPhone 14 Pro", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"] },
  { model: "iPhone 15", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.3"] },
  { model: "iPhone 15 Pro", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.3"] },
  { model: "iPhone 15 Pro Max", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.3"] },
];

const TELEGRAM_VERSIONS = [
  "10.3.2", "10.4.0", "10.4.1", "10.4.2", "10.5.0", "10.5.1", "10.6.0", "10.6.1",
  "10.7.0", "10.8.0", "10.8.1", "10.9.0", "10.9.1", "10.10.0", "10.10.1",
  "10.11.0", "10.12.0", "10.12.1", "10.13.0", "10.14.0", "10.14.1", "10.14.2",
  "11.0.0", "11.0.1", "11.1.0", "11.1.1", "11.2.0", "11.2.1",
];

const LANGUAGES = [
  { code: "en", systems: ["en-US", "en-GB", "en-AU", "en-CA"] },
  { code: "ar", systems: ["ar-SA", "ar-EG", "ar-AE"] },
  { code: "de", systems: ["de-DE", "de-AT", "de-CH"] },
  { code: "es", systems: ["es-ES", "es-MX", "es-AR"] },
  { code: "fr", systems: ["fr-FR", "fr-CA"] },
  { code: "it", systems: ["it-IT"] },
  { code: "pt", systems: ["pt-BR", "pt-PT"] },
  { code: "ru", systems: ["ru-RU"] },
  { code: "tr", systems: ["tr-TR"] },
  { code: "hi", systems: ["hi-IN"] },
  { code: "id", systems: ["id-ID"] },
  { code: "ja", systems: ["ja-JP"] },
  { code: "ko", systems: ["ko-KR"] },
  { code: "zh", systems: ["zh-CN", "zh-TW"] },
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateFingerprint(): {
  device_model: string;
  system_version: string;
  app_version: string;
  lang_code: string;
  system_lang_code: string;
} {
  // 80% Android, 20% iOS
  const useAndroid = Math.random() < 0.8;
  
  let device_model: string;
  let system_version: string;
  
  if (useAndroid) {
    const device = randomChoice(ANDROID_DEVICES);
    device_model = device.model;
    system_version = randomChoice(device.versions);
  } else {
    const device = randomChoice(IOS_DEVICES);
    device_model = device.model;
    system_version = randomChoice(device.versions);
  }
  
  const app_version = randomChoice(TELEGRAM_VERSIONS);
  const lang = randomChoice(LANGUAGES);
  const lang_code = lang.code;
  const system_lang_code = randomChoice(lang.systems);
  
  return { device_model, system_version, app_version, lang_code, system_lang_code };
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
      accounts: [] as any[],
      account_ids: [] as string[]
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
        
        // Generate unique device fingerprint for this account
        const fingerprint = generateFingerprint();
        
        console.log(`[process-account-upload] ${account.phone_number}: valid=${extracted.isValid}, fingerprint=${fingerprint.device_model} (${fingerprint.system_version})`);

        // Check if account already exists
        const { data: existing } = await supabase
          .from('telegram_accounts')
          .select('id, device_model')
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
          // Only set fingerprint if not already set (preserve existing)
          ...(existing?.device_model ? {} : {
            device_model: fingerprint.device_model,
            system_version: fingerprint.system_version,
            app_version: fingerprint.app_version,
            lang_code: fingerprint.lang_code,
            system_lang_code: fingerprint.system_lang_code,
          })
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
          results.account_ids.push(existing.id);
        } else {
          // Insert new account with fingerprint
          const { data, error } = await supabase
            .from('telegram_accounts')
            .insert({
              phone_number: account.phone_number,
              ...accountData,
              device_model: fingerprint.device_model,
              system_version: fingerprint.system_version,
              app_version: fingerprint.app_version,
              lang_code: fingerprint.lang_code,
              system_lang_code: fingerprint.system_lang_code,
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
          results.account_ids.push(data.id);
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
