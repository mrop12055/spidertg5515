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

// India-specific language distribution (weighted for authenticity)
const INDIA_LANGUAGES = [
  { code: "en", system: "en-IN", weight: 54 },    // English (India) - most common
  { code: "hi", system: "hi-IN", weight: 35 },    // Hindi - second most common
  { code: "ta", system: "ta-IN", weight: 3 },     // Tamil
  { code: "te", system: "te-IN", weight: 3 },     // Telugu
  { code: "mr", system: "mr-IN", weight: 2 },     // Marathi
  { code: "bn", system: "bn-IN", weight: 2 },     // Bengali
  { code: "gu", system: "gu-IN", weight: 1 },     // Gujarati
];

// India-specific popular devices (Samsung, Xiaomi, Realme, OnePlus dominate)
const INDIA_POPULAR_DEVICES = [
  // Samsung - 20% market share
  { model: "Samsung SM-A556B", versions: ["Android 14", "Android 15"], weight: 8 },
  { model: "Samsung SM-A546B", versions: ["Android 13", "Android 14"], weight: 7 },
  { model: "Samsung SM-A536B", versions: ["Android 12", "Android 13", "Android 14"], weight: 6 },
  { model: "Samsung SM-A346B", versions: ["Android 13", "Android 14"], weight: 5 },
  { model: "Samsung SM-A256B", versions: ["Android 13", "Android 14"], weight: 4 },
  { model: "Samsung SM-M546B", versions: ["Android 14"], weight: 4 },
  { model: "Samsung SM-S928B", versions: ["Android 14", "Android 15"], weight: 3 },
  { model: "Samsung SM-S918B", versions: ["Android 13", "Android 14"], weight: 3 },
  // Xiaomi/Redmi/POCO - 18% market share
  { model: "Redmi Note 13 Pro+", versions: ["Android 13", "Android 14"], weight: 7 },
  { model: "Redmi Note 13 Pro", versions: ["Android 13", "Android 14"], weight: 6 },
  { model: "Redmi Note 12 Pro", versions: ["Android 12", "Android 13"], weight: 5 },
  { model: "Redmi 13C", versions: ["Android 13", "Android 14"], weight: 5 },
  { model: "POCO F5 Pro", versions: ["Android 13", "Android 14"], weight: 4 },
  { model: "POCO X6 Pro", versions: ["Android 14"], weight: 4 },
  { model: "Xiaomi 14", versions: ["Android 14"], weight: 3 },
  // Realme - 12% market share  
  { model: "realme GT 5 Pro", versions: ["Android 14"], weight: 4 },
  { model: "realme 12 Pro+", versions: ["Android 14"], weight: 4 },
  { model: "realme Narzo 70 Pro", versions: ["Android 14"], weight: 4 },
  { model: "realme 11 Pro", versions: ["Android 13", "Android 14"], weight: 3 },
  // OnePlus - 5% market share (premium)
  { model: "OnePlus 12", versions: ["Android 14"], weight: 3 },
  { model: "OnePlus 11", versions: ["Android 13", "Android 14"], weight: 3 },
  { model: "OnePlus Nord 3", versions: ["Android 13", "Android 14"], weight: 3 },
  { model: "OnePlus Nord CE 3", versions: ["Android 13", "Android 14"], weight: 2 },
  // Vivo - 15% market share
  { model: "vivo V30 Pro", versions: ["Android 14"], weight: 4 },
  { model: "vivo V29", versions: ["Android 13", "Android 14"], weight: 3 },
  { model: "vivo T2 Pro", versions: ["Android 13", "Android 14"], weight: 3 },
  { model: "vivo Y100", versions: ["Android 13", "Android 14"], weight: 3 },
  // OPPO - 10% market share
  { model: "OPPO Reno 11 Pro", versions: ["Android 14"], weight: 3 },
  { model: "OPPO Reno 10 Pro", versions: ["Android 13", "Android 14"], weight: 3 },
  { model: "OPPO F25 Pro", versions: ["Android 14"], weight: 2 },
  // iQOO (Vivo sub-brand popular in India)
  { model: "iQOO 12", versions: ["Android 14"], weight: 2 },
  { model: "iQOO Neo 9 Pro", versions: ["Android 14"], weight: 2 },
  // Motorola
  { model: "Motorola Edge 50 Pro", versions: ["Android 14"], weight: 2 },
  { model: "Motorola G84", versions: ["Android 13", "Android 14"], weight: 2 },
  // Nothing
  { model: "Nothing Phone (2)", versions: ["Android 13", "Android 14"], weight: 2 },
  // Google Pixel (small but growing in India)
  { model: "Pixel 8", versions: ["Android 14", "Android 15"], weight: 2 },
  { model: "Pixel 7a", versions: ["Android 13", "Android 14"], weight: 2 },
];

// Helper to select weighted random item
function weightedRandomChoice<T extends { weight: number }>(items: T[]): T {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;
  for (const item of items) {
    random -= item.weight;
    if (random <= 0) return item;
  }
  return items[items.length - 1];
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Track used fingerprints to ensure uniqueness within batch
const usedFingerprints = new Set<string>();

// Dynamic API System: No stored API credentials needed
// Each task gets fresh unique api_id + api_hash generated at runtime

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
    const major = Math.floor(Math.random() * 6) + 1;
    const year = randomChoice(['A', 'B', 'C', 'D']);
    const month = randomChoice(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
    const revision = randomChoice(['A', 'B', 'C', '1', '2', '3']);
    return `${modelCode}${region}${major}${year}${randomLetters(1)}${month}${revision}`;
  }
  
  // Google Pixel format: AP2A.240805.005
  if (deviceModel.includes('Pixel')) {
    const prefixes = ['AP2A', 'AP1A', 'TQ3A', 'UQ1A', 'AP4A'];
    const prefix = randomChoice(prefixes);
    const year = 24 + Math.floor(Math.random() * 2);
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
    const patch = String(Math.floor(Math.random() * 10)).padStart(3, '0');
    return `${prefix}.${year}${month}${day}.${patch}`;
  }
  
  // Xiaomi/Redmi/POCO format: V14.0.23.11.28.DEV
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
  
  // OnePlus format: KB2003_11_C.58
  if (deviceModel.includes('OnePlus')) {
    const codes = ['KB2003', 'LE2123', 'IN2023', 'NE2213', 'CPH2449'];
    const code = randomChoice(codes);
    const android = systemVersion.includes('14') ? '14' : systemVersion.includes('13') ? '13' : '12';
    const letter = randomChoice(['A', 'B', 'C', 'F']);
    const patch = Math.floor(Math.random() * 60) + 20;
    return `${code}_${android}.${letter}.${patch}`;
  }
  
  // iPhone format: 21A329
  if (deviceModel.includes('iPhone')) {
    const major = systemVersion.includes('18') ? 22 : systemVersion.includes('17') ? 21 : 20;
    const letters = 'ABCDEFGHIJ';
    const letter = letters[Math.floor(Math.random() * letters.length)];
    const build = Math.floor(Math.random() * 400) + 50;
    return `${major}${letter}${build}`;
  }
  
  // OPPO/vivo/realme format: RMX3630_11.C.28
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
  
  // iQOO format (Vivo sub-brand): V2254A_14.0.12.3.W10.V000L1
  if (deviceModel.includes('iQOO')) {
    const codes = ['V2254A', 'V2243A', 'V2217A', 'V2269A'];
    const code = randomChoice(codes);
    const android = systemVersion.includes('14') ? '14' : '13';
    const build = Math.floor(Math.random() * 20) + 1;
    const patch = Math.floor(Math.random() * 5) + 1;
    return `${code}_${android}.0.${build}.${patch}.W10.V000L1`;
  }
  
  // Generic Android fallback
  const androidVersion = systemVersion.replace('Android ', '');
  return `${androidVersion}.${randomHex(4)}.${Math.floor(Math.random() * 100)}`;
}

// Generate ADVANCED India-specific unique fingerprint
function generateUniqueFingerprint(existingFingerprints: Set<string>, preferredClientType?: string): {
  device_model: string;
  system_version: string;
  app_version: string;
  lang_code: string;
  system_lang_code: string;
  build_id: string;
} {
  let attempts = 0;
  const maxAttempts = 200; // Increased for better uniqueness
  
  while (attempts < maxAttempts) {
    let device_model: string;
    let system_version: string;
    let lang_code: string;
    let system_lang_code: string;
    
    // For iOS preference, use iOS devices (rare in India market)
    if (preferredClientType === 'ios' || preferredClientType === 'macos') {
      const device = randomChoice(IOS_DEVICES);
      device_model = device.model;
      system_version = randomChoice(device.versions);
      // iOS users in India still use English mostly
      lang_code = "en";
      system_lang_code = "en-IN";
    } else {
      // USE INDIA-SPECIFIC DEVICES (weighted by market share)
      const device = weightedRandomChoice(INDIA_POPULAR_DEVICES);
      device_model = device.model;
      system_version = randomChoice(device.versions);
      
      // USE INDIA-SPECIFIC LANGUAGE (weighted distribution)
      const langChoice = weightedRandomChoice(INDIA_LANGUAGES);
      lang_code = langChoice.code;
      system_lang_code = langChoice.system;
    }
    
    const app_version = randomChoice(TELEGRAM_VERSIONS);
    const build_id = generateBuildId(device_model, system_version);
    
    // Create unique key for this fingerprint (including build_id for 100% uniqueness)
    const fingerprintKey = `${device_model}|${system_version}|${app_version}|${lang_code}|${system_lang_code}|${build_id}`;
    
    // Check if this fingerprint is already used
    if (!existingFingerprints.has(fingerprintKey) && !usedFingerprints.has(fingerprintKey)) {
      usedFingerprints.add(fingerprintKey);
      console.log(`[fingerprint] Generated India fingerprint: ${device_model} | ${system_version} | ${lang_code}-${system_lang_code}`);
      return { device_model, system_version, app_version, lang_code, system_lang_code, build_id };
    }
    
    attempts++;
  }
  
  // Fallback: generate with random suffix to ensure uniqueness
  const device = weightedRandomChoice(INDIA_POPULAR_DEVICES);
  const system_version = randomChoice(device.versions);
  const app_version = `${randomChoice(TELEGRAM_VERSIONS)}.${Math.floor(Math.random() * 100)}`;
  const build_id = generateBuildId(device.model, system_version) + Math.floor(Math.random() * 1000);
  const langChoice = weightedRandomChoice(INDIA_LANGUAGES);
  
  console.log(`[fingerprint] Fallback India fingerprint: ${device.model} | ${system_version} | ${langChoice.code}-${langChoice.system}`);
  
  return {
    device_model: device.model,
    system_version,
    app_version,
    lang_code: langChoice.code,
    system_lang_code: langChoice.system,
    build_id
  };
}

// Dynamic API System: selectApiCredentialFromQueue function removed
// Each task now gets a fresh unique api_id + api_hash generated at runtime

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

    // Dynamic API System: No need to fetch/assign API credentials
    // Each task will get a fresh unique api_id + api_hash generated at runtime
    console.log(`[process-account-upload] Using dynamic per-request API system (no stored credentials needed)`);

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
        
        // Dynamic API System: No API credential assignment needed
        // Each task will get a fresh unique api_id + api_hash generated at runtime
        
        // Generate UNIQUE device fingerprint
        const fingerprint = generateUniqueFingerprint(
          existingFingerprints, 
          undefined
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
            warmup_phase: 0,
            warmup_started_at: new Date().toISOString(),
          }),
          ...(existing?.device_model ? {} : {
            device_model: fingerprint.device_model,
            system_version: fingerprint.system_version,
            app_version: fingerprint.app_version,
            lang_code: fingerprint.lang_code,
            system_lang_code: fingerprint.system_lang_code,
            build_id: fingerprint.build_id,
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
            build_id: fingerprint.build_id,
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

    // Batch insert new accounts using upsert for speed (skip duplicates)
    const BATCH_SIZE = 100;
    for (let i = 0; i < accountsToInsert.length; i += BATCH_SIZE) {
      const batch = accountsToInsert.slice(i, i + BATCH_SIZE);
      const { data: insertedBatch, error: insertError } = await supabase
        .from('telegram_accounts')
        .upsert(batch, { 
          onConflict: 'phone_number',
          ignoreDuplicates: true // Skip duplicates instead of updating
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
