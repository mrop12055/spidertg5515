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

    // Fetch all incoming messages to detect duplicates
    // Duplicates can be identified by:
    // 1. Same telegram_message_id + account_id (if telegram_message_id exists)
    // 2. Same account_id + conversation_id + content + similar created_at (within 5 seconds)
    const { data: allMessages, error: findError } = await supabase
      .from("messages")
      .select("id, account_id, conversation_id, telegram_message_id, content, created_at")
      .eq("direction", "incoming")
      .order("created_at", { ascending: true });

    if (findError) {
      console.error("[cleanup-duplicate-messages] Error finding messages:", findError);
      throw findError;
    }

    if (!allMessages || allMessages.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "No incoming messages found",
          duplicates_found: 0,
          deleted: 0 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[cleanup-duplicate-messages] Found ${allMessages.length} total incoming messages`);

    // Group messages to find duplicates
    const duplicateIds: string[] = [];
    const seenMessages = new Map<string, { id: string; created_at: string }>();

    for (const msg of allMessages) {
      // Strategy 1: Match by telegram_message_id + account_id (most reliable)
      if (msg.telegram_message_id) {
        const key = `tg_${msg.account_id}_${msg.telegram_message_id}`;
        if (seenMessages.has(key)) {
          // This is a duplicate - mark for deletion
          duplicateIds.push(msg.id);
          console.log(`[cleanup-duplicate-messages] Found telegram_id duplicate: ${msg.id}`);
        } else {
          seenMessages.set(key, { id: msg.id, created_at: msg.created_at });
        }
        continue;
      }

      // Strategy 2: Match by account_id + conversation_id + content + time window (for old messages without telegram_message_id)
      // Create a key based on content hash (first 100 chars to handle long messages)
      const contentKey = (msg.content || "").substring(0, 100).trim();
      const key = `content_${msg.account_id}_${msg.conversation_id}_${contentKey}`;
      
      const existing = seenMessages.get(key);
      if (existing) {
        // Check if created within 60 seconds of the first one (likely duplicate from restart)
        const existingTime = new Date(existing.created_at).getTime();
        const msgTime = new Date(msg.created_at).getTime();
        const timeDiff = Math.abs(msgTime - existingTime);
        
        if (timeDiff < 60000) { // Within 60 seconds
          // This is likely a duplicate - mark for deletion
          duplicateIds.push(msg.id);
          console.log(`[cleanup-duplicate-messages] Found content duplicate (${timeDiff}ms apart): ${msg.id}`);
        } else {
          // Too far apart, could be legitimately repeated message - update the key
          seenMessages.set(key, { id: msg.id, created_at: msg.created_at });
        }
      } else {
        seenMessages.set(key, { id: msg.id, created_at: msg.created_at });
      }
    }

    console.log(`[cleanup-duplicate-messages] Found ${duplicateIds.length} duplicate messages to delete`);

    if (duplicateIds.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "No duplicate messages found",
          total_messages_checked: allMessages.length,
          duplicates_found: 0,
          deleted: 0 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (dryRun) {
      // Get sample duplicates for preview
      const sampleDuplicates = allMessages
        .filter(m => duplicateIds.includes(m.id))
        .slice(0, 10)
        .map(m => ({
          id: m.id,
          content: (m.content || "").substring(0, 50),
          created_at: m.created_at
        }));

      console.log(`[cleanup-duplicate-messages] DRY RUN - Would delete ${duplicateIds.length} messages`);
      return new Response(
        JSON.stringify({ 
          success: true, 
          dry_run: true,
          message: `Would delete ${duplicateIds.length} duplicate messages (use dry_run=false to execute)`,
          total_messages_checked: allMessages.length,
          duplicates_found: duplicateIds.length,
          sample_duplicates: sampleDuplicates
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

    // Collect affected conversation IDs for unread count update
    const affectedConversationIds = [...new Set(
      allMessages
        .filter(m => duplicateIds.includes(m.id))
        .map(m => m.conversation_id)
    )];

    // Update unread counts on affected conversations
    for (const convId of affectedConversationIds) {
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

    console.log(`[cleanup-duplicate-messages] Cleanup complete. Deleted ${deletedCount} duplicates, updated ${affectedConversationIds.length} conversations`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Deleted ${deletedCount} duplicate messages`,
        total_messages_checked: allMessages.length,
        duplicates_found: duplicateIds.length,
        deleted: deletedCount,
        conversations_updated: affectedConversationIds.length
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
