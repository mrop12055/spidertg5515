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

// Normalize phone number - add + prefix if missing, strip formatting
function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters except +
  let normalized = phone.replace(/[^\d+]/g, '');
  
  // If it doesn't start with +, add it
  if (!normalized.startsWith('+')) {
    normalized = '+' + normalized;
  }
  
  return normalized;
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

      // Normalize all phone numbers
      const normalizedRecipients = recipients.map(r => ({
        ...r,
        phone_number: normalizePhoneNumber(r.phone_number)
      }));

      // Get unique normalized phone numbers from upload
      const uploadedPhones = [...new Set(normalizedRecipients.map(r => r.phone_number))];
      console.log(`[send-bulk-messages] Unique phone numbers after normalization: ${uploadedPhones.length}`);

      // Check for duplicates in existing conversations
      const { data: existingConversations, error: convError } = await supabase
        .from('conversations')
        .select('recipient_phone')
        .in('recipient_phone', uploadedPhones);

      if (convError) {
        console.error(`[send-bulk-messages] Error checking conversations:`, convError);
      }

      const existingConvPhones = new Set(
        (existingConversations || []).map((c: any) => c.recipient_phone)
      );
      console.log(`[send-bulk-messages] Found ${existingConvPhones.size} existing conversations`);

      // Check for duplicates in this campaign's existing recipients
      const { data: existingRecipients, error: recError } = await supabase
        .from('campaign_recipients')
        .select('phone_number')
        .eq('campaign_id', campaign_id);

      if (recError) {
        console.error(`[send-bulk-messages] Error checking recipients:`, recError);
      }

      const existingRecipientPhones = new Set(
        (existingRecipients || []).map((r: any) => r.phone_number)
      );
      console.log(`[send-bulk-messages] Found ${existingRecipientPhones.size} existing campaign recipients`);

      // Filter out duplicates
      const seenPhones = new Set<string>();
      const duplicates: string[] = [];
      const validRecipients: RecipientData[] = [];

      for (const recipient of normalizedRecipients) {
        const phone = recipient.phone_number;
        
        // Skip if already seen in this upload (dedupe within upload)
        if (seenPhones.has(phone)) {
          duplicates.push(phone);
          continue;
        }
        seenPhones.add(phone);

        // Skip if exists in conversations
        if (existingConvPhones.has(phone)) {
          duplicates.push(phone);
          continue;
        }

        // Skip if already in this campaign
        if (existingRecipientPhones.has(phone)) {
          duplicates.push(phone);
          continue;
        }

        validRecipients.push(recipient);
      }

      console.log(`[send-bulk-messages] Valid recipients: ${validRecipients.length}, Duplicates skipped: ${duplicates.length}`);

      if (validRecipients.length === 0) {
        return new Response(
          JSON.stringify({ 
            success: true, 
            inserted: 0, 
            duplicates: duplicates.length,
            duplicateNumbers: duplicates.slice(0, 20), // Return first 20 for reference
            message: 'All recipients were duplicates'
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Insert valid recipients with 'validating' status (Python will validate)
      const recipientRecords = validRecipients.map(r => ({
        campaign_id,
        phone_number: r.phone_number,
        name: r.name || null,
        status: 'validating', // Will be updated by Python script after Telegram check
      }));

      const { data, error } = await supabase
        .from('campaign_recipients')
        .insert(recipientRecords)
        .select();

      if (error) throw error;

      // Update campaign recipient count (add to existing)
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('recipient_count')
        .eq('id', campaign_id)
        .single();

      const newCount = (campaign?.recipient_count || 0) + data.length;
      await supabase
        .from('campaigns')
        .update({ recipient_count: newCount })
        .eq('id', campaign_id);

      return new Response(
        JSON.stringify({ 
          success: true, 
          inserted: data.length,
          duplicates: duplicates.length,
          duplicateNumbers: duplicates.slice(0, 20),
          message: duplicates.length > 0 
            ? `Uploaded ${data.length} recipients. ${duplicates.length} duplicates skipped.`
            : `Uploaded ${data.length} recipients.`
        }),
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

      // Get pending recipients (only those marked as 'pending' - validated by Python)
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
          .maybeSingle();

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