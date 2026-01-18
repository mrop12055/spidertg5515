import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Country code to flag emoji mapping
const getCountryFlag = (countryCode: string): string => {
  if (!countryCode || countryCode.length !== 2) return '🌍';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
};

// Helper to create a timeout promise
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMsg)), ms)
    )
  ]);
}

// Test proxy by making actual TCP connection with timeout
async function testProxyConnection(proxy: {
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxy_type: string;
}): Promise<{ success: boolean; responseTime: number; ip?: string; country?: string; error?: string }> {
  const startTime = Date.now();
  const CONNECTION_TIMEOUT_MS = 15000; // 15 second timeout per proxy (was 10s)
  
  try {
    // Try a simple TCP connection with timeout to verify the proxy is reachable
    const conn = await withTimeout(
      Deno.connect({
        hostname: proxy.host,
        port: proxy.port,
      }),
      CONNECTION_TIMEOUT_MS,
      'Connection timeout'
    );
    conn.close();
    
    const responseTime = Date.now() - startTime;
    
    // Extract country from password if it contains country code like "IN", "US"
    let detectedCountry: string | undefined;
    const passwordMatch = proxy.password?.match(/-([A-Z]{2})-/);
    if (passwordMatch) {
      detectedCountry = passwordMatch[1];
    }
    
    return {
      success: true,
      responseTime,
      country: detectedCountry,
    };
  } catch (e) {
    const responseTime = Date.now() - startTime;
    const errorMessage = e instanceof Error ? e.message : 'Connection failed';
    
    return {
      success: false,
      responseTime,
      error: errorMessage,
    };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { proxy_ids, auto_detect_country = true } = await req.json();

    if (!proxy_ids || !Array.isArray(proxy_ids)) {
      return new Response(
        JSON.stringify({ error: 'proxy_ids array required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Testing ${proxy_ids.length} proxies (country detection: ${auto_detect_country})...`);

    // Fetch proxies in batches to avoid "Bad Request" error with large IN clauses
    const fetchBatchSize = 100;
    const proxies: any[] = [];
    
    for (let i = 0; i < proxy_ids.length; i += fetchBatchSize) {
      const batchIds = proxy_ids.slice(i, i + fetchBatchSize);
      const { data: batchProxies, error: fetchError } = await supabase
        .from('proxies')
        .select('*')
        .in('id', batchIds);

      if (fetchError) {
        console.error('Error fetching proxies batch:', fetchError);
        throw fetchError;
      }
      
      if (batchProxies) {
        proxies.push(...batchProxies);
      }
    }
    
    console.log(`Fetched ${proxies.length} proxies to test`);

    // Test proxies in batches of 50 to avoid overwhelming the proxy provider
    // (All proxies often share the same host like gate.kookeey.info)
    const TEST_BATCH_SIZE = 50;
    const results: any[] = [];
    
    for (let i = 0; i < proxies.length; i += TEST_BATCH_SIZE) {
      const batch = proxies.slice(i, i + TEST_BATCH_SIZE);
      console.log(`Testing batch ${Math.floor(i / TEST_BATCH_SIZE) + 1}/${Math.ceil(proxies.length / TEST_BATCH_SIZE)} (${batch.length} proxies)...`);
      
      const batchResults = await Promise.all(
        batch.map(async (proxy) => {
          const testResult = await testProxyConnection({
            host: proxy.host,
            port: proxy.port,
            username: proxy.username || undefined,
            password: proxy.password || undefined,
            proxy_type: proxy.proxy_type || 'socks5',
          });

          const countryFlag = testResult.country ? getCountryFlag(testResult.country) : undefined;

          // Update proxy status in database
          const updateData: Record<string, unknown> = {
            status: testResult.success ? 'active' : 'error',
            response_time: testResult.responseTime,
            last_checked: new Date().toISOString(),
          };

          if (testResult.country && auto_detect_country) {
            updateData.detected_country = testResult.country;
          }

          await supabase
            .from('proxies')
            .update(updateData)
            .eq('id', proxy.id);

          return {
            id: proxy.id,
            success: testResult.success,
            responseTime: testResult.responseTime,
            ip: testResult.ip,
            country: testResult.country,
            countryFlag,
            error: testResult.success ? undefined : testResult.error,
          };
        })
      );
      
      results.push(...batchResults);
    }

    const workingCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    console.log(`Testing complete: ${workingCount} working, ${failedCount} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        results,
        summary: { working: workingCount, failed: failedCount }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in test-proxies:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
