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
    const dryRun = body.dry_run !== false; // Default to dry run for safety

    console.log(`[cleanup-duplicate-messages] Starting cleanup (dry_run=${dryRun})`);

    // Find duplicate incoming messages by telegram_message_id + account_id
    // We'll keep the first one (oldest created_at) and delete the rest
    const { data: duplicates, error: findError } = await supabase
      .from("messages")
      .select("id, account_id, telegram_message_id, content, created_at, conversation_id")
      .eq("direction", "incoming")
      .not("telegram_message_id", "is", null)
      .order("created_at", { ascending: true });

    if (findError) {
      console.error("[cleanup-duplicate-messages] Error finding messages:", findError);
      throw findError;
    }

    if (!duplicates || duplicates.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "No incoming messages with telegram_message_id found",
          duplicates_found: 0,
          deleted: 0 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Group by account_id + telegram_message_id to find duplicates
    const messageGroups = new Map<string, typeof duplicates>();
    
    for (const msg of duplicates) {
      const key = `${msg.account_id}_${msg.telegram_message_id}`;
      if (!messageGroups.has(key)) {
        messageGroups.set(key, []);
      }
      messageGroups.get(key)!.push(msg);
    }

    // Find groups with more than one message (duplicates)
    const duplicateIds: string[] = [];
    const duplicateDetails: { id: string; content: string; created_at: string }[] = [];

    for (const [key, messages] of messageGroups) {
      if (messages.length > 1) {
        // Keep the first one (oldest), mark rest for deletion
        const toDelete = messages.slice(1);
        for (const msg of toDelete) {
          duplicateIds.push(msg.id);
          duplicateDetails.push({
            id: msg.id,
            content: msg.content?.substring(0, 50) || "[no content]",
            created_at: msg.created_at
          });
        }
      }
    }

    console.log(`[cleanup-duplicate-messages] Found ${duplicateIds.length} duplicate messages to delete`);

    if (duplicateIds.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "No duplicate messages found",
          total_messages_checked: duplicates.length,
          duplicates_found: 0,
          deleted: 0 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (dryRun) {
      console.log(`[cleanup-duplicate-messages] DRY RUN - Would delete ${duplicateIds.length} messages`);
      return new Response(
        JSON.stringify({ 
          success: true, 
          dry_run: true,
          message: `Would delete ${duplicateIds.length} duplicate messages (use dry_run=false to execute)`,
          total_messages_checked: duplicates.length,
          duplicates_found: duplicateIds.length,
          sample_duplicates: duplicateDetails.slice(0, 10)
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Delete duplicates in batches of 100
    let deletedCount = 0;
    for (let i = 0; i < duplicateIds.length; i += 100) {
      const batch = duplicateIds.slice(i, i + 100);
      const { error: deleteError } = await supabase
        .from("messages")
        .delete()
        .in("id", batch);

      if (deleteError) {
        console.error(`[cleanup-duplicate-messages] Error deleting batch ${i}:`, deleteError);
      } else {
        deletedCount += batch.length;
        console.log(`[cleanup-duplicate-messages] Deleted batch ${i}-${i + batch.length}`);
      }
    }

    // Also update unread counts on affected conversations
    const affectedConversations = [...new Set(duplicates.filter(m => duplicateIds.includes(m.id)).map(m => m.conversation_id))];
    
    for (const convId of affectedConversations) {
      // Recalculate unread count
      const { data: unreadMsgs } = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", convId)
        .eq("direction", "incoming")
        .is("read_at", null);

      const newUnreadCount = unreadMsgs?.length || 0;
      
      await supabase
        .from("conversations")
        .update({ unread_count: newUnreadCount })
        .eq("id", convId);
    }

    console.log(`[cleanup-duplicate-messages] Cleanup complete. Deleted ${deletedCount} duplicates, updated ${affectedConversations.length} conversations`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Deleted ${deletedCount} duplicate messages`,
        total_messages_checked: duplicates.length,
        duplicates_found: duplicateIds.length,
        deleted: deletedCount,
        conversations_updated: affectedConversations.length
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[cleanup-duplicate-messages] Error:", errorMessage);
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
