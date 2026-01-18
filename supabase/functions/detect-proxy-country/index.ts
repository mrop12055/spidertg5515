import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json().catch(() => ({}));
    const { proxy_ids } = body;

    console.log("[detect-proxy-country] Starting country detection");

    // Get proxies to check
    let proxiesQuery = supabase
      .from("proxies")
      .select("id, host, port, proxy_type, username, password, detected_country")
      .eq("status", "active");

    if (proxy_ids && proxy_ids.length > 0) {
      proxiesQuery = proxiesQuery.in("id", proxy_ids);
    } else {
      // Only check proxies without detected country
      proxiesQuery = proxiesQuery.is("detected_country", null);
    }

    const { data: proxies, error: proxiesError } = await proxiesQuery.limit(20);

    if (proxiesError) {
      throw proxiesError;
    }

    if (!proxies || proxies.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "No proxies to check",
        checked: 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[detect-proxy-country] Checking ${proxies.length} proxies`);

    const results: { id: string; country: string | null; error?: string }[] = [];

    for (const proxy of proxies) {
      try {
        // Use ip-api.com to detect country (free service)
        // First, we need to resolve the proxy IP
        let ipToCheck = proxy.host;
        
        // If host is not an IP, try to use a geo lookup service
        // For simplicity, we'll try to get country from the proxy's external IP
        // by making a request through the proxy to an IP detection service
        
        // Note: This is a simplified approach. In production, you'd want to:
        // 1. Actually route traffic through the proxy to get its exit IP
        // 2. Use a paid geo-IP service for accuracy
        
        // For now, we'll do a basic IP lookup if the host looks like an IP
        const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
        
        if (ipPattern.test(proxy.host)) {
          ipToCheck = proxy.host;
        } else {
          // For domains, we'd need to resolve them or use a different approach
          // For now, skip domain-based proxies
          results.push({ id: proxy.id, country: null, error: "Domain-based proxy - manual check needed" });
          continue;
        }

        // Query ip-api.com for geolocation (10s timeout, was 5s)
        const geoResponse = await fetch(`http://ip-api.com/json/${ipToCheck}?fields=status,country,countryCode`, {
          signal: AbortSignal.timeout(10000),
        });

        if (geoResponse.ok) {
          const geoData = await geoResponse.json();
          
          if (geoData.status === "success" && geoData.countryCode) {
            // Update proxy with detected country
            await supabase
              .from("proxies")
              .update({ 
                detected_country: geoData.countryCode,
                country: geoData.country || geoData.countryCode,
              })
              .eq("id", proxy.id);

            results.push({ id: proxy.id, country: geoData.countryCode });
            console.log(`[detect-proxy-country] Proxy ${proxy.host}: ${geoData.countryCode}`);
          } else {
            results.push({ id: proxy.id, country: null, error: "Geo lookup failed" });
          }
        } else {
          results.push({ id: proxy.id, country: null, error: `HTTP ${geoResponse.status}` });
        }

        // Rate limit for ip-api.com (45 requests per minute)
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (error) {
        console.error(`[detect-proxy-country] Error checking proxy ${proxy.id}:`, error);
        results.push({ id: proxy.id, country: null, error: String(error) });
      }
    }

    // Check for geo mismatches with accounts
    const { data: accountsWithProxies } = await supabase
      .from("telegram_accounts")
      .select("id, phone_country, proxy_id, proxies!inner(detected_country)")
      .not("proxy_id", "is", null)
      .not("phone_country", "is", null);

    let mismatchCount = 0;
    if (accountsWithProxies) {
      for (const account of accountsWithProxies as any[]) {
        const proxyCountry = account.proxies?.detected_country;
        const phoneCountry = account.phone_country;
        
        if (proxyCountry && phoneCountry && proxyCountry !== phoneCountry) {
          // Mark as geo mismatch
          await supabase
            .from("telegram_accounts")
            .update({ geo_mismatch: true })
            .eq("id", account.id);
          mismatchCount++;
        } else if (proxyCountry && phoneCountry && proxyCountry === phoneCountry) {
          // Clear mismatch flag
          await supabase
            .from("telegram_accounts")
            .update({ geo_mismatch: false })
            .eq("id", account.id);
        }
      }
    }

    const successCount = results.filter(r => r.country).length;

    return new Response(JSON.stringify({
      success: true,
      message: `Detected country for ${successCount}/${proxies.length} proxies`,
      checked: proxies.length,
      detected: successCount,
      geo_mismatches: mismatchCount,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[detect-proxy-country] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
