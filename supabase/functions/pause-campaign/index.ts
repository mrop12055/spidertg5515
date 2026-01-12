import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Fast atomic pause-campaign function
 * 
 * This function:
 * 1. Updates campaign status to 'paused' immediately
 * 2. Returns response right away (fast UI feedback)
 * 3. Resets recipients in background (doesn't block response)
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

    // Step 1: Update campaign status to 'paused' immediately
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

    // Background task: Reset recipients after response is sent
    const resetRecipients = async () => {
      try {
        // Reset ALL 'sending' and 'pending' recipients to 'queued' in parallel
        const [sendingResult, pendingResult] = await Promise.all([
          supabase
            .from("campaign_recipients")
            .update({
              status: "queued",
              sent_by_account_id: null,
              api_credential_id: null,
              scheduled_at: null,
              failed_reason: null,
            })
            .eq("campaign_id", campaign_id)
            .eq("status", "sending"),
          supabase
            .from("campaign_recipients")
            .update({
              status: "queued",
              sent_by_account_id: null,
              api_credential_id: null,
              scheduled_at: null,
              failed_reason: null,
            })
            .eq("campaign_id", campaign_id)
            .eq("status", "pending"),
        ]);

        if (sendingResult.error) {
          console.error(`[pause-campaign] Error resetting sending:`, sendingResult.error);
        }
        if (pendingResult.error) {
          console.error(`[pause-campaign] Error resetting pending:`, pendingResult.error);
        }
        
        console.log(`[pause-campaign] Background: Reset recipients completed for campaign ${campaign_id}`);
      } catch (err) {
        console.error(`[pause-campaign] Background reset error:`, err);
      }
    };

    // Start background task without waiting
    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    (globalThis as any).EdgeRuntime?.waitUntil?.(resetRecipients()) ?? resetRecipients();

    console.log(`[pause-campaign] Campaign ${campaign_id} paused. Resetting recipients in background.`);

    // Return immediately - don't wait for recipient resets
    return new Response(
      JSON.stringify({
        success: true,
        campaign_id,
        message: "Campaign paused successfully",
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
