import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Real device models as they appear in Telegram's device_model field
// Using actual model codes that Telegram clients report
const ANDROID_DEVICES = [
  // Samsung Galaxy S Series (real model codes)
  { model: "Samsung SM-S928B", versions: ["Android 14", "Android 15"] }, // S24 Ultra
  { model: "Samsung SM-S926B", versions: ["Android 14", "Android 15"] }, // S24+
  { model: "Samsung SM-S921B", versions: ["Android 14", "Android 15"] }, // S24
  { model: "Samsung SM-S918B", versions: ["Android 13", "Android 14"] }, // S23 Ultra
  { model: "Samsung SM-S916B", versions: ["Android 13", "Android 14"] }, // S23+
  { model: "Samsung SM-S911B", versions: ["Android 13", "Android 14"] }, // S23
  { model: "Samsung SM-S908B", versions: ["Android 12", "Android 13", "Android 14"] }, // S22 Ultra
  { model: "Samsung SM-S906B", versions: ["Android 12", "Android 13", "Android 14"] }, // S22+
  { model: "Samsung SM-S901B", versions: ["Android 12", "Android 13", "Android 14"] }, // S22
  { model: "Samsung SM-G998B", versions: ["Android 11", "Android 12", "Android 13"] }, // S21 Ultra
  { model: "Samsung SM-G996B", versions: ["Android 11", "Android 12", "Android 13"] }, // S21+
  { model: "Samsung SM-G991B", versions: ["Android 11", "Android 12", "Android 13"] }, // S21
  // Samsung Galaxy A Series
  { model: "Samsung SM-A556B", versions: ["Android 14", "Android 15"] }, // A55
  { model: "Samsung SM-A546B", versions: ["Android 13", "Android 14"] }, // A54
  { model: "Samsung SM-A536B", versions: ["Android 12", "Android 13", "Android 14"] }, // A53
  { model: "Samsung SM-A525F", versions: ["Android 11", "Android 12", "Android 13"] }, // A52
  { model: "Samsung SM-A346B", versions: ["Android 13", "Android 14"] }, // A34
  { model: "Samsung SM-A236B", versions: ["Android 12", "Android 13"] }, // A23
  // Samsung Galaxy Z Fold/Flip
  { model: "Samsung SM-F956B", versions: ["Android 14", "Android 15"] }, // Z Fold 6
  { model: "Samsung SM-F946B", versions: ["Android 13", "Android 14"] }, // Z Fold 5
  { model: "Samsung SM-F936B", versions: ["Android 12", "Android 13", "Android 14"] }, // Z Fold 4
  { model: "Samsung SM-F741B", versions: ["Android 14", "Android 15"] }, // Z Flip 6
  { model: "Samsung SM-F731B", versions: ["Android 13", "Android 14"] }, // Z Flip 5
  // Xiaomi (real model names as reported by TDesktop/TDLib)
  { model: "Xiaomi 14 Ultra", versions: ["Android 14"] },
  { model: "Xiaomi 14 Pro", versions: ["Android 14"] },
  { model: "Xiaomi 14", versions: ["Android 14"] },
  { model: "Xiaomi 13 Ultra", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi 13 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi 13", versions: ["Android 13", "Android 14"] },
  { model: "Xiaomi 12 Pro", versions: ["Android 12", "Android 13"] },
  { model: "Xiaomi 12", versions: ["Android 12", "Android 13"] },
  { model: "Redmi Note 13 Pro+", versions: ["Android 13", "Android 14"] },
  { model: "Redmi Note 13 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Redmi Note 12 Pro+", versions: ["Android 12", "Android 13"] },
  { model: "Redmi Note 12 Pro", versions: ["Android 12", "Android 13"] },
  { model: "POCO F5 Pro", versions: ["Android 13", "Android 14"] },
  { model: "POCO F5", versions: ["Android 13", "Android 14"] },
  // OnePlus (real model names)
  { model: "OnePlus 12", versions: ["Android 14"] },
  { model: "OnePlus 11", versions: ["Android 13", "Android 14"] },
  { model: "OnePlus 10 Pro", versions: ["Android 12", "Android 13"] },
  { model: "OnePlus 10T", versions: ["Android 12", "Android 13"] },
  { model: "OnePlus 9 Pro", versions: ["Android 11", "Android 12", "Android 13"] },
  { model: "OnePlus Nord 3", versions: ["Android 13", "Android 14"] },
  { model: "OnePlus Nord CE 3", versions: ["Android 13", "Android 14"] },
  // Google Pixel (real model names as reported)
  { model: "Pixel 8 Pro", versions: ["Android 14", "Android 15"] },
  { model: "Pixel 8", versions: ["Android 14", "Android 15"] },
  { model: "Pixel 8a", versions: ["Android 14", "Android 15"] },
  { model: "Pixel 7 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Pixel 7", versions: ["Android 13", "Android 14"] },
  { model: "Pixel 7a", versions: ["Android 13", "Android 14"] },
  { model: "Pixel 6 Pro", versions: ["Android 12", "Android 13", "Android 14"] },
  { model: "Pixel 6", versions: ["Android 12", "Android 13", "Android 14"] },
  // Other popular brands
  { model: "OPPO Find X7 Ultra", versions: ["Android 14"] },
  { model: "OPPO Find X6 Pro", versions: ["Android 13", "Android 14"] },
  { model: "OPPO Reno 11 Pro", versions: ["Android 14"] },
  { model: "vivo X100 Pro", versions: ["Android 14"] },
  { model: "vivo X90 Pro", versions: ["Android 13", "Android 14"] },
  { model: "realme GT 5 Pro", versions: ["Android 14"] },
  { model: "realme GT 3", versions: ["Android 13", "Android 14"] },
  { model: "Nothing Phone (2)", versions: ["Android 13", "Android 14"] },
  { model: "Nothing Phone (1)", versions: ["Android 12", "Android 13"] },
  { model: "ASUS ROG Phone 8 Pro", versions: ["Android 14"] },
  { model: "ASUS ROG Phone 7", versions: ["Android 13", "Android 14"] },
  { model: "Motorola Edge 50 Pro", versions: ["Android 14"] },
  { model: "Motorola Edge 40 Pro", versions: ["Android 13", "Android 14"] },
  { model: "Sony Xperia 1 V", versions: ["Android 13", "Android 14"] },
  { model: "Sony Xperia 5 V", versions: ["Android 14"] },
];

const IOS_DEVICES = [
  // iPhone 16 series
  { model: "iPhone16,2", versions: ["iOS 18.0", "iOS 18.1", "iOS 18.2"] }, // iPhone 16 Pro Max
  { model: "iPhone16,1", versions: ["iOS 18.0", "iOS 18.1", "iOS 18.2"] }, // iPhone 16 Pro
  { model: "iPhone16,3", versions: ["iOS 18.0", "iOS 18.1", "iOS 18.2"] }, // iPhone 16 Plus
  { model: "iPhone16,4", versions: ["iOS 18.0", "iOS 18.1", "iOS 18.2"] }, // iPhone 16
  // iPhone 15 series
  { model: "iPhone15,3", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.4", "iOS 18.0"] }, // iPhone 15 Pro Max
  { model: "iPhone15,2", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.4", "iOS 18.0"] }, // iPhone 15 Pro
  { model: "iPhone15,5", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.4", "iOS 18.0"] }, // iPhone 15 Plus
  { model: "iPhone15,4", versions: ["iOS 17.0", "iOS 17.2", "iOS 17.4", "iOS 18.0"] }, // iPhone 15
  // iPhone 14 series
  { model: "iPhone14,3", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.4"] }, // iPhone 14 Pro Max
  { model: "iPhone14,2", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.4"] }, // iPhone 14 Pro
  { model: "iPhone14,8", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.4"] }, // iPhone 14 Plus
  { model: "iPhone14,7", versions: ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.4"] }, // iPhone 14
  // iPhone 13 series
  { model: "iPhone14,3", versions: ["iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // iPhone 13 Pro Max
  { model: "iPhone14,2", versions: ["iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // iPhone 13 Pro
  { model: "iPhone14,5", versions: ["iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // iPhone 13
  // iPhone 12 series
  { model: "iPhone13,4", versions: ["iOS 14.5", "iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // iPhone 12 Pro Max
  { model: "iPhone13,3", versions: ["iOS 14.5", "iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // iPhone 12 Pro
  { model: "iPhone13,2", versions: ["iOS 14.5", "iOS 15.0", "iOS 16.0", "iOS 17.0"] }, // iPhone 12
];

const TELEGRAM_VERSIONS = [
  "10.3.2", "10.4.0", "10.5.0", "10.6.0", "10.7.0", "10.8.0", "10.9.0", 
  "10.10.0", "10.11.0", "10.12.0", "10.13.0", "10.14.0", "10.14.2",
  "11.0.0", "11.1.0", "11.2.0", "11.3.0", "11.4.0"
];

const LANGUAGES = [
  { code: "en", systems: ["en-US", "en-GB", "en-AU", "en-CA"] },
  { code: "ar", systems: ["ar-SA", "ar-AE", "ar-EG"] },
  { code: "de", systems: ["de-DE", "de-AT", "de-CH"] },
  { code: "es", systems: ["es-ES", "es-MX", "es-AR"] },
  { code: "fr", systems: ["fr-FR", "fr-CA", "fr-BE"] },
  { code: "it", systems: ["it-IT"] },
  { code: "pt", systems: ["pt-BR", "pt-PT"] },
  { code: "ru", systems: ["ru-RU"] },
  { code: "hi", systems: ["hi-IN"] },
  { code: "ja", systems: ["ja-JP"] },
  { code: "ko", systems: ["ko-KR"] },
  { code: "zh", systems: ["zh-CN", "zh-TW", "zh-HK"] },
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate realistic manufacturer-specific build IDs
function generateBuildId(deviceModel: string, systemVersion: string): string {
  const randomHex = (len: number) => {
    let result = '';
    for (let i = 0; i < len; i++) {
      result += '0123456789ABCDEF'[Math.floor(Math.random() * 16)];
    }
    return result;
  };
  
  const randomLetters = (len: number) => {
    let result = '';
    for (let i = 0; i < len; i++) {
      result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
    }
    return result;
  };
  
  // Samsung format: G991BXXU5CVKA, S928BXXU3AXJA, A525FXXU4CVK1
  if (deviceModel.includes('Samsung SM-')) {
    const modelCode = deviceModel.replace('Samsung SM-', '');
    const regions = ['XXU', 'XXS', 'OXM', 'BTU', 'XEU'];
    const region = randomChoice(regions);
    const major = Math.floor(Math.random() * 6) + 1; // 1-6
    const year = randomChoice(['A', 'B', 'C', 'D']); // Year code
    const month = randomChoice(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']); // Month code
    const revision = randomChoice(['A', 'B', 'C', '1', '2', '3']);
    return `${modelCode}${region}${major}${year}${randomLetters(1)}${month}${revision}`;
  }
  
  // Google Pixel format: AP2A.240805.005, AP1A.240705.004, TQ3A.230805.001
  if (deviceModel.includes('Pixel')) {
    const prefixes = ['AP2A', 'AP1A', 'TQ3A', 'UQ1A', 'AP4A'];
    const prefix = randomChoice(prefixes);
    const year = 24 + Math.floor(Math.random() * 2); // 24-25
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
    const patch = String(Math.floor(Math.random() * 10)).padStart(3, '0');
    return `${prefix}.${year}${month}${day}.${patch}`;
  }
  
  // Xiaomi/Redmi/POCO format: V14.0.23.11.28.DEV, V816.0.6.0.UMFMIXM
  if (deviceModel.includes('Xiaomi') || deviceModel.includes('Redmi') || deviceModel.includes('POCO')) {
    const type = Math.random() < 0.5 ? 'stable' : 'dev';
    if (type === 'dev') {
      const major = 14 + Math.floor(Math.random() * 2);
      const year = 23 + Math.floor(Math.random() * 2);
      const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
      const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
      return `V${major}.0.${year}.${month}.${day}.DEV`;
    } else {
      const versions = ['UMFMIXM', 'TMFCNXM', 'SMFMIXM', 'UMGCNXM', 'TMGMIXM'];
      const ver = randomChoice(versions);
      const major = 14 + Math.floor(Math.random() * 3);
      const minor = Math.floor(Math.random() * 10);
      return `V${major}.0.${minor}.0.${ver}`;
    }
  }
  
  // OnePlus format: KB2003_11_C.58, IN2023_11.A.32
  if (deviceModel.includes('OnePlus')) {
    const codes = ['KB2003', 'LE2123', 'IN2023', 'NE2213', 'CPH2449'];
    const code = randomChoice(codes);
    const android = systemVersion.includes('14') ? '14' : systemVersion.includes('13') ? '13' : '12';
    const letter = randomChoice(['A', 'B', 'C', 'F']);
    const patch = Math.floor(Math.random() * 60) + 20;
    return `${code}_${android}.${letter}.${patch}`;
  }
  
  // iPhone format: 21A329, 21F79, 22A3354 (iOS build numbers)
  if (deviceModel.includes('iPhone')) {
    const major = systemVersion.includes('18') ? 22 : systemVersion.includes('17') ? 21 : 20;
    const letters = 'ABCDEFGHIJ';
    const letter = letters[Math.floor(Math.random() * letters.length)];
    const build = Math.floor(Math.random() * 400) + 50;
    return `${major}${letter}${build}`;
  }
  
  // OPPO/vivo/realme format: RMX3630_11.C.28, V2227A_14.0.12.8
  if (deviceModel.includes('OPPO') || deviceModel.includes('vivo') || deviceModel.includes('realme')) {
    const codes = ['RMX3630', 'CPH2591', 'V2227A', 'RMX3771'];
    const code = randomChoice(codes);
    const android = systemVersion.includes('14') ? '14' : '13';
    const patch = Math.floor(Math.random() * 30) + 1;
    return `${code}_${android}.0.${patch}.${Math.floor(Math.random() * 10)}`;
  }
  
  // Nothing format: Pong-U2.6-241025-1844
  if (deviceModel.includes('Nothing')) {
    const codes = ['Pong', 'Spacewar'];
    const code = randomChoice(codes);
    const major = 2 + Math.floor(Math.random() * 2);
    const minor = Math.floor(Math.random() * 10);
    const year = 24 + Math.floor(Math.random() * 2);
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
    return `${code}-U${major}.${minor}-${year}${month}${day}-${1000 + Math.floor(Math.random() * 9000)}`;
  }
  
  // Sony format: 67.2.A.2.102
  if (deviceModel.includes('Sony')) {
    const major = 65 + Math.floor(Math.random() * 5);
    const minor = Math.floor(Math.random() * 3) + 1;
    const patch = Math.floor(Math.random() * 5) + 1;
    const build = Math.floor(Math.random() * 200) + 50;
    return `${major}.${minor}.A.${patch}.${build}`;
  }
  
  // ASUS ROG format: WW_34.0610.0610.81
  if (deviceModel.includes('ASUS')) {
    const regions = ['WW', 'CN', 'TW'];
    const region = randomChoice(regions);
    const major = 33 + Math.floor(Math.random() * 3);
    const build = String(Math.floor(Math.random() * 1000) + 500).padStart(4, '0');
    return `${region}_${major}.${build}.${build}.${Math.floor(Math.random() * 100)}`;
  }
  
  // Motorola format: U1TQS34.43-18-2-6
  if (deviceModel.includes('Motorola')) {
    const prefixes = ['U1TQS', 'U1TDS', 'U1SQS'];
    const prefix = randomChoice(prefixes);
    const major = 33 + Math.floor(Math.random() * 3);
    return `${prefix}${major}.${Math.floor(Math.random() * 50) + 10}-${Math.floor(Math.random() * 20) + 1}-${Math.floor(Math.random() * 5) + 1}-${Math.floor(Math.random() * 10)}`;
  }
  
  // Generic Android fallback
  const androidVersion = systemVersion.replace('Android ', '');
  return `${androidVersion}.${randomHex(4)}.${Math.floor(Math.random() * 100)}`;
}

function generateUniqueFingerprint(usedFingerprints: Set<string>): {
  device_model: string;
  system_version: string;
  app_version: string;
  lang_code: string;
  system_lang_code: string;
  build_id: string;
} {
  let attempts = 0;
  const maxAttempts = 500;
  
  while (attempts < maxAttempts) {
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
    const build_id = generateBuildId(device_model, system_version);
    
    // Create unique key for this fingerprint (full combination including build_id)
    const fingerprintKey = `${device_model}|${system_version}|${app_version}|${lang_code}|${system_lang_code}|${build_id}`;
    
    if (!usedFingerprints.has(fingerprintKey)) {
      usedFingerprints.add(fingerprintKey);
      return { device_model, system_version, app_version, lang_code, system_lang_code, build_id };
    }
    
    attempts++;
  }
  
  // Fallback: generate with random suffix to ensure uniqueness
  const device = randomChoice(ANDROID_DEVICES);
  const system_version = randomChoice(device.versions);
  const uniqueSuffix = Math.floor(Math.random() * 10000);
  const app_version = `${randomChoice(TELEGRAM_VERSIONS)}.${uniqueSuffix}`;
  const build_id = generateBuildId(device.model, system_version);
  const fingerprintKey = `${device.model}|${system_version}|${app_version}|en|en-US|${build_id}`;
  usedFingerprints.add(fingerprintKey);
  
  return {
    device_model: device.model,
    system_version,
    app_version,
    lang_code: "en",
    system_lang_code: "en-US",
    build_id
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Parse request body for force option
    let forceAll = false;
    try {
      const body = await req.json();
      forceAll = body.force === true;
    } catch {
      // No body or invalid JSON, use defaults
    }

    console.log(`[regenerate-fingerprints] Starting fingerprint regeneration (force=${forceAll})...`);

    // Fetch ALL accounts with their current fingerprints
    const { data: allAccounts, error: fetchError } = await supabase
      .from('telegram_accounts')
      .select('id, phone_number, device_model, system_version, app_version, lang_code, system_lang_code')
      .in('status', ['active', 'restricted', 'cooldown', 'disconnected'])
      .order('created_at', { ascending: true });

    if (fetchError) throw fetchError;

    if (!allAccounts || allAccounts.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No accounts found', updated: 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[regenerate-fingerprints] Found ${allAccounts.length} accounts to process`);

    let accountsToUpdate: string[] = [];
    
    if (forceAll) {
      // Force regenerate ALL fingerprints
      accountsToUpdate = allAccounts.map(acc => acc.id);
      console.log(`[regenerate-fingerprints] FORCE MODE: Will regenerate all ${accountsToUpdate.length} fingerprints`);
    } else {
      // Find duplicate fingerprints (based on FULL fingerprint for true uniqueness)
      const fingerprintCounts = new Map<string, string[]>();
      
      for (const acc of allAccounts) {
        if (acc.device_model && acc.system_version) {
          // Use FULL fingerprint key for uniqueness
          const key = `${acc.device_model}|${acc.system_version}|${acc.app_version || ''}|${acc.lang_code || ''}|${acc.system_lang_code || ''}`;
          if (!fingerprintCounts.has(key)) {
            fingerprintCounts.set(key, []);
          }
          fingerprintCounts.get(key)!.push(acc.id);
        }
      }

      // Find accounts with duplicate fingerprints (keep first, update rest)
      for (const [key, accountIds] of fingerprintCounts) {
        if (accountIds.length > 1) {
          // Keep the first account's fingerprint, update the rest
          accountsToUpdate.push(...accountIds.slice(1));
        }
      }

      console.log(`[regenerate-fingerprints] Found ${accountsToUpdate.length} accounts with duplicate fingerprints`);
    }

    if (accountsToUpdate.length === 0) {
      return new Response(
        JSON.stringify({ 
          message: 'All accounts already have unique fingerprints',
          total: allAccounts.length,
          updated: 0,
          duplicates: 0
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build set of fingerprints to preserve (accounts NOT being updated)
    const usedFingerprints = new Set<string>();
    
    for (const acc of allAccounts) {
      if (!accountsToUpdate.includes(acc.id) && acc.device_model && acc.system_version) {
        const key = `${acc.device_model}|${acc.system_version}|${acc.app_version || '10.14.2'}|${acc.lang_code || 'en'}|${acc.system_lang_code || 'en-US'}`;
        usedFingerprints.add(key);
      }
    }

    console.log(`[regenerate-fingerprints] Preserving ${usedFingerprints.size} existing unique fingerprints`);

    // Generate new unique fingerprints for duplicate accounts
    const updates: { id: string; fingerprint: ReturnType<typeof generateUniqueFingerprint> }[] = [];
    
    for (const accountId of accountsToUpdate) {
      const fingerprint = generateUniqueFingerprint(usedFingerprints);
      updates.push({ id: accountId, fingerprint });
    }

    // Apply updates in batches
    const BATCH_SIZE = 50;
    let updatedCount = 0;

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(updates.length / BATCH_SIZE);
      
      console.log(`[regenerate-fingerprints] Processing batch ${batchNum}/${totalBatches} (${batch.length} accounts)`);
      
      await Promise.all(
        batch.map(({ id, fingerprint }) =>
          supabase
            .from('telegram_accounts')
            .update({
              device_model: fingerprint.device_model,
              system_version: fingerprint.system_version,
              app_version: fingerprint.app_version,
              lang_code: fingerprint.lang_code,
              system_lang_code: fingerprint.system_lang_code,
              build_id: fingerprint.build_id,
            })
            .eq('id', id)
        )
      );
      
      updatedCount += batch.length;
    }

    console.log(`[regenerate-fingerprints] Successfully updated ${updatedCount} accounts`);

    return new Response(
      JSON.stringify({ 
        success: true,
        message: `Regenerated unique fingerprints for ${updatedCount} accounts`,
        total: allAccounts.length,
        updated: updatedCount,
        duplicatesBefore: accountsToUpdate.length
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    const error = err as Error;
    console.error('[regenerate-fingerprints] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
