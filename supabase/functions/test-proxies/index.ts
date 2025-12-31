import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { proxy_ids } = await req.json();

    if (!proxy_ids || !Array.isArray(proxy_ids)) {
      return new Response(
        JSON.stringify({ error: 'proxy_ids array required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Testing ${proxy_ids.length} proxies...`);

    // Fetch proxies
    const { data: proxies, error: fetchError } = await supabase
      .from('proxies')
      .select('*')
      .in('id', proxy_ids);

    if (fetchError) {
      console.error('Error fetching proxies:', fetchError);
      throw fetchError;
    }

    const results: { id: string; success: boolean; responseTime?: number; error?: string }[] = [];

    for (const proxy of proxies || []) {
      const startTime = Date.now();
      let success = false;
      let errorMessage = '';
      let responseTime = 0;

      try {
        // Test proxy by making a simple HTTP request through it
        // We'll try to fetch a simple endpoint to test connectivity
        const testUrl = 'https://api.ipify.org?format=json';
        
        // Note: Deno doesn't have native proxy support in fetch
        // So we'll do a direct TCP connection test to check if the proxy port is open
        const conn = await Deno.connect({
          hostname: proxy.host,
          port: proxy.port,
        });
        
        responseTime = Date.now() - startTime;
        
        // If we connected successfully, the proxy is reachable
        conn.close();
        success = true;
        
        console.log(`Proxy ${proxy.host}:${proxy.port} - Connected in ${responseTime}ms`);
      } catch (e) {
        responseTime = Date.now() - startTime;
        errorMessage = e instanceof Error ? e.message : 'Connection failed';
        console.log(`Proxy ${proxy.host}:${proxy.port} - Failed: ${errorMessage}`);
      }

      results.push({
        id: proxy.id,
        success,
        responseTime,
        error: success ? undefined : errorMessage,
      });

      // Update proxy status in database
      const { error: updateError } = await supabase
        .from('proxies')
        .update({
          status: success ? 'active' : 'error',
          response_time: responseTime,
          last_checked: new Date().toISOString(),
        })
        .eq('id', proxy.id);

      if (updateError) {
        console.error(`Error updating proxy ${proxy.id}:`, updateError);
      }
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
