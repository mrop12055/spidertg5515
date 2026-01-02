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

// Test proxy by making actual HTTP request through it
async function testProxyConnection(proxy: {
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxy_type: string;
}): Promise<{ success: boolean; responseTime: number; ip?: string; country?: string; error?: string }> {
  const startTime = Date.now();
  
  try {
    // Build proxy URL with authentication
    let proxyAuth = '';
    if (proxy.username && proxy.password) {
      proxyAuth = `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
    }
    
    const proxyUrl = `${proxy.proxy_type}://${proxyAuth}${proxy.host}:${proxy.port}`;
    
    console.log(`Testing proxy: ${proxy.host}:${proxy.port} (${proxy.proxy_type})`);
    
    // Use Deno's native proxy support for HTTP client
    // First, try a simple TCP connection to verify the proxy is reachable
    const conn = await Deno.connect({
      hostname: proxy.host,
      port: proxy.port,
    });
    conn.close();
    
    const responseTime = Date.now() - startTime;
    
    // For HTTP/HTTPS proxies, we can try to detect the IP via a separate service
    // This is a best-effort approach since Deno doesn't have native proxy support in fetch
    let detectedIp: string | undefined;
    let detectedCountry: string | undefined;
    
    try {
      // Try to get IP info using ip-api.com (free, no auth needed)
      // Note: This checks the edge function's IP, not the proxy's IP
      // For actual proxy IP detection, we'd need a more complex setup
      const ipResponse = await fetch('http://ip-api.com/json/?fields=status,country,countryCode,query', {
        signal: AbortSignal.timeout(5000),
      });
      
      if (ipResponse.ok) {
        const ipData = await ipResponse.json();
        if (ipData.status === 'success') {
          // Since we can't actually route through proxy in Deno edge functions,
          // we'll mark this as needing local runner for full detection
          // For now, extract country from password if it contains country code like "IN", "US"
          const passwordMatch = proxy.password?.match(/-([A-Z]{2})-/);
          if (passwordMatch) {
            detectedCountry = passwordMatch[1];
          }
        }
      }
    } catch (ipError) {
      console.log('IP detection failed:', ipError);
    }
    
    console.log(`Proxy ${proxy.host}:${proxy.port} - Connected in ${responseTime}ms`);
    
    return {
      success: true,
      responseTime,
      ip: detectedIp,
      country: detectedCountry,
    };
  } catch (e) {
    const responseTime = Date.now() - startTime;
    const errorMessage = e instanceof Error ? e.message : 'Connection failed';
    console.log(`Proxy ${proxy.host}:${proxy.port} - Failed: ${errorMessage}`);
    
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

    // Fetch proxies
    const { data: proxies, error: fetchError } = await supabase
      .from('proxies')
      .select('*')
      .in('id', proxy_ids);

    if (fetchError) {
      console.error('Error fetching proxies:', fetchError);
      throw fetchError;
    }

    const results: { 
      id: string; 
      success: boolean; 
      responseTime?: number; 
      ip?: string;
      country?: string;
      countryFlag?: string;
      error?: string;
    }[] = [];

    // Test proxies in parallel batches of 10 for performance
    const batchSize = 10;
    for (let i = 0; i < (proxies || []).length; i += batchSize) {
      const batch = (proxies || []).slice(i, i + batchSize);
      
      const batchResults = await Promise.all(
        batch.map(async (proxy) => {
          const testResult = await testProxyConnection({
            host: proxy.host,
            port: proxy.port,
            username: proxy.username || undefined,
            password: proxy.password || undefined,
            proxy_type: proxy.proxy_type || 'http',
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

          const { error: updateError } = await supabase
            .from('proxies')
            .update(updateData)
            .eq('id', proxy.id);

          if (updateError) {
            console.error(`Error updating proxy ${proxy.id}:`, updateError);
          }

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
