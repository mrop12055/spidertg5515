import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper to wrap supabase calls as proper Promises
const asPromise = async (query: any): Promise<any> => {
  return await query;
};

/**
 * Batch report endpoint for campaign results.
 * OPTIMIZED: Uses parallel operations to complete in <500ms
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

    const successResults = results.filter(r => r.success && r.campaign_recipient_id);
    const failedResults = results.filter(r => !r.success && r.campaign_recipient_id);
    const now = new Date().toISOString();

    // ========== PARALLEL PROCESS SUCCESSES ==========
    if (successResults.length > 0) {
      const withApiId = successResults.filter(r => r.api_credential_id);
      const withoutApiId = successResults.filter(r => !r.api_credential_id);

      const recipientUpdatePromises: Promise<any>[] = [];

      // For those WITH api_credential_id - group by api_credential_id for batch updates
      if (withApiId.length > 0) {
        const byApiId = new Map<string, string[]>();
        for (const r of withApiId) {
          const ids = byApiId.get(r.api_credential_id) || [];
          ids.push(r.campaign_recipient_id);
          byApiId.set(r.api_credential_id, ids);
        }
        
        for (const [apiCredId, recipientIds] of byApiId) {
          recipientUpdatePromises.push(
            asPromise(
              supabase
                .from("campaign_recipients")
                .update({ status: "sent", sent_at: now, api_credential_id: apiCredId })
                .in("id", recipientIds)
            )
          );
        }
      }

      // For those WITHOUT api_credential_id - single batch
      if (withoutApiId.length > 0) {
        recipientUpdatePromises.push(
          asPromise(
            supabase
              .from("campaign_recipients")
              .update({ status: "sent", sent_at: now })
              .in("id", withoutApiId.map(r => r.campaign_recipient_id))
          )
        );
      }

      // Group campaign counts
      const campaignCounts = new Map<string, number>();
      for (const r of successResults) {
        if (r.campaign_id) {
          campaignCounts.set(r.campaign_id, (campaignCounts.get(r.campaign_id) || 0) + 1);
        }
      }

      // Get all needed data in PARALLEL
      const recipientPhones = [...new Set(successResults.map(r => r.recipient_phone).filter(Boolean))];
      const accountIds = [...new Set(successResults.map(r => r.account_id).filter(Boolean))];
      const campaignIds = [...campaignCounts.keys()];
      const recipientIds = successResults.map(r => r.campaign_recipient_id).filter(Boolean);

      const [existingConvsResult, existingMessagesResult, campaignsResult, accountsResult] = await Promise.all([
        supabase
          .from("conversations")
          .select("id, account_id, recipient_phone")
          .in("account_id", accountIds.length > 0 ? accountIds : ['__none__'])
          .in("recipient_phone", recipientPhones.length > 0 ? recipientPhones : ['__none__']),
        supabase
          .from("messages")
          .select("campaign_recipient_id")
          .in("campaign_recipient_id", recipientIds.length > 0 ? recipientIds : ['__none__']),
        supabase
          .from("campaigns")
          .select("id, sent_count")
          .in("id", campaignIds.length > 0 ? campaignIds : ['__none__']),
        supabase
          .from("telegram_accounts")
          .select("id, messages_sent_today")
          .in("id", accountIds.length > 0 ? accountIds : ['__none__']),
      ]);

      // Wait for recipient updates too
      await Promise.all(recipientUpdatePromises);

      const existingConvs = existingConvsResult.data || [];
      const existingMessages = existingMessagesResult.data || [];
      const campaigns = campaignsResult.data || [];
      const accounts = accountsResult.data || [];

      // Build lookups
      const convLookup = new Map<string, string>();
      for (const conv of existingConvs) {
        convLookup.set(`${conv.account_id}:${conv.recipient_phone}`, conv.id);
      }
      
      const existingRecipientIds = new Set(existingMessages.map(m => m.campaign_recipient_id));
      const campaignSentCounts = new Map(campaigns.map(c => [c.id, c.sent_count || 0]));
      const accountMsgCounts = new Map(accounts.map(a => [a.id, a.messages_sent_today || 0]));

      // Determine new conversations needed
      const newConversations: any[] = [];
      const resultToConvId = new Map<string, string>();

      for (const r of successResults) {
        const key = `${r.account_id}:${r.recipient_phone}`;
        const existingId = convLookup.get(key);
        
        if (existingId) {
          resultToConvId.set(r.campaign_recipient_id, existingId);
        } else if (!convLookup.has(key)) {
          const newConv = {
            account_id: r.account_id,
            recipient_phone: r.recipient_phone,
            recipient_name: r.recipient_name,
            is_active: true,
            first_message_sent: true,
            last_message_at: now,
            seat_id: r.campaign_seat_id,
            campaign_id: r.campaign_id,
            campaign_name: r.campaign_name,
          };
          newConversations.push(newConv);
          convLookup.set(key, 'pending');
        }
      }

      // Create new conversations (if any)
      if (newConversations.length > 0) {
        const { data: createdConvs } = await supabase
          .from("conversations")
          .insert(newConversations)
          .select("id, account_id, recipient_phone");

        for (const conv of createdConvs || []) {
          convLookup.set(`${conv.account_id}:${conv.recipient_phone}`, conv.id);
        }
      }

      // Update resultToConvId with newly created convs
      for (const r of successResults) {
        const key = `${r.account_id}:${r.recipient_phone}`;
        const convId = convLookup.get(key);
        if (convId && convId !== 'pending') {
          resultToConvId.set(r.campaign_recipient_id, convId);
        }
      }

      // Prepare messages (skip duplicates)
      const messagesToInsert: any[] = [];
      let skippedDuplicates = 0;

      for (const r of successResults) {
        if (existingRecipientIds.has(r.campaign_recipient_id)) {
          skippedDuplicates++;
          continue;
        }
        
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
          existingRecipientIds.add(r.campaign_recipient_id);
        }
      }

      if (skippedDuplicates > 0) {
        console.log(`[report-batch-results] Skipped ${skippedDuplicates} duplicates`);
      }

      // Count new conversations per account
      const accountNewConvCounts = new Map<string, number>();
      for (const conv of newConversations) {
        if (conv.account_id) {
          accountNewConvCounts.set(conv.account_id, (accountNewConvCounts.get(conv.account_id) || 0) + 1);
        }
      }

      // Prepare all final updates in PARALLEL
      const finalPromises: Promise<any>[] = [];

      if (messagesToInsert.length > 0) {
        finalPromises.push(
          asPromise(supabase.from("messages").insert(messagesToInsert))
        );
      }

      for (const [campaignId, addCount] of campaignCounts) {
        const currentCount = campaignSentCounts.get(campaignId) || 0;
        finalPromises.push(
          asPromise(
            supabase
              .from("campaigns")
              .update({ sent_count: currentCount + addCount })
              .eq("id", campaignId)
          )
        );
      }

      for (const [accountId, newConvCount] of accountNewConvCounts) {
        const currentCount = accountMsgCounts.get(accountId) || 0;
        finalPromises.push(
          asPromise(
            supabase
              .from("telegram_accounts")
              .update({
                messages_sent_today: currentCount + newConvCount,
                last_campaign_send_at: now,
                last_active: now
              })
              .eq("id", accountId)
          )
        );
      }

      const accountsWithExistingConvs = accountIds.filter(id => !accountNewConvCounts.has(id));
      if (accountsWithExistingConvs.length > 0) {
        finalPromises.push(
          asPromise(
            supabase
              .from("telegram_accounts")
              .update({ last_campaign_send_at: now, last_active: now })
              .in("id", accountsWithExistingConvs)
          )
        );
      }

      const usedPhones = recipientPhones;
      if (usedPhones.length > 0) {
        finalPromises.push(
          asPromise(
            supabase
              .from("contacts_data")
              .update({ is_used: true, used_at: now })
              .in("phone_number", usedPhones)
          )
        );
      }

      await Promise.all(finalPromises);
      console.log(`[report-batch-results] Success: ${successResults.length} (${newConversations.length} new convs)`);
    }

    // ========== PARALLEL PROCESS FAILURES ==========
    if (failedResults.length > 0) {
      const retryable = failedResults.filter(r => r.retry_with_different_account);
      const permanent = failedResults.filter(r => !r.retry_with_different_account);

      const failPromises: Promise<any>[] = [];

      if (permanent.length > 0) {
        const permanentIds = permanent.map(r => r.campaign_recipient_id);
        failPromises.push(
          asPromise(
            supabase
              .from("campaign_recipients")
              .update({ status: "failed" })
              .in("id", permanentIds)
          )
        );

        for (const r of permanent) {
          failPromises.push(
            asPromise(
              supabase
                .from("campaign_recipients")
                .update({ failed_reason: r.error })
                .eq("id", r.campaign_recipient_id)
            )
          );
        }
      }

      for (const r of retryable) {
        failPromises.push(
          (async () => {
            const { data: current } = await supabase
              .from("campaign_recipients")
              .select("failed_account_ids")
              .eq("id", r.campaign_recipient_id)
              .single();
            
            const failedIds: string[] = current?.failed_account_ids || [];
            if (r.account_id && !failedIds.includes(r.account_id)) {
              failedIds.push(r.account_id);
            }
            
            await supabase
              .from("campaign_recipients")
              .update({
                status: "pending",
                failed_reason: r.error,
                failed_account_ids: failedIds,
                sent_by_account_id: null
              })
              .eq("id", r.campaign_recipient_id);
          })()
        );
      }

      const failCounts = new Map<string, number>();
      for (const r of permanent) {
        if (r.campaign_id) {
          failCounts.set(r.campaign_id, (failCounts.get(r.campaign_id) || 0) + 1);
        }
      }

      if (failCounts.size > 0) {
        const campaignIds = [...failCounts.keys()];
        const { data: campaigns } = await supabase
          .from("campaigns")
          .select("id, failed_count")
          .in("id", campaignIds);

        for (const campaign of campaigns || []) {
          const addCount = failCounts.get(campaign.id) || 0;
          failPromises.push(
            asPromise(
              supabase
                .from("campaigns")
                .update({ failed_count: (campaign.failed_count || 0) + addCount })
                .eq("id", campaign.id)
            )
          );
        }
      }

      await Promise.all(failPromises);
      console.log(`[report-batch-results] Failed: ${failedResults.length} (${permanent.length} permanent)`);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[report-batch-results] Done in ${elapsed}ms`);

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
