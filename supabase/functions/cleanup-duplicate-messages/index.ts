import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type IncomingMessageRow = {
  id: string;
  account_id: string;
  conversation_id: string;
  telegram_message_id: number | null;
  content: string;
  created_at: string;
};

function normalizeContent(raw: string): string {
  return (raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isMediaMarker(content: string): boolean {
  const c = content.trim().toLowerCase();
  return c.startsWith("[photo]") || c.startsWith("[video]") || c.startsWith("[file]") || c === "[media]";
}

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

    const dryRun = body.dry_run !== false; // default true
    const lookbackDays = typeof body.lookback_days === "number" ? body.lookback_days : 30;
    const pageSizeRaw = typeof body.page_size === "number" ? body.page_size : 1000;
    const pageSize = Math.max(100, Math.min(1000, Math.floor(pageSizeRaw)));

    // For legacy messages (telegram_message_id IS NULL), treat long messages & media markers as duplicates
    // even if they were re-inserted hours later during multiple restarts.
    const shortWindowSeconds = typeof body.short_window_seconds === "number" ? body.short_window_seconds : 60;
    const legacyWindowSeconds = typeof body.legacy_window_seconds === "number" ? body.legacy_window_seconds : 7 * 24 * 60 * 60; // 7 days

    const shortWindowMs = shortWindowSeconds * 1000;
    const legacyWindowMs = legacyWindowSeconds * 1000;

    const cutoffIso =
      lookbackDays && lookbackDays > 0
        ? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

    console.log(
      `[cleanup-duplicate-messages] start dry_run=${dryRun} lookback_days=${lookbackDays} page_size=${pageSize} short_window=${shortWindowSeconds}s legacy_window=${legacyWindowSeconds}s`);

    const duplicateIds: string[] = [];
    const sampleDuplicates: Array<{ id: string; created_at: string; content: string }> = [];
    const affectedConversationIds = new Set<string>();

    // Since we iterate in ascending created_at order, the first time we see a key is the one we keep.
    const seenTelegram = new Set<string>(); // tg_${account_id}_${telegram_message_id}
    const seenContentBaseline = new Map<string, number>(); // contentKey -> baselineTimeMs

    let offset = 0;
    let totalChecked = 0;

    while (true) {
      let query = supabase
        .from("messages")
        .select("id, account_id, conversation_id, telegram_message_id, content, created_at")
        .eq("direction", "incoming")
        .order("created_at", { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (cutoffIso) {
        query = query.gte("created_at", cutoffIso);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = (data || []) as IncomingMessageRow[];
      if (rows.length === 0) break;

      totalChecked += rows.length;

      for (const msg of rows) {
        // Strategy 1: telegram_message_id based dedupe (reliable)
        if (msg.telegram_message_id) {
          const key = `tg_${msg.account_id}_${msg.telegram_message_id}`;
          if (seenTelegram.has(key)) {
            duplicateIds.push(msg.id);
            affectedConversationIds.add(msg.conversation_id);
            if (sampleDuplicates.length < 10) {
              sampleDuplicates.push({
                id: msg.id,
                created_at: msg.created_at,
                content: (msg.content || "").slice(0, 80),
              });
            }
          } else {
            seenTelegram.add(key);
          }
          continue;
        }

        // Strategy 2: legacy dedupe by content+conversation (heuristic)
        const normalized = normalizeContent(msg.content || "");
        const contentKey = normalized.slice(0, 200);
        const key = `content_${msg.account_id}_${msg.conversation_id}_${contentKey}`;

        const msgTime = new Date(msg.created_at).getTime();
        const baselineTime = seenContentBaseline.get(key);

        const isLong = contentKey.length >= 15;
        const useLegacyWindow = isLong || isMediaMarker(contentKey);
        const windowMs = useLegacyWindow ? legacyWindowMs : shortWindowMs;

        if (baselineTime !== undefined) {
          const timeDiff = Math.abs(msgTime - baselineTime);
          if (timeDiff <= windowMs) {
            duplicateIds.push(msg.id);
            affectedConversationIds.add(msg.conversation_id);
            if (sampleDuplicates.length < 10) {
              sampleDuplicates.push({
                id: msg.id,
                created_at: msg.created_at,
                content: (msg.content || "").slice(0, 80),
              });
            }
          } else {
            // Reset baseline for far-apart repeated content (treat as legitimate new message)
            seenContentBaseline.set(key, msgTime);
          }
        } else {
          seenContentBaseline.set(key, msgTime);
        }
      }

      if (rows.length < pageSize) break;
      offset += pageSize;

      // Safety: avoid infinite loops
      if (offset > 1_000_000) {
        console.log("[cleanup-duplicate-messages] Safety stop: too many rows");
        break;
      }
    }

    console.log(
      `[cleanup-duplicate-messages] scanned=${totalChecked} duplicates_found=${duplicateIds.length} conversations_affected=${affectedConversationIds.size}`
    );

    if (duplicateIds.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          dry_run: dryRun,
          message: "No duplicates found",
          total_messages_checked: totalChecked,
          duplicates_found: 0,
          deleted: 0,
          conversations_updated: 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({
          success: true,
          dry_run: true,
          message: `Would delete ${duplicateIds.length} duplicate messages (use dry_run=false to execute)`,
          total_messages_checked: totalChecked,
          duplicates_found: duplicateIds.length,
          sample_duplicates: sampleDuplicates,
          conversations_to_update: affectedConversationIds.size,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Delete duplicates in batches
    let deletedCount = 0;
    for (let i = 0; i < duplicateIds.length; i += 100) {
      const batch = duplicateIds.slice(i, i + 100);
      const { error: deleteError } = await supabase.from("messages").delete().in("id", batch);
      if (deleteError) {
        console.error(`[cleanup-duplicate-messages] delete batch failed at ${i}:`, deleteError);
      } else {
        deletedCount += batch.length;
      }
    }

    // Recompute unread_count for affected conversations (use COUNT to avoid row limits)
    let conversationsUpdated = 0;
    for (const convId of affectedConversationIds) {
      const { count, error: countError } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", convId)
        .eq("direction", "incoming")
        .is("read_at", null);

      if (countError) {
        console.error(`[cleanup-duplicate-messages] count failed for conversation ${convId}:`, countError);
        continue;
      }

      const { error: updateError } = await supabase
        .from("conversations")
        .update({ unread_count: count ?? 0 })
        .eq("id", convId);

      if (updateError) {
        console.error(`[cleanup-duplicate-messages] update unread_count failed for conversation ${convId}:`, updateError);
        continue;
      }

      conversationsUpdated += 1;
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: false,
        message: `Deleted ${deletedCount} duplicate messages`,
        total_messages_checked: totalChecked,
        duplicates_found: duplicateIds.length,
        deleted: deletedCount,
        conversations_updated: conversationsUpdated,
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
