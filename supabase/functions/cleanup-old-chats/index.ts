import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('Starting cleanup of old chats and warmup messages...');

    // Calculate cutoff dates
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const conversationCutoffDate = threeDaysAgo.toISOString();

    // 30 minutes ago for warmup messages
    const thirtyMinutesAgo = new Date();
    thirtyMinutesAgo.setMinutes(thirtyMinutesAgo.getMinutes() - 30);
    const warmupCutoffDate = thirtyMinutesAgo.toISOString();

    console.log(`Deleting conversations older than: ${conversationCutoffDate}`);
    console.log(`Deleting warmup messages older than: ${warmupCutoffDate}`);

    // ========== WARMUP CLEANUP (30 minutes) ==========
    // First, save failed warmup messages to warmup_errors before deleting
    const { data: failedWarmupMessages, error: fetchFailedError } = await supabase
      .from('warmup_messages')
      .select('id, sender_account_id, receiver_account_id, pair_id, error_message, created_at')
      .eq('status', 'failed')
      .lt('created_at', warmupCutoffDate)
      .not('error_message', 'is', null);

    if (fetchFailedError) {
      console.error('Error fetching failed warmup messages:', fetchFailedError);
    } else if (failedWarmupMessages && failedWarmupMessages.length > 0) {
      // Insert failed reasons into warmup_errors (if not already there)
      const errorInserts = failedWarmupMessages.map(msg => ({
        account_id: msg.sender_account_id,
        pair_id: msg.pair_id,
        error_message: msg.error_message || 'Unknown error',
        error_type: 'warmup_message_failed',
      }));

      const { error: insertError } = await supabase
        .from('warmup_errors')
        .insert(errorInserts);

      if (insertError) {
        console.error('Error saving failed warmup reasons:', insertError);
      } else {
        console.log(`Saved ${errorInserts.length} failed warmup reasons to warmup_errors`);
      }
    }

    // Delete warmup messages older than 30 minutes (all statuses)
    const { error: warmupDeleteError, count: warmupDeleteCount } = await supabase
      .from('warmup_messages')
      .delete()
      .lt('created_at', warmupCutoffDate);

    if (warmupDeleteError) {
      console.error('Error deleting old warmup messages:', warmupDeleteError);
    } else {
      console.log(`Deleted ${warmupDeleteCount || 0} warmup messages older than 30 minutes`);
    }

    // ========== CONVERSATION CLEANUP (3 days) ==========
    // Get conversations older than 3 days
    const { data: oldConversations, error: fetchError } = await supabase
      .from('conversations')
      .select('id')
      .lt('updated_at', conversationCutoffDate);

    if (fetchError) {
      console.error('Error fetching old conversations:', fetchError);
      throw fetchError;
    }

    const conversationIds = oldConversations?.map(c => c.id) || [];
    console.log(`Found ${conversationIds.length} old conversations to delete`);

    let deletedConversations = 0;
    let deletedMessages = 0;

    if (conversationIds.length > 0) {
      // Delete messages for old conversations
      const { error: messagesError, count: messagesCount } = await supabase
        .from('messages')
        .delete()
        .in('conversation_id', conversationIds);

      if (messagesError) {
        console.error('Error deleting old messages:', messagesError);
        throw messagesError;
      }

      deletedMessages = messagesCount || 0;
      console.log(`Deleted ${deletedMessages} messages`);

      // Delete old conversations
      const { error: conversationsError, count: conversationsCount } = await supabase
        .from('conversations')
        .delete()
        .in('id', conversationIds);

      if (conversationsError) {
        console.error('Error deleting old conversations:', conversationsError);
        throw conversationsError;
      }

      deletedConversations = conversationsCount || conversationIds.length;
      console.log(`Deleted ${deletedConversations} conversations`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        deleted: {
          conversations: deletedConversations,
          messages: deletedMessages,
          warmupMessages: warmupDeleteCount || 0,
        },
        cutoffDates: {
          conversations: conversationCutoffDate,
          warmupMessages: warmupCutoffDate,
        },
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    console.error('Error in cleanup-old-chats:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
