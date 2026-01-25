import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Batch sizes for efficient processing
const MESSAGE_DELETE_BATCH = 200;
const CONVERSATION_DELETE_BATCH = 100;

// Helper: Safe batch delete with error recovery
async function safeBatchDelete(
  supabase: any,
  table: string,
  ids: string[],
  batchSize: number
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      const { error, count } = await supabase
        .from(table)
        .delete()
        .in('id', batch);
      
      if (error) {
        console.error(`[cleanup-old-chats] Error deleting batch from ${table}:`, error);
        failed += batch.length;
      } else {
        success += count || batch.length;
      }
    } catch (err) {
      console.error(`[cleanup-old-chats] Exception deleting from ${table}:`, err);
      failed += batch.length;
    }
  }
  
  return { success, failed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[cleanup-old-chats] Starting advanced cleanup (v2)...');

    // Calculate cutoff dates
    const now = new Date();
    
    // Conversation/message cutoff (5 days)
    const conversationCutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    
    // Warmup message cutoff (30 minutes)
    const warmupCutoff = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    
    // Warmup pairs cutoff (24 hours for completed/failed)
    const warmupPairCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    
    // Warmup sessions cutoff (7 days for stopped sessions)
    const warmupSessionCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const stats = {
      warmup_messages_deleted: 0,
      warmup_pairs_deleted: 0,
      warmup_sessions_deleted: 0,
      warmup_errors_archived: 0,
      conversations_deleted: 0,
      messages_deleted: 0,
      orphaned_messages_deleted: 0,
    };

    // ==================== PHASE 1: WARMUP CLEANUP ====================
    console.log(`[cleanup-old-chats] Phase 1: Warmup cleanup (cutoff: ${warmupCutoff})`);

    // 1a. Archive failed warmup messages to warmup_errors before deletion
    const { data: failedWarmupMessages } = await supabase
      .from('warmup_messages')
      .select('id, sender_account_id, receiver_account_id, pair_id, error_message, created_at, message_type')
      .eq('status', 'failed')
      .lt('created_at', warmupCutoff)
      .not('error_message', 'is', null)
      .limit(500);

    if (failedWarmupMessages && failedWarmupMessages.length > 0) {
      // Deduplicate by pair_id + error_type to avoid duplicate error entries
      const seenPairErrors = new Set<string>();
      const errorInserts = [];
      
      for (const msg of failedWarmupMessages) {
        const key = `${msg.pair_id}:${msg.error_message?.substring(0, 50)}`;
        if (!seenPairErrors.has(key)) {
          seenPairErrors.add(key);
          errorInserts.push({
            account_id: msg.sender_account_id,
            pair_id: msg.pair_id,
            error_message: msg.error_message || 'Unknown error',
            error_type: `warmup_${msg.message_type || 'message'}_failed`,
          });
        }
      }

      if (errorInserts.length > 0) {
        const { error: insertError } = await supabase
          .from('warmup_errors')
          .insert(errorInserts);

        if (insertError) {
          console.error('[cleanup-old-chats] Error archiving warmup errors:', insertError);
        } else {
          stats.warmup_errors_archived = errorInserts.length;
          console.log(`[cleanup-old-chats] Archived ${errorInserts.length} unique warmup errors`);
        }
      }
    }

    // 1b. Delete old warmup messages (all statuses)
    const { error: warmupDeleteError, count: warmupDeleteCount } = await supabase
      .from('warmup_messages')
      .delete()
      .lt('created_at', warmupCutoff);

    if (warmupDeleteError) {
      console.error('[cleanup-old-chats] Error deleting warmup messages:', warmupDeleteError);
    } else {
      stats.warmup_messages_deleted = warmupDeleteCount || 0;
      if (stats.warmup_messages_deleted > 0) {
        console.log(`[cleanup-old-chats] Deleted ${stats.warmup_messages_deleted} warmup messages`);
      }
    }

    // 1c. Delete old completed/failed warmup pairs (24h after completion)
    const { error: pairsDeleteError, count: pairsDeleteCount } = await supabase
      .from('warmup_pairs')
      .delete()
      .in('status', ['completed', 'failed', 'cancelled'])
      .lt('created_at', warmupPairCutoff);

    if (pairsDeleteError) {
      console.error('[cleanup-old-chats] Error deleting warmup pairs:', pairsDeleteError);
    } else {
      stats.warmup_pairs_deleted = pairsDeleteCount || 0;
      if (stats.warmup_pairs_deleted > 0) {
        console.log(`[cleanup-old-chats] Deleted ${stats.warmup_pairs_deleted} completed warmup pairs`);
      }
    }

    // 1d. Delete old stopped warmup sessions (7 days after stop)
    const { error: sessionsDeleteError, count: sessionsDeleteCount } = await supabase
      .from('warmup_sessions')
      .delete()
      .eq('status', 'stopped')
      .lt('stopped_at', warmupSessionCutoff);

    if (sessionsDeleteError) {
      console.error('[cleanup-old-chats] Error deleting warmup sessions:', sessionsDeleteError);
    } else {
      stats.warmup_sessions_deleted = sessionsDeleteCount || 0;
      if (stats.warmup_sessions_deleted > 0) {
        console.log(`[cleanup-old-chats] Deleted ${stats.warmup_sessions_deleted} stopped warmup sessions`);
      }
    }

    // ==================== PHASE 2: CONVERSATION CLEANUP ====================
    console.log(`[cleanup-old-chats] Phase 2: Conversation cleanup (cutoff: ${conversationCutoff})`);

    // Get conversations older than 5 days (batch limit to avoid timeout)
    const { data: oldConversations } = await supabase
      .from('conversations')
      .select('id')
      .lt('updated_at', conversationCutoff)
      .limit(500);

    if (oldConversations && oldConversations.length > 0) {
      const conversationIds = oldConversations.map(c => c.id);
      console.log(`[cleanup-old-chats] Found ${conversationIds.length} old conversations to delete`);

      // 2a. Delete messages first (foreign key constraint) - batched
      const { data: messagesToDelete } = await supabase
        .from('messages')
        .select('id')
        .in('conversation_id', conversationIds);

      if (messagesToDelete && messagesToDelete.length > 0) {
        const messageIds = messagesToDelete.map(m => m.id);
        const msgResult = await safeBatchDelete(supabase, 'messages', messageIds, MESSAGE_DELETE_BATCH);
        stats.messages_deleted = msgResult.success;
        console.log(`[cleanup-old-chats] Deleted ${msgResult.success} messages (${msgResult.failed} failed)`);
      }

      // 2b. Delete conversations - batched
      const convResult = await safeBatchDelete(supabase, 'conversations', conversationIds, CONVERSATION_DELETE_BATCH);
      stats.conversations_deleted = convResult.success;
      console.log(`[cleanup-old-chats] Deleted ${convResult.success} conversations (${convResult.failed} failed)`);
    }

    // ==================== PHASE 3: ORPHAN CLEANUP ====================
    console.log('[cleanup-old-chats] Phase 3: Orphan cleanup...');

    // Find orphaned messages (conversation_id doesn't exist)
    // This is a safety net for any cascading delete failures
    const { data: orphanedMessages } = await supabase
      .from('messages')
      .select('id, conversation_id')
      .lt('created_at', conversationCutoff)
      .limit(200);

    if (orphanedMessages && orphanedMessages.length > 0) {
      // Check which conversation_ids actually exist
      const convIds = [...new Set(orphanedMessages.map(m => m.conversation_id))];
      const { data: existingConvs } = await supabase
        .from('conversations')
        .select('id')
        .in('id', convIds);
      
      const existingConvIds = new Set((existingConvs || []).map(c => c.id));
      const orphanedMsgIds = orphanedMessages
        .filter(m => !existingConvIds.has(m.conversation_id))
        .map(m => m.id);
      
      if (orphanedMsgIds.length > 0) {
        const { error: orphanError, count: orphanCount } = await supabase
          .from('messages')
          .delete()
          .in('id', orphanedMsgIds);
        
        if (!orphanError) {
          stats.orphaned_messages_deleted = orphanCount || orphanedMsgIds.length;
          console.log(`[cleanup-old-chats] Cleaned ${stats.orphaned_messages_deleted} orphaned messages`);
        }
      }
    }

    // ==================== SUMMARY ====================
    const duration = Date.now() - startTime;
    const totalDeleted = Object.values(stats).reduce((a, b) => a + b, 0);

    console.log(`[cleanup-old-chats] Cleanup complete in ${duration}ms:`, stats);

    return new Response(
      JSON.stringify({
        success: true,
        stats,
        cutoffs: {
          conversations: conversationCutoff,
          warmupMessages: warmupCutoff,
          warmupPairs: warmupPairCutoff,
          warmupSessions: warmupSessionCutoff,
        },
        duration_ms: duration,
        total_deleted: totalDeleted,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    console.error(`[cleanup-old-chats] Error after ${duration}ms:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage, duration_ms: duration }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
