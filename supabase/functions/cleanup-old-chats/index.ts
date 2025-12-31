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

    console.log('Starting cleanup of old chats...');

    // Calculate 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoffDate = sevenDaysAgo.toISOString();

    console.log(`Deleting conversations and messages older than: ${cutoffDate}`);

    // Get conversations older than 7 days
    const { data: oldConversations, error: fetchError } = await supabase
      .from('conversations')
      .select('id')
      .lt('updated_at', cutoffDate);

    if (fetchError) {
      console.error('Error fetching old conversations:', fetchError);
      throw fetchError;
    }

    const conversationIds = oldConversations?.map(c => c.id) || [];
    console.log(`Found ${conversationIds.length} old conversations to delete`);

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

      console.log(`Deleted ${messagesCount || 0} messages`);

      // Delete old conversations
      const { error: conversationsError, count: conversationsCount } = await supabase
        .from('conversations')
        .delete()
        .in('id', conversationIds);

      if (conversationsError) {
        console.error('Error deleting old conversations:', conversationsError);
        throw conversationsError;
      }

      console.log(`Deleted ${conversationsCount || 0} conversations`);

      return new Response(
        JSON.stringify({
          success: true,
          deleted: {
            conversations: conversationsCount || conversationIds.length,
            messages: messagesCount || 0,
          },
          cutoffDate,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        deleted: {
          conversations: 0,
          messages: 0,
        },
        cutoffDate,
        message: 'No old conversations to delete',
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
