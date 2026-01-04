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

    console.log("Stopping warmup chat...");

    // 1. Stop all active sessions
    const { data: sessions, error: sessionsError } = await supabase
      .from("warmup_sessions")
      .update({ status: "stopped", stopped_at: new Date().toISOString() })
      .eq("status", "active")
      .select();

    if (sessionsError) {
      throw new Error(`Failed to stop sessions: ${sessionsError.message}`);
    }

    // 2. Cancel all pending messages
    const { data: cancelledMessages, error: messagesError } = await supabase
      .from("warmup_messages")
      .update({ status: "cancelled" })
      .eq("status", "pending")
      .select();

    if (messagesError) {
      throw new Error(`Failed to cancel messages: ${messagesError.message}`);
    }

    // 3. Mark all pairs as completed
    const { error: pairsError } = await supabase
      .from("warmup_pairs")
      .update({ status: "completed" })
      .eq("status", "active");

    if (pairsError) {
      throw new Error(`Failed to complete pairs: ${pairsError.message}`);
    }

    console.log(`Stopped ${sessions?.length || 0} sessions, cancelled ${cancelledMessages?.length || 0} messages`);

    return new Response(
      JSON.stringify({
        success: true,
        sessions_stopped: sessions?.length || 0,
        messages_cancelled: cancelledMessages?.length || 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error stopping warmup:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
