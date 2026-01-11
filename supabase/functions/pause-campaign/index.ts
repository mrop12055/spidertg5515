import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Atomic pause-campaign function
 * 
 * This function atomically:
 * 1. Updates campaign status to 'paused'
 * 2. Resets ALL 'sending' recipients to 'queued' (prevents stuck tasks)
 * 3. Resets ALL 'pending' recipients to 'queued' (clean restart on resume)
 * 4. Clears assignment fields (sent_by_account_id, api_credential_id, scheduled_at)
 * 
 * This prevents the "stuck sending" problem when pausing campaigns.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json();
    const { campaign_id } = body;

    if (!campaign_id) {
      return new Response(
        JSON.stringify({ error: "campaign_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[pause-campaign] Pausing campaign ${campaign_id}`);

    // Step 1: Update campaign status to 'paused'
    const { error: campaignError } = await supabase
      .from("campaigns")
      .update({ 
        status: "paused", 
        updated_at: new Date().toISOString() 
      })
      .eq("id", campaign_id);

    if (campaignError) {
      console.error(`[pause-campaign] Failed to update campaign status:`, campaignError);
      return new Response(
        JSON.stringify({ error: "Failed to pause campaign", details: campaignError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 2: Count recipients in each status for logging
    const [{ count: sendingCount }, { count: pendingCount }] = await Promise.all([
      supabase
        .from("campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaign_id)
        .eq("status", "sending"),
      supabase
        .from("campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaign_id)
        .eq("status", "pending"),
    ]);

    console.log(`[pause-campaign] Found ${sendingCount || 0} sending, ${pendingCount || 0} pending recipients`);

    // Step 3: Reset ALL 'sending' and 'pending' recipients to 'queued'
    // This ensures a clean restart when campaign is resumed
    const resetPromises: Promise<any>[] = [];

    // Reset 'sending' recipients (these were in-progress but not completed)
    if ((sendingCount || 0) > 0) {
      resetPromises.push(
        (async () => {
          return await supabase
            .from("campaign_recipients")
            .update({
              status: "queued",
              sent_by_account_id: null,
              api_credential_id: null,
              scheduled_at: null,
              failed_reason: null,
            })
            .eq("campaign_id", campaign_id)
            .eq("status", "sending");
        })()
      );
    }

    // Reset 'pending' recipients (these were assigned but not sent)
    if ((pendingCount || 0) > 0) {
      resetPromises.push(
        (async () => {
          return await supabase
            .from("campaign_recipients")
            .update({
              status: "queued",
              sent_by_account_id: null,
              api_credential_id: null,
              scheduled_at: null,
              failed_reason: null,
            })
            .eq("campaign_id", campaign_id)
            .eq("status", "pending");
        })()
      );
    }

    // Execute all resets in parallel
    if (resetPromises.length > 0) {
      const results = await Promise.all(resetPromises);
      const errors = results.filter(r => r.error);
      if (errors.length > 0) {
        console.error(`[pause-campaign] Some resets failed:`, errors.map(e => e.error?.message));
      }
    }

    const totalReset = (sendingCount || 0) + (pendingCount || 0);
    console.log(`[pause-campaign] Campaign ${campaign_id} paused. Reset ${totalReset} recipients to queued.`);

    return new Response(
      JSON.stringify({
        success: true,
        campaign_id,
        sending_reset: sendingCount || 0,
        pending_reset: pendingCount || 0,
        total_reset: totalReset,
        message: `Campaign paused. ${totalReset} recipients reset to queued for clean restart.`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error(`[pause-campaign] Error:`, error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error?.message || String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
