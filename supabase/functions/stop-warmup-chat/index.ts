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

    // Check if stopping a specific pair
    let pairId: string | null = null;
    try {
      const body = await req.json();
      pairId = body?.pairId || null;
    } catch {
      // No body, stop all
    }

    if (pairId) {
      // Stop a specific pair only
      console.log("Stopping warmup for pair:", pairId);

      // Cancel pending messages for this pair
      const { data: cancelledMessages, error: messagesError } = await supabase
        .from("warmup_messages")
        .update({ status: "cancelled" })
        .eq("pair_id", pairId)
        .eq("status", "pending")
        .select();

      if (messagesError) {
        throw new Error(`Failed to cancel messages: ${messagesError.message}`);
      }

      // Mark pair as completed
      const { error: pairError } = await supabase
        .from("warmup_pairs")
        .update({ status: "completed" })
        .eq("id", pairId);

      if (pairError) {
        throw new Error(`Failed to complete pair: ${pairError.message}`);
      }

      // Check if there are any remaining active pairs in the session
      const { data: remainingPairs } = await supabase
        .from("warmup_pairs")
        .select("id, session_id")
        .eq("status", "active");

      // If no remaining active pairs, stop the session
      if (!remainingPairs || remainingPairs.length === 0) {
        await supabase
          .from("warmup_sessions")
          .update({ status: "stopped", stopped_at: new Date().toISOString() })
          .eq("status", "active");
        console.log("No remaining active pairs, stopped session");
      }

      console.log(`Pair ${pairId} stopped, cancelled ${cancelledMessages?.length || 0} messages`);

      return new Response(
        JSON.stringify({
          success: true,
          pair_stopped: pairId,
          messages_cancelled: cancelledMessages?.length || 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Stop ALL warmup
    console.log("Stopping all warmup chats...");

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

    // 4. Clean up old messages (keep only last 50 of each status)
    console.log("Cleaning up old warmup messages...");
    
    // Delete old sent messages (older than newest 50)
    const { data: sentToKeep } = await supabase
      .from("warmup_messages")
      .select("id")
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
      .limit(50);
    
    const sentKeepIds = sentToKeep?.map(m => m.id) || [];
    if (sentKeepIds.length === 50) {
      // Only delete if we have 50+ sent messages
      await supabase
        .from("warmup_messages")
        .delete()
        .eq("status", "sent")
        .not("id", "in", `(${sentKeepIds.join(",")})`);
      console.log("Cleaned up old sent messages");
    }

    // Delete all cancelled messages (they're not useful)
    await supabase
      .from("warmup_messages")
      .delete()
      .eq("status", "cancelled");
    console.log("Deleted cancelled messages");

    // Keep only last 50 failed messages
    const { data: failedToKeep } = await supabase
      .from("warmup_messages")
      .select("id")
      .eq("status", "failed")
      .order("scheduled_at", { ascending: false })
      .limit(50);
    
    const failedKeepIds = failedToKeep?.map(m => m.id) || [];
    if (failedKeepIds.length === 50) {
      await supabase
        .from("warmup_messages")
        .delete()
        .eq("status", "failed")
        .not("id", "in", `(${failedKeepIds.join(",")})`);
      console.log("Cleaned up old failed messages");
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
