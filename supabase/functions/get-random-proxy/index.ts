import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let excludeHost: string | null = null;
    
    try {
      const body = await req.json();
      excludeHost = body.exclude_host || null;
    } catch {
      // No body or invalid JSON, that's fine
    }

    // Build query for active proxies
    let query = supabase
      .from("proxies")
      .select("id, host, port, username, password, proxy_type, country")
      .eq("status", "active");

    // Exclude the failed proxy host if provided
    if (excludeHost) {
      query = query.neq("host", excludeHost);
    }

    const { data: proxies, error } = await query;

    if (error) {
      console.error("Error fetching proxies:", error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch proxies", proxy: null }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!proxies || proxies.length === 0) {
      console.log("No active proxies available");
      return new Response(
        JSON.stringify({ proxy: null, message: "No active proxies available" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Pick a random proxy
    const randomIndex = Math.floor(Math.random() * proxies.length);
    const randomProxy = proxies[randomIndex];

    console.log(`Returning random proxy: ${randomProxy.host}:${randomProxy.port} (${proxies.length} available)`);

    return new Response(
      JSON.stringify({
        proxy: {
          id: randomProxy.id,
          host: randomProxy.host,
          port: randomProxy.port,
          username: randomProxy.username,
          password: randomProxy.password,
          proxy_type: randomProxy.proxy_type || "socks5",
          country: randomProxy.country,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", proxy: null }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
