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

// Real device models as they appear in Telegram's device_model field
const ANDROID_DEVICES = [
  // Samsung Galaxy S Series (real model codes)
  { model: "Samsung SM-S928B", versions: ["Android 14", "Android 15"] }, // S24 Ultra
  { model: "Samsung SM-S926B", versions: ["Android 14", "Android 15"] }, // S24+
  { model: "Samsung SM-S921B", versions: ["Android 14", "Android 15"] }, // S24
  { model: "Samsung SM-S918B", versions: ["Android 13", "Android 14"] }, // S23 Ultra
  { model: "Samsung SM-S916B", versions: ["Android 13", "Android 14"] }, // S23+
  { model: "Samsung SM-S911B", versions: ["Android 13", "Android 14"] }, // S23
  { model: "Samsung SM-S908B", versions: ["Android 12", "Android 13", "Android 14"] }, // S22 Ultra
  { model: "Samsung SM-S901B", versions: ["Android 12", "Android 13", "Android 14"] }, // S22
  { model: "Samsung SM-G998B", versions: ["Android 11", "Android 12", "Android 13"] }, // S21 Ultra
  { model: "Samsung SM-G991B", versions: ["Android 11", "Android 12", "Android 13"] }, // S21
  // Samsung Galaxy A Series
  { model: "Samsung SM-A556B", versions: ["Android 14", "Android 15"] }, // A55
  { model: "Samsung SM-A546B", versions: ["Android 13", "Android 14"] }, // A54
  { model: "Samsung SM-A536B", versions: ["Android 12", "Android 13", "Android 14"] }, // A53
  { model: "Samsung SM-A525F", versions: ["Android 11", "Android 12", "Android 13"] }, // A52
  // Samsung Galaxy Z Fold/Flip
  { model: "Samsung SM-F956B", versions: ["Android 14", "Android 15"] }, // Z Fold 6
  { model: "Samsung SM-F946B", versions: ["Android 13", "Android 14"] }, // Z Fold 5
  { model: "Samsung SM-F741B", versions: ["Android 14", "Android 15"] }, // Z Flip 6
  { model: "Samsung SM-F731B", versions: ["Android 13", "Android 14"] }, // Z Flip 5
  // Xiaomi
  { model: "Xiaomi 14 Pro", versions: ["Android 14"] },
  { model: "Xiaomi 14", versions: ["Android 14"] },
  { model: "Xiaomi 13 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi 13", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi 12 Pro", versions: ["Android 12", "Android 13"] },
  { model: "Redmi Note 13 Pro+", versions: ["Android 13", "Android 14"] },
  { model: "Redmi Note 13 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Redmi Note 12 Pro", versions: ["Android 12", "Android 13"] },
  { model: "POCO F5 Pro", versions: ["Android 13", "Android 14"] },
  // OnePlus
  { model: "OnePlus 12", versions: ["Android 14"] },
  { model: "OnePlus 11", versions: ["Android 13", "Android 14"] },
  { model: "OnePlus 10 Pro", versions: ["Android 12", "Android 13"] },
  { model: "OnePlus 9 Pro", versions: ["Android 11", "Android 12", "Android 13"] },
  { model: "OnePlus Nord 3", versions: ["Android 13", "Android 14"] },
  // Google Pixel
  { model: "Pixel 8 Pro", versions: ["Android 14", "Android 15"] },
  { model: "Pixel 8", versions: ["Android 14", "Android 15"] },
  { model: "Pixel 7 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Pixel 7", versions: ["Android 13", "Android 14"] },
  { model: "Pixel 6 Pro", versions: ["Android 12", "Android 13", "Android 14"] },
  // Other brands
  { model: "OPPO Find X6 Pro", versions: ["Android 13", "Android 14"] },
  { model: "vivo X100 Pro", versions: ["Android 14"] },
  { model: "vivo X90 Pro", versions: ["Android 13", "Android 14"] },
  { model: "realme GT 5 Pro", versions: ["Android 14"] },
  { model: "Nothing Phone (2)", versions: ["Android 13", "Android 14"] },
  { model: "ASUS ROG Phone 8 Pro", versions: ["Android 14"] },
  { model: "Motorola Edge 50 Pro", versions: ["Android 14"] },
  { model: "Sony Xperia 1 V", versions: ["Android 13", "Android 14"] },
];

const IOS_DEVICES = [
  // iPhone 16 series
  { model: "iPhone16,2", versions: ["iOS 18.0", "iOS 18.1", "iOS 18.2"] }, // 16 Pro Max
  { model: "iPhone16,1", versions: ["iOS 18.0", "iOS 18.1", "iOS 18.2"] }, // 16 Pro
  // iPhone 15 series
  { model: "iPhone15,3", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.4", "iOS 18.0"] }, // 15 Pro Max
  { model: "iPhone15,2", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.4", "iOS 18.0"] }, // 15 Pro
  { model: "iPhone15,4", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.4", "iOS 18.0"] }, // 15
  // iPhone 14 series
  { model: "iPhone14,3", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.4"] }, // 14 Pro Max
  { model: "iPhone14,2", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.4"] }, // 14 Pro
  { model: "iPhone14,7", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.4"] }, // 14
  // iPhone 13 series
  { model: "iPhone14,5", versions: ["iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // 13
  { model: "iPhone14,2", versions: ["iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // 13 Pro
  // iPhone 12 series
  { model: "iPhone13,4", versions: ["iOS 14.5", "iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // 12 Pro Max
  { model: "iPhone13,3", versions: ["iOS 14.5", "iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // 12 Pro
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

// Track used fingerprints to ensure uniqueness within batch
const usedFingerprints = new Set<string>();

interface ApiCredential {
  id: string;
  api_id: string;
  api_hash: string;
  client_type: string;
  accounts_count: number;
}

function generateUniqueFingerprint(existingFingerprints: Set<string>, preferredClientType?: string): {
  device_model: string;
  system_version: string;
  app_version: string;
  lang_code: string;
  system_lang_code: string;
} {
  let attempts = 0;
  const maxAttempts = 100;
  
  while (attempts < maxAttempts) {
    // If we have a preferred client type, use matching device
    let useAndroid = Math.random() < 0.8;
    if (preferredClientType === 'ios' || preferredClientType === 'macos') {
      useAndroid = false;
    } else if (preferredClientType === 'android') {
      useAndroid = true;
    }
    
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
    
    // Create unique key for this fingerprint
    const fingerprintKey = `${device_model}|${system_version}|${app_version}|${lang_code}|${system_lang_code}`;
    
    // Check if this fingerprint is already used
    if (!existingFingerprints.has(fingerprintKey) && !usedFingerprints.has(fingerprintKey)) {
      usedFingerprints.add(fingerprintKey);
      return { device_model, system_version, app_version, lang_code, system_lang_code };
    }
    
    attempts++;
  }
  
  // Fallback: generate with random suffix to ensure uniqueness
  const device = randomChoice(ANDROID_DEVICES);
  const app_version = `${randomChoice(TELEGRAM_VERSIONS)}.${Math.floor(Math.random() * 100)}`;
  return {
    device_model: device.model,
    system_version: randomChoice(device.versions),
    app_version,
    lang_code: randomChoice(LANGUAGES).code,
    system_lang_code: "en-US"
  };
}

// STRICT 1:1 API ASSIGNMENT - No load balancing, each account gets unique API
// This function is no longer used - replaced by queue-based assignment
function selectApiCredentialFromQueue(
  apiQueue: ApiCredential[], 
  deviceModel: string
): ApiCredential | null {
  if (apiQueue.length === 0) return null;
  
  // Determine device type from fingerprint
  const isIos = deviceModel.toLowerCase().includes('iphone');
  
  // Try to find matching client type first
  const matchingIndex = apiQueue.findIndex(c => {
    if (isIos) return c.client_type === 'ios' || c.client_type === 'macos';
    return c.client_type === 'android' || c.client_type === 'desktop';
  });
  
  if (matchingIndex !== -1) {
    // Remove and return the matching API
    return apiQueue.splice(matchingIndex, 1)[0];
  }
  
  // Fallback: take the first available API
  return apiQueue.shift() || null;
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
  
  // SQLite keywords and table names to exclude
  const SQLITE_KEYWORDS = new Set([
    'sqlite', 'format', 'table', 'create', 'index', 'integer', 'primary', 'unique',
    'text', 'blob', 'null', 'version', 'sessions', 'entities', 'sent_files', 
    'update_state', 'dc_id', 'server_address', 'auth_key', 'takeout_id', 'pts',
    'qts', 'date', 'seq', 'unread_count', 'api_layer', 'autoincrement', 'varchar',
    'boolean', 'datetime', 'timestamp', 'session', 'entity', 'channel', 'group',
    'chat', 'user', 'message', 'media', 'photo', 'document', 'video', 'audio',
    'voice', 'sticker', 'animation', 'contact', 'location', 'venue', 'poll',
    'game', 'invoice', 'payment', 'shipping', 'input', 'output', 'peer', 'access',
    'hash', 'layer', 'config', 'state', 'update', 'delete', 'select', 'insert',
    'where', 'from', 'join', 'left', 'right', 'inner', 'outer', 'order', 'limit',
    'offset', 'count', 'group', 'having', 'distinct', 'union', 'except', 'intersect',
    'values', 'default', 'check', 'foreign', 'references', 'cascade', 'restrict',
    'action', 'constraint', 'trigger', 'view', 'procedure', 'function', 'begin',
    'commit', 'rollback', 'transaction', 'savepoint', 'release', 'vacuum', 'analyze',
    'explain', 'pragma', 'attach', 'detach', 'reindex', 'rename', 'alter', 'drop',
    'column', 'database', 'schema', 'type', 'enum', 'array', 'object', 'string',
    'number', 'float', 'double', 'real', 'numeric', 'decimal', 'money', 'serial',
    'bigint', 'smallint', 'tinyint', 'mediumint', 'unsigned', 'signed', 'zerofill',
    'binary', 'varbinary', 'char', 'nchar', 'nvarchar', 'clob', 'nclob', 'rowid',
    'oid', 'ctid', 'xmin', 'xmax', 'cmin', 'cmax', 'tableoid', 'users', 'accounts',
    'messages', 'chats', 'dialogs', 'files', 'downloads', 'uploads', 'cache',
    'gtable', 'stable', 'mtable', 'ltable', 'atable', 'btable', 'ctable', 'dtable',
    'etable', 'ftable', 'htable', 'itable', 'jtable', 'ktable', 'ntable', 'otable',
    'ptable', 'qtable', 'rtable', 'ttable', 'utable', 'vtable', 'wtable', 'xtable',
    'ytable', 'ztable', 'gtableupdate', 'update_stateupdate', 'stateupdate_state',
    'lite', 'autoindex', 'rowindex', 'keyindex'
  ]);
  
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
      // Extracting usernames from here causes garbage data like "Gtableupdate_stateupdate_state"
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

    // Fetch API credentials for STRICT 1:1 distribution (only unassigned APIs)
    const { data: apiCredentials } = await supabase
      .from('telegram_api_credentials')
      .select('*')
      .eq('is_active', true)
      .eq('accounts_count', 0)  // STRICT: Only APIs with NO accounts assigned
      .order('created_at', { ascending: true });
    
    // Create a queue of available APIs (like proxies)
    const apiQueue: ApiCredential[] = [...(apiCredentials || [])];
    console.log(`[process-account-upload] Found ${apiQueue.length} unassigned API credentials for 1:1 distribution`);

    // Fetch existing fingerprints to ensure uniqueness
    const { data: existingAccounts } = await supabase
      .from('telegram_accounts')
      .select('device_model, system_version, app_version, lang_code, system_lang_code');
    
    const existingFingerprints = new Set<string>();
    existingAccounts?.forEach(acc => {
      if (acc.device_model) {
        const key = `${acc.device_model}|${acc.system_version}|${acc.app_version}|${acc.lang_code}|${acc.system_lang_code}`;
        existingFingerprints.add(key);
      }
    });
    console.log(`[process-account-upload] Found ${existingFingerprints.size} existing fingerprints`);

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
      apis_assigned: 0,
      apis_unavailable: 0
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
        const status = extracted.isValid ? 'active' : 'disconnected';
        
        // Check if account already exists
        const existing = existingAccountsMap.get(account.phone_number);
        
        // STRICT 1:1 API assignment from queue (like proxies) - NEW accounts only
        let selectedApiCredential: ApiCredential | null = null;
        if (!existing && apiQueue.length > 0) {
          const preferredType = Math.random() < 0.8 ? 'android' : 'ios';
          selectedApiCredential = selectApiCredentialFromQueue(apiQueue, preferredType === 'ios' ? 'iPhone' : 'Samsung');
          if (selectedApiCredential) {
            results.apis_assigned++;
          }
        } else if (!existing && apiQueue.length === 0) {
          results.apis_unavailable++;
        }
        
        // Generate UNIQUE device fingerprint matching the API type
        const fingerprint = generateUniqueFingerprint(
          existingFingerprints, 
          selectedApiCredential?.client_type
        );
        
        // Extract phone country
        const phoneCountry = extractPhoneCountry(account.phone_number);

        // Determine the status - PRESERVE existing status for restricted/banned/frozen accounts
        // Only set status for new accounts or if existing was 'disconnected'
        let finalStatus: string;
        if (existing) {
          // Preserve important statuses, only update if it was disconnected and session is now valid
          const preserveStatuses = ['banned', 'restricted', 'frozen', 'cooldown'];
          if (preserveStatuses.includes(existing.status)) {
            finalStatus = existing.status; // Keep the existing status
          } else if (existing.status === 'disconnected' && extracted.isValid) {
            finalStatus = 'active'; // Re-activate if was disconnected and session is valid
          } else {
            finalStatus = existing.status; // Keep current status
          }
        } else {
          // New account - set based on session validity
          finalStatus = extracted.isValid ? 'active' : 'disconnected';
        }

        const accountData = {
          session_data: account.session_data,
          first_name: extracted.firstName || account.first_name || null,
          last_name: extracted.lastName || account.last_name || null,
          username: extracted.username || account.username || null,
          telegram_id: extracted.telegramId || null,
          api_id: account.api_id,
          api_hash: account.api_hash,
          status: finalStatus,
          last_active: extracted.isValid ? new Date().toISOString() : null,
          phone_country: phoneCountry,
          ...(existing ? {} : {
            api_credential_id: selectedApiCredential?.id || null,
            warmup_phase: 0,
            warmup_started_at: new Date().toISOString(),
          }),
          ...(existing?.device_model ? {} : {
            device_model: fingerprint.device_model,
            system_version: fingerprint.system_version,
            app_version: fingerprint.app_version,
            lang_code: fingerprint.lang_code,
            system_lang_code: fingerprint.system_lang_code,
          })
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
            proxy_id: assignedProxyId, // Auto-assigned proxy (null if none available)
            device_model: fingerprint.device_model,
            system_version: fingerprint.system_version,
            app_version: fingerprint.app_version,
            lang_code: fingerprint.lang_code,
            system_lang_code: fingerprint.system_lang_code,
            maturity_score: 0,
            maturity_days: 0,
            daily_limit: 25,
            messages_sent_today: 0,
            tags: tags.length > 0 ? tags : [],
          });
          
          // Track proxy assignment for bulk update after insert
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

    // Batch insert new accounts (up to 100 at a time to avoid payload limits)
    const BATCH_SIZE = 100;
    for (let i = 0; i < accountsToInsert.length; i += BATCH_SIZE) {
      const batch = accountsToInsert.slice(i, i + BATCH_SIZE);
      const { data: insertedBatch, error: insertError } = await supabase
        .from('telegram_accounts')
        .insert(batch)
        .select('id, phone_number');
      
      if (insertError) {
        console.error(`[process-account-upload] Batch insert error:`, insertError.message);
        // Try individual inserts as fallback
        for (const acc of batch) {
          try {
            const { data, error } = await supabase
              .from('telegram_accounts')
              .insert(acc)
              .select('id')
              .single();
            if (error) throw error;
            results.successful++;
            results.account_ids.push(data.id);
          } catch (e) {
            results.failed++;
            results.errors.push(`${acc.phone_number}: ${(e as Error).message}`);
          }
        }
      } else if (insertedBatch) {
        results.successful += insertedBatch.length;
        insertedBatch.forEach(acc => results.account_ids.push(acc.id));
        console.log(`[process-account-upload] Batch inserted ${insertedBatch.length} accounts`);
        
        // Update proxy assignments with actual account IDs
        for (const inserted of insertedBatch) {
          const assignment = proxyAssignments.find(a => a.accountId === inserted.phone_number);
          if (assignment) {
            await supabase
              .from('proxies')
              .update({ assigned_account_id: inserted.id })
              .eq('id', assignment.proxyId);
          }
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
