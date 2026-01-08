import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Batch report endpoint for campaign results.
 * Processes multiple send results in a single request for 10-50x faster throughput.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json();
    const { results } = body;

    if (!results || !Array.isArray(results) || results.length === 0) {
      return new Response(JSON.stringify({ error: "No results provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[report-batch-results] Processing ${results.length} results`);

    // Separate successful and failed results
    const successResults = results.filter(r => r.success && r.campaign_recipient_id);
    const failedResults = results.filter(r => !r.success && r.campaign_recipient_id);

    const now = new Date().toISOString();
    
    // ========== BATCH PROCESS SUCCESSES ==========
    if (successResults.length > 0) {
      // 1. Batch update campaign_recipients to 'sent'
      const successRecipientIds = successResults.map(r => r.campaign_recipient_id);
      await supabase
        .from("campaign_recipients")
        .update({ status: "sent", sent_at: now })
        .in("id", successRecipientIds);

      // 2. Group by campaign for batch sent_count updates
      const campaignCounts = new Map<string, number>();
      for (const r of successResults) {
        if (r.campaign_id) {
          campaignCounts.set(r.campaign_id, (campaignCounts.get(r.campaign_id) || 0) + 1);
        }
      }

      // Update campaign sent_counts (one query per campaign)
      for (const [campaignId, count] of campaignCounts) {
        const { data: campaign } = await supabase
          .from("campaigns")
          .select("sent_count")
          .eq("id", campaignId)
          .single();
        
        if (campaign) {
          await supabase
            .from("campaigns")
            .update({ sent_count: (campaign.sent_count || 0) + count })
            .eq("id", campaignId);
        }
      }

      // 3. Create conversations and messages in batches
      // First, check for existing conversations
      const recipientPhones = [...new Set(successResults.map(r => r.recipient_phone).filter(Boolean))];
      const accountIds = [...new Set(successResults.map(r => r.account_id).filter(Boolean))];
      
      // Get existing conversations for these account+phone combinations
      const { data: existingConvs } = await supabase
        .from("conversations")
        .select("id, account_id, recipient_phone")
        .in("account_id", accountIds)
        .in("recipient_phone", recipientPhones);

      const convLookup = new Map<string, string>();
      for (const conv of existingConvs || []) {
        convLookup.set(`${conv.account_id}:${conv.recipient_phone}`, conv.id);
      }

      // Create new conversations for missing ones
      const newConversations: any[] = [];
      const resultToConvId = new Map<string, string>();
      
      for (const r of successResults) {
        const key = `${r.account_id}:${r.recipient_phone}`;
        const existingId = convLookup.get(key);
        
        if (existingId) {
          resultToConvId.set(r.campaign_recipient_id, existingId);
        } else {
          // Need to create new conversation
          newConversations.push({
            account_id: r.account_id,
            recipient_phone: r.recipient_phone,
            recipient_name: r.recipient_name,
            is_active: true,
            first_message_sent: true,
            last_message_at: now,
            seat_id: r.campaign_seat_id,
            campaign_id: r.campaign_id,
            campaign_name: r.campaign_name,
          });
        }
      }

      // Insert new conversations and map back
      if (newConversations.length > 0) {
        const { data: createdConvs, error: convError } = await supabase
          .from("conversations")
          .insert(newConversations)
          .select("id, account_id, recipient_phone");

        if (convError) {
          console.error(`[report-batch-results] Error creating conversations:`, convError);
        } else {
          for (const conv of createdConvs || []) {
            convLookup.set(`${conv.account_id}:${conv.recipient_phone}`, conv.id);
          }
        }
      }

      // Map all results to conversation IDs
      for (const r of successResults) {
        const key = `${r.account_id}:${r.recipient_phone}`;
        const convId = convLookup.get(key);
        if (convId) {
          resultToConvId.set(r.campaign_recipient_id, convId);
        }
      }

      // 4. Create messages in batch
      const messagesToInsert: any[] = [];
      for (const r of successResults) {
        const convId = resultToConvId.get(r.campaign_recipient_id);
        if (convId) {
          messagesToInsert.push({
            account_id: r.account_id,
            conversation_id: convId,
            content: r.content || '',
            direction: 'outgoing',
            status: 'sent',
            delivered_at: now,
            campaign_recipient_id: r.campaign_recipient_id,
            api_credential_id: r.api_credential_id || null,
          });
        }
      }

      if (messagesToInsert.length > 0) {
        const { error: msgError } = await supabase
          .from("messages")
          .insert(messagesToInsert);

        if (msgError) {
          console.error(`[report-batch-results] Error creating messages:`, msgError);
        }
      }

      // 5. Update account last_campaign_send_at in batch
      const uniqueAccountIds = [...new Set(successResults.map(r => r.account_id).filter(Boolean))];
      await supabase
        .from("telegram_accounts")
        .update({ 
          last_campaign_send_at: now,
          last_active: now
        })
        .in("id", uniqueAccountIds);

      // 6. Mark contacts as used in batch
      const usedPhones = [...new Set(successResults.map(r => r.recipient_phone).filter(Boolean))];
      if (usedPhones.length > 0) {
        await supabase
          .from("contacts_data")
          .update({ is_used: true, used_at: now })
          .in("phone_number", usedPhones);
      }

      console.log(`[report-batch-results] Processed ${successResults.length} successes (${newConversations.length} new convs)`);
    }

    // ========== BATCH PROCESS FAILURES ==========
    if (failedResults.length > 0) {
      // Update failed recipients
      for (const r of failedResults) {
        const updates: any = {
          status: r.retry_with_different_account ? "pending" : "failed",
          failed_reason: r.error,
        };
        
        if (r.retry_with_different_account) {
          // Add account to failed_account_ids for retry with different account
          const { data: current } = await supabase
            .from("campaign_recipients")
            .select("failed_account_ids")
            .eq("id", r.campaign_recipient_id)
            .single();
          
          const failedIds: string[] = current?.failed_account_ids || [];
          if (r.account_id && !failedIds.includes(r.account_id)) {
            failedIds.push(r.account_id);
          }
          updates.failed_account_ids = failedIds;
          updates.sent_by_account_id = null;
        }

        await supabase
          .from("campaign_recipients")
          .update(updates)
          .eq("id", r.campaign_recipient_id);
      }

      // Count permanent failures by campaign
      const permanentFailures = failedResults.filter(r => !r.retry_with_different_account);
      const failCounts = new Map<string, number>();
      for (const r of permanentFailures) {
        if (r.campaign_id) {
          failCounts.set(r.campaign_id, (failCounts.get(r.campaign_id) || 0) + 1);
        }
      }

      for (const [campaignId, count] of failCounts) {
        const { data: campaign } = await supabase
          .from("campaigns")
          .select("failed_count")
          .eq("id", campaignId)
          .single();
        
        if (campaign) {
          await supabase
            .from("campaigns")
            .update({ failed_count: (campaign.failed_count || 0) + count })
            .eq("id", campaignId);
        }
      }

      console.log(`[report-batch-results] Processed ${failedResults.length} failures (${permanentFailures.length} permanent)`);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[report-batch-results] Completed in ${elapsed}ms`);

    return new Response(JSON.stringify({
      success: true,
      processed: results.length,
      successes: successResults.length,
      failures: failedResults.length,
      elapsed_ms: elapsed
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[report-batch-results] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
