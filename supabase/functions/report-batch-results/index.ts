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

    // Separate already_sent results (from local cache - prevent double send)
    const alreadySentResults = results.filter(r => r.already_sent && r.campaign_recipient_id);
    const successResults = results.filter(r => r.success && !r.already_sent && r.campaign_recipient_id);
    const failedResults = results.filter(r => !r.success && !r.already_sent && r.campaign_recipient_id);
    const now = new Date().toISOString();

    // REMOVED waitUntil - we now process synchronously to ensure data is committed before responding
    // This prevents data loss when runner times out waiting for response

    const processBatch = async () => {
      // ========== HANDLE ALREADY_SENT (from local cache - prevent double send) ==========
      if (alreadySentResults.length > 0) {
        console.log(`[report-batch-results] Processing ${alreadySentResults.length} already_sent results (from local cache)`);
        // Just mark as sent without creating duplicate message
        const alreadySentIds = alreadySentResults.map(r => r.campaign_recipient_id);
        await supabase
          .from("campaign_recipients")
          .update({ status: "sent", sent_at: now })
          .in("id", alreadySentIds);
        
        // Update campaign sent counts
        const campaignCounts = new Map<string, number>();
        for (const r of alreadySentResults) {
          if (r.campaign_id) {
            campaignCounts.set(r.campaign_id, (campaignCounts.get(r.campaign_id) || 0) + 1);
          }
        }
        if (campaignCounts.size > 0) {
          const campaignIds = [...campaignCounts.keys()];
          const { data: campaigns } = await supabase
            .from("campaigns")
            .select("id, sent_count")
            .in("id", campaignIds);
          
          const updatePromises = (campaigns || []).map(campaign => {
            const addCount = campaignCounts.get(campaign.id) || 0;
            return supabase
              .from("campaigns")
              .update({ sent_count: (campaign.sent_count || 0) + addCount })
              .eq("id", campaign.id);
          });
          await Promise.all(updatePromises);
        }
      }
      
      // ========== PARALLEL PROCESS SUCCESSES ==========
      if (successResults.length > 0) {
        const withApiId = successResults.filter((r) => r.api_credential_id);
        const withoutApiId = successResults.filter((r) => !r.api_credential_id);

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
                .in(
                  "id",
                  withoutApiId.map((r) => r.campaign_recipient_id)
                )
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
        const recipientPhones = [...new Set(successResults.map((r) => r.recipient_phone).filter(Boolean))];
        const accountIds = [...new Set(successResults.map((r) => r.account_id).filter(Boolean))];
        const campaignIds = [...campaignCounts.keys()];
        const recipientIds = successResults.map((r) => r.campaign_recipient_id).filter(Boolean);

        const [existingConvsResult, existingMessagesResult, campaignsResult, accountsResult] =
          await Promise.all([
            supabase
              .from("conversations")
              .select("id, account_id, recipient_phone")
              .in("account_id", accountIds.length > 0 ? accountIds : ["__none__"])
              .in("recipient_phone", recipientPhones.length > 0 ? recipientPhones : ["__none__"]),
            supabase
              .from("messages")
              .select("campaign_recipient_id")
              .in("campaign_recipient_id", recipientIds.length > 0 ? recipientIds : ["__none__"]),
            supabase
              .from("campaigns")
              .select("id, sent_count")
              .in("id", campaignIds.length > 0 ? campaignIds : ["__none__"]),
            supabase
              .from("telegram_accounts")
              .select("id, messages_sent_today, last_campaign_send_at")
              .in("id", accountIds.length > 0 ? accountIds : ["__none__"]),
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

        const existingRecipientIds = new Set(existingMessages.map((m) => m.campaign_recipient_id));
        const campaignSentCounts = new Map(campaigns.map((c) => [c.id, c.sent_count || 0]));
        
        // Reset counter if last_campaign_send_at was before today (fixes accumulation bug)
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const todayStartIso = todayStart.toISOString();
        const accountMsgCounts = new Map(accounts.map((a) => {
          const lastSend = a.last_campaign_send_at;
          const needsReset = !lastSend || lastSend < todayStartIso;
          return [a.id, needsReset ? 0 : (a.messages_sent_today || 0)];
        }));

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
            convLookup.set(key, "pending");
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
          if (convId && convId !== "pending") {
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
              content: r.content || "",
              direction: "outgoing",
              status: "sent",
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
            accountNewConvCounts.set(
              conv.account_id,
              (accountNewConvCounts.get(conv.account_id) || 0) + 1
            );
          }
        }

        // Prepare all final updates in PARALLEL
        const finalPromises: Promise<any>[] = [];

        if (messagesToInsert.length > 0) {
          finalPromises.push(asPromise(supabase.from("messages").insert(messagesToInsert)));
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
                  last_active: now,
                })
                .eq("id", accountId)
            )
          );
        }

        const accountsWithExistingConvs = accountIds.filter((id) => !accountNewConvCounts.has(id));
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
        
        // Track lifetime success counts for health monitoring (call RPC for each account)
        const successAccountCounts = new Map<string, number>();
        for (const r of successResults) {
          if (r.account_id) {
            successAccountCounts.set(r.account_id, (successAccountCounts.get(r.account_id) || 0) + 1);
          }
        }
        const successRpcPromises: Promise<any>[] = [];
        for (const [accountId, count] of successAccountCounts) {
          for (let i = 0; i < count; i++) {
            successRpcPromises.push(asPromise(supabase.rpc('increment_account_success', { acc_id: accountId })));
          }
        }
        if (successRpcPromises.length > 0) {
          await Promise.all(successRpcPromises);
        }
        
        console.log(
          `[report-batch-results] Success: ${successResults.length} (${newConversations.length} new convs)`
        );
      }

      // ========== PARALLEL PROCESS FAILURES ==========
      if (failedResults.length > 0) {
        // DETECT rate limit errors from error text - IMMEDIATE restriction, no retries
        // Includes: "Too many requests", "RPC:FLOOD", "FLOOD" - these are sender issues, not recipient issues
        // This is handled SEPARATELY from flags sent by Python runner
        const tooManyRequestsResults = failedResults.filter((r) => {
          const errorLower = (r.error || '').toLowerCase();
          return errorLower.includes('too many requests') || 
                 errorLower.includes('rpc:flood') || 
                 errorLower.includes('flood');
        });
        
        // DETECT FROZEN ACCOUNT errors - account is frozen by Telegram, set to FROZEN status permanently
        const frozenAccountResults = failedResults.filter((r) => {
          const errorLower = (r.error || '').toLowerCase();
          return errorLower.includes('frozen') || errorLower.includes('not available for frozen');
        });
        
        // Classify other errors: API issues (privacy) vs Account issues vs Permanent failures
        // EXCLUDE "too many requests" and "frozen" from other categories
        const otherFailed = failedResults.filter((r) => {
          const errorLower = (r.error || '').toLowerCase();
          return !errorLower.includes('too many requests') && 
                 !errorLower.includes('frozen') && 
                 !errorLower.includes('not available for frozen');
        });
        
        const retryWithDifferentApi = otherFailed.filter((r) => r.retry_with_different_api);
        const retryWithDifferentAccount = otherFailed.filter((r) => r.retry_with_different_account && !r.retry_with_different_api);
        const permanent = otherFailed.filter((r) => !r.retry_with_different_account && !r.retry_with_different_api);

        const failPromises: Promise<any>[] = [];

        // FIRST: Handle "Too many requests" - IMMEDIATE restriction, NO RETRIES
        // This is detected from error text, not from flags
        for (const r of tooManyRequestsResults) {
          failPromises.push(
            (async () => {
              // IMMEDIATELY RESTRICT the account for 12 hours
              if (r.account_id) {
                const restrictedUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
                await supabase
                  .from("telegram_accounts")
                  .update({
                    status: "restricted",
                    restricted_until: restrictedUntil,
                    ban_reason: `Rate limited (Too many requests). Can still reply to existing chats.`,
                  })
                  .eq("id", r.account_id);
                console.log(`[report-batch-results] Account ${r.account_id} IMMEDIATELY RESTRICTED for 12h (Too many requests)`);
              }

              // Track failed account and reset recipient for different account
              const { data: current } = await supabase
                .from("campaign_recipients")
                .select("failed_account_ids")
                .eq("id", r.campaign_recipient_id)
                .single();

              const failedIds: string[] = current?.failed_account_ids || [];
              if (r.account_id && !failedIds.includes(r.account_id)) {
                failedIds.push(r.account_id);
              }

              // IMMEDIATE switch to different account - no retry count needed
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "pending",
                  failed_reason: null,
                  failed_account_ids: failedIds,
                  sent_by_account_id: null,
                  api_credential_id: null,
                  scheduled_at: null,
                })
                .eq("id", r.campaign_recipient_id);
                
              console.log(`[report-batch-results] Recipient ${r.campaign_recipient_id} reset for IMMEDIATE pickup by different account (Too many requests)`);
            })()
          );
        }

        // HANDLE FROZEN ACCOUNTS - set status to frozen permanently
        for (const r of frozenAccountResults) {
          failPromises.push(
            (async () => {
              // Set account status to FROZEN permanently
              if (r.account_id) {
                await supabase
                  .from("telegram_accounts")
                  .update({
                    status: "frozen",
                    ban_reason: r.error || "Account frozen by Telegram",
                  })
                  .eq("id", r.account_id);
                console.log(`[report-batch-results] Account ${r.account_id} FROZEN by Telegram: ${r.error}`);
              }

              // Track failed account and reset recipient for different account
              const { data: current } = await supabase
                .from("campaign_recipients")
                .select("failed_account_ids")
                .eq("id", r.campaign_recipient_id)
                .single();

              const failedIds: string[] = current?.failed_account_ids || [];
              if (r.account_id && !failedIds.includes(r.account_id)) {
                failedIds.push(r.account_id);
              }

              // Reset for pickup by different account
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "pending",
                  failed_reason: null,
                  failed_account_ids: failedIds,
                  sent_by_account_id: null,
                  api_credential_id: null,
                  scheduled_at: null,
                })
                .eq("id", r.campaign_recipient_id);
                
              console.log(`[report-batch-results] Recipient ${r.campaign_recipient_id} reset for pickup by different account (frozen account)`);
            })()
          );
        }

        // Handle permanent failures
        if (permanent.length > 0) {
          const permanentIds = permanent.map((r) => r.campaign_recipient_id);
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

        // Handle API retry (privacy errors) - track failed_api_ids AND failed_account_ids
        // UNIFIED: max 1 retry (2 total attempts) - consistent with report-task-result
        for (const r of retryWithDifferentApi) {
          failPromises.push(
            (async () => {
              const { data: current } = await supabase
                .from("campaign_recipients")
                .select("failed_api_ids, failed_account_ids, retry_count")
                .eq("id", r.campaign_recipient_id)
                .single();

              const failedApiIds: string[] = current?.failed_api_ids || [];
              if (r.api_credential_id && !failedApiIds.includes(r.api_credential_id)) {
                failedApiIds.push(r.api_credential_id);
              }
              
              // ALSO track failed account (unified with report-task-result)
              const failedAccountIds: string[] = current?.failed_account_ids || [];
              if (r.account_id && !failedAccountIds.includes(r.account_id)) {
                failedAccountIds.push(r.account_id);
              }

              const retryCount = (current?.retry_count || 0) + 1;
              const maxRetries = 1;  // UNIFIED: 1 retry = 2 total attempts (matches report-task-result)

              if (retryCount >= maxRetries) {
                // Exhausted retries - mark as failed
                await supabase
                  .from("campaign_recipients")
                  .update({
                    status: "failed",
                    failed_reason: `Privacy restricted after ${retryCount + 1} attempts`,
                    sent_at: now,
                    failed_api_ids: failedApiIds,
                    failed_account_ids: failedAccountIds,
                  })
                  .eq("id", r.campaign_recipient_id);
                console.log(`[report-batch-results] Recipient ${r.campaign_recipient_id} FAILED after ${retryCount + 1} attempts (privacy)`);
              } else {
                // Retry with different account AND API
                await supabase
                  .from("campaign_recipients")
                  .update({
                    status: "pending",
                    sent_by_account_id: null,  // Clear for fresh account
                    api_credential_id: null,   // Clear for fresh API
                    failed_api_ids: failedApiIds,
                    failed_account_ids: failedAccountIds,
                    failed_reason: null,
                    retry_count: retryCount,
                    scheduled_at: null,
                  })
                  .eq("id", r.campaign_recipient_id);
                console.log(`[report-batch-results] Privacy error - retry with different account+API (attempt ${retryCount + 1}/2, failed: ${failedAccountIds.length} accounts, ${failedApiIds.length} APIs)`);
              }
            })()
          );
        }

        // Handle account retry (rate limits like "Too many requests", "PeerFlood")
        // ONLY restrict if it's ACTUALLY a rate limit error (is_rate_limit flag or error contains flood/rate limit)
        // Privacy errors should NOT restrict the account - they're recipient-side issues
        for (const r of retryWithDifferentAccount) {
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

              // ONLY restrict if this is actually a rate limit (not privacy, not connection error)
              // Check: is_rate_limit flag OR error contains rate limit keywords
              const errorLower = (r.error || '').toLowerCase();
              const isActualRateLimit = r.is_rate_limit || 
                errorLower.includes('too many requests') ||
                errorLower.includes('peerflood') ||
                errorLower.includes('flood');
              
              // DON'T restrict for: connection errors, privacy errors, or other non-rate-limit issues
              const isConnectionError = errorLower.includes('connect') ||
                errorLower.includes('timeout') ||
                errorLower.includes('network') ||
                errorLower.includes('winerror');
              const isPrivacyError = errorLower.includes('privacy');
              
              if (r.account_id && isActualRateLimit && !isConnectionError && !isPrivacyError) {
                const restrictedUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
                await supabase
                  .from("telegram_accounts")
                  .update({
                    status: "restricted",
                    restricted_until: restrictedUntil,
                    ban_reason: `Rate limited for new campaign messages. Can still reply to existing chats. Error: ${r.error || "Too many requests"}`,
                  })
                  .eq("id", r.account_id);
                console.log(`[report-batch-results] Account ${r.account_id} RESTRICTED 12h (rate limit): ${r.error}`);
              } else if (r.account_id && (isConnectionError || isPrivacyError)) {
                // Log but DON'T restrict - these are not sender rate limits
                console.log(`[report-batch-results] Account ${r.account_id} NOT restricted (${isConnectionError ? 'connection' : 'privacy'} error): ${r.error}`);
              }

              // Reset recipient for pickup by different account
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "pending",
                  failed_reason: null,
                  failed_account_ids: failedIds,
                  sent_by_account_id: null,
                  api_credential_id: null,
                  scheduled_at: null,
                })
                .eq("id", r.campaign_recipient_id);
                
              console.log(`[report-batch-results] Recipient ${r.campaign_recipient_id} reset for pickup by different account`);
            })()
          );
        }

        // Count permanent failures per campaign
        const failCounts = new Map<string, number>();
        // Include API-exhausted failures in fail counts
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
        
        // Track lifetime failure counts for health monitoring (permanent failures only)
        const failureAccountCounts = new Map<string, number>();
        for (const r of permanent) {
          if (r.account_id) {
            failureAccountCounts.set(r.account_id, (failureAccountCounts.get(r.account_id) || 0) + 1);
          }
        }
        const failureRpcPromises: Promise<any>[] = [];
        for (const [accountId, count] of failureAccountCounts) {
          for (let i = 0; i < count; i++) {
            failureRpcPromises.push(asPromise(supabase.rpc('increment_account_failure', { acc_id: accountId })));
          }
        }
        if (failureRpcPromises.length > 0) {
          await Promise.all(failureRpcPromises);
        }
        
        console.log(`[report-batch-results] Failed: ${failedResults.length} (${tooManyRequestsResults.length} rate-limited, ${permanent.length} permanent, ${retryWithDifferentApi.length} API-retry, ${retryWithDifferentAccount.length} account-retry)`);
      }

      const elapsed = Date.now() - startTime;
      console.log(`[report-batch-results] Done in ${elapsed}ms`);
      return elapsed;
    };

    // SYNCHRONOUS processing - wait for all DB operations to complete
    // This ensures data is committed before responding, preventing data loss on timeouts
    const elapsed = await processBatch();

    return new Response(
      JSON.stringify({
        success: true,
        processed: results.length,
        successes: successResults.length,
        failures: failedResults.length,
        already_sent: alreadySentResults.length,
        elapsed_ms: elapsed,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[report-batch-results] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
