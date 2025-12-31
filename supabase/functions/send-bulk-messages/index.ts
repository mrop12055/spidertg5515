import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface RecipientData {
  phone_number: string;
  name?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const url = new URL(req.url);
    const path = url.pathname.replace('/send-bulk-messages', '');

    console.log(`[send-bulk-messages] ${req.method} ${path}`);

    // Upload recipients to a campaign
    if (path === '/upload-recipients' && req.method === 'POST') {
      const body = await req.json();
      const { campaign_id, recipients } = body as { campaign_id: string; recipients: RecipientData[] };

      if (!campaign_id || !recipients?.length) {
        return new Response(
          JSON.stringify({ error: 'campaign_id and recipients required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[send-bulk-messages] Uploading ${recipients.length} recipients to campaign ${campaign_id}`);

      // Insert recipients
      const recipientRecords = recipients.map(r => ({
        campaign_id,
        phone_number: r.phone_number,
        name: r.name || null,
        status: 'pending',
      }));

      const { data, error } = await supabase
        .from('campaign_recipients')
        .insert(recipientRecords)
        .select();

      if (error) throw error;

      // Update campaign recipient count
      await supabase
        .from('campaigns')
        .update({ recipient_count: recipients.length })
        .eq('id', campaign_id);

      return new Response(
        JSON.stringify({ success: true, count: data.length }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Start sending campaign messages
    if (path === '/start-campaign' && req.method === 'POST') {
      const body = await req.json();
      const { campaign_id } = body as { campaign_id: string };

      if (!campaign_id) {
        return new Response(
          JSON.stringify({ error: 'campaign_id required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get campaign with accounts
      const { data: campaign, error: campaignError } = await supabase
        .from('campaigns')
        .select('*, campaign_accounts(account_id)')
        .eq('id', campaign_id)
        .single();

      if (campaignError || !campaign) {
        return new Response(
          JSON.stringify({ error: 'Campaign not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Get pending recipients
      const { data: recipients, error: recipientError } = await supabase
        .from('campaign_recipients')
        .select('*')
        .eq('campaign_id', campaign_id)
        .eq('status', 'pending');

      if (recipientError) throw recipientError;

      // Get active accounts assigned to this campaign
      const accountIds = campaign.campaign_accounts?.map((ca: any) => ca.account_id) || [];
      
      const { data: accounts, error: accountError } = await supabase
        .from('telegram_accounts')
        .select('*')
        .in('id', accountIds)
        .eq('status', 'active');

      if (accountError) throw accountError;

      if (!accounts?.length) {
        return new Response(
          JSON.stringify({ error: 'No active accounts assigned to campaign' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[send-bulk-messages] Starting campaign ${campaign_id} with ${recipients?.length || 0} recipients and ${accounts.length} accounts`);

      // Update campaign status to running
      await supabase
        .from('campaigns')
        .update({ status: 'running' })
        .eq('id', campaign_id);

      // Queue messages for each recipient (distribute across accounts)
      let accountIndex = 0;
      const queuedMessages = [];

      for (const recipient of recipients || []) {
        const account = accounts[accountIndex % accounts.length];
        
        // Personalize message template
        const personalizedMessage = campaign.message_template
          .replace(/{name}/g, recipient.name || 'there')
          .replace(/{phone}/g, recipient.phone_number);

        // Create or get conversation
        let conversation;
        const { data: existingConv } = await supabase
          .from('conversations')
          .select('id')
          .eq('account_id', account.id)
          .eq('recipient_phone', recipient.phone_number)
          .single();

        if (existingConv) {
          conversation = existingConv;
        } else {
          const { data: newConv, error: convError } = await supabase
            .from('conversations')
            .insert({
              account_id: account.id,
              recipient_phone: recipient.phone_number,
              recipient_name: recipient.name,
              is_active: true,
            })
            .select()
            .single();

          if (convError) throw convError;
          conversation = newConv;
        }

        // Queue message with pending status
        const { data: message, error: msgError } = await supabase
          .from('messages')
          .insert({
            account_id: account.id,
            conversation_id: conversation.id,
            content: personalizedMessage,
            direction: 'outgoing',
            status: 'pending',
          })
          .select()
          .single();

        if (msgError) {
          console.error(`[send-bulk-messages] Error queuing message for ${recipient.phone_number}:`, msgError.message);
        } else {
          queuedMessages.push(message);
          
          // Update recipient with assigned account
          await supabase
            .from('campaign_recipients')
            .update({ sent_by_account_id: account.id })
            .eq('id', recipient.id);
        }

        accountIndex++;
      }

      console.log(`[send-bulk-messages] Queued ${queuedMessages.length} messages for campaign ${campaign_id}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          queued: queuedMessages.length,
          message: 'Messages queued. They will be sent when VPS backend is connected.'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get campaign recipients
    if (path === '/recipients' && req.method === 'GET') {
      const campaignId = url.searchParams.get('campaign_id');
      
      if (!campaignId) {
        return new Response(
          JSON.stringify({ error: 'campaign_id required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data, error } = await supabase
        .from('campaign_recipients')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return new Response(
        JSON.stringify(data),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const error = err as Error;
    console.error('[send-bulk-messages] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
