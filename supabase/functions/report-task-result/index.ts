import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordApiUsage } from "../_shared/api-helper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// In-memory request deduplication cache (per-isolate)
// Key: requestId, Value: timestamp
const requestCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minute deduplication window
const MAX_CACHE_SIZE = 10000; // Prevent memory leaks

// Generate deterministic request ID for deduplication
function generateRequestId(taskType: string, result: any): string {
  const key = taskType === 'send' 
    ? `send:${result.campaign_recipient_id || result.message_id}:${result.account_id}:${result.success}`
    : taskType === 'warmup_chat' || taskType === 'warmup_add_contact'
    ? `warmup:${result.task_id}:${result.account_id}:${result.success}`
    : `${taskType}:${result.task_id || result.account_id}:${result.success}`;
  return key;
}

// Check if request was recently processed (deduplicated)
function isDuplicate(requestId: string): boolean {
  const now = Date.now();
  
  // Clean expired entries periodically (every 100th call)
  if (requestCache.size > MAX_CACHE_SIZE / 2 && Math.random() < 0.01) {
    for (const [key, timestamp] of requestCache.entries()) {
      if (now - timestamp > DEDUP_WINDOW_MS) {
        requestCache.delete(key);
      }
    }
  }
  
  const cachedTime = requestCache.get(requestId);
  if (cachedTime && now - cachedTime < DEDUP_WINDOW_MS) {
    return true; // Duplicate within window
  }
  
  // Add to cache (trim if too large)
  if (requestCache.size >= MAX_CACHE_SIZE) {
    const firstKey = requestCache.keys().next().value;
    if (firstKey) requestCache.delete(firstKey);
  }
  requestCache.set(requestId, now);
  
  return false;
}

// Helper function to detect and handle FROZEN accounts from error messages
// Should be called for ALL task types that can fail
async function checkAndMarkFrozenAccount(supabase: any, accountId: string, error: string): Promise<boolean> {
  if (!error || !accountId) return false;
  
  const errorLower = error.toLowerCase();
  
  // Check for FROZEN account patterns - comprehensive list
  const frozenPatterns = [
    'frozen',
    'frozen accounts',
    'not available for frozen',
    'account is frozen',
    'updateprofilerequest',  // Common frozen error
  ];
  
  const isFrozen = frozenPatterns.some(p => errorLower.includes(p));
  
  if (isFrozen) {
    console.log(`[frozen-detection] Account ${accountId} FROZEN detected in error: ${error}`);
    
    try {
      const { error: updateError } = await supabase
        .from("telegram_accounts")
        .update({
          status: "frozen",
          ban_reason: error,
          last_active: new Date().toISOString(),
        })
        .eq("id", accountId);
      
      if (updateError) {
        console.error(`[frozen-detection] Failed to update account ${accountId}:`, updateError);
      } else {
        console.log(`[frozen-detection] Successfully marked account ${accountId} as FROZEN`);
      }
    } catch (err) {
      console.error(`[frozen-detection] Exception updating account ${accountId}:`, err);
    }
    
    return true;
  }
  
  return false;
}

// Helper function to check and auto-complete campaigns when all recipients are processed
async function checkAndAutoCompleteCampaign(supabase: any, campaignId: string) {
  try {
    // Check if campaign is still running
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("status, name")
      .eq("id", campaignId)
      .single();
    
    if (!campaign || campaign.status !== "running") {
      return; // Campaign is not running, skip auto-complete check
    }
    
    // Count recipients by status
    const { data: statusCounts, error: countError } = await supabase
      .from("campaign_recipients")
      .select("status")
      .eq("campaign_id", campaignId);
    
    if (countError || !statusCounts) {
      console.log(`[auto-complete] Error checking recipients for campaign ${campaignId}:`, countError);
      return;
    }
    
    const pendingCount = statusCounts.filter((r: any) => r.status === "pending").length;
    const sendingCount = statusCounts.filter((r: any) => r.status === "sending").length;
    const queuedCount = statusCounts.filter((r: any) => r.status === "queued").length;
    
    // If no pending, sending, or queued recipients left, auto-complete the campaign
    if (pendingCount === 0 && sendingCount === 0 && queuedCount === 0) {
      const { error: updateError } = await supabase
        .from("campaigns")
        .update({
          status: "completed",
          updated_at: new Date().toISOString()
        })
        .eq("id", campaignId)
        .eq("status", "running"); // Only update if still running
      
      if (!updateError) {
        console.log(`[auto-complete] ✅ Campaign "${campaign.name}" (${campaignId}) auto-completed - all recipients processed`);
      } else {
        console.log(`[auto-complete] Error auto-completing campaign ${campaignId}:`, updateError);
      }
    } else {
      console.log(`[auto-complete] Campaign ${campaignId} has ${pendingCount} pending, ${sendingCount} sending, ${queuedCount} queued - not ready to complete`);
    }
  } catch (err) {
    console.error(`[auto-complete] Exception checking campaign ${campaignId}:`, err);
  }
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

    const body = await req.json();
    const { task_type, result } = body;

    // ==================== REQUEST DEDUPLICATION ====================
    // Prevent duplicate processing of the same task result
    const requestId = generateRequestId(task_type, result);
    if (isDuplicate(requestId)) {
      console.log(`[report-task-result] DEDUP: Ignoring duplicate request ${requestId}`);
      return new Response(
        JSON.stringify({ success: true, deduplicated: true, request_id: requestId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[report-task-result] Task type: ${task_type}, request_id: ${requestId.substring(0, 50)}`);

    switch (task_type) {
      case "send": {
        let { message_id, success, error, campaign_recipient_id, account_id, content, recipient_phone, recipient_name, recipient_telegram_id, recipient_username, skip_account, retry_with_different_account, api_credential_id } = result;
        let isNewConversation = false; // Track if this is first message to a new contact

        if (success) {
          // RECORD API USAGE ON SUCCESS (this is the only place usage is incremented)
          if (api_credential_id) {
            await recordApiUsage(supabase, api_credential_id);
            console.log(`[report-task-result] Recorded API usage for ${api_credential_id}`);
          }
          
          // For campaign messages: Create conversation and message ONLY on successful send
          if (campaign_recipient_id && account_id) {
            // FALLBACK: If content/recipient_phone/name are missing, fetch from campaign_recipients
            // Also fetch seat_id - prioritize recipient-level seat_id over campaign-level
            let recipientSeatId: string | null = null;
            
            const { data: recipientData } = await supabase
              .from("campaign_recipients")
              .select("phone_number, name, seat_id, campaign_id, campaigns(id, name, message_template, seat_id)")
              .eq("id", campaign_recipient_id)
              .single();
            
            let campaignId: string | null = null;
            let campaignName: string | null = null;
            
            if (recipientData) {
              recipient_phone = recipient_phone || recipientData.phone_number;
              recipient_name = recipient_name || recipientData.name;
              // Prioritize recipient-level seat_id (for multi-seat campaigns), fallback to campaign-level
              recipientSeatId = recipientData.seat_id || (recipientData.campaigns as any)?.seat_id || null;
              campaignId = (recipientData.campaigns as any)?.id || null;
              campaignName = (recipientData.campaigns as any)?.name || null;
              if (!content) {
                const template = (recipientData.campaigns as any)?.message_template || '';
                content = template
                  .replace(/{name}/g, recipientData.name || 'there')
                  .replace(/{phone}/g, recipientData.phone_number);
              }
              console.log(`[report-task-result] Fetched recipient data: phone=${recipient_phone}, seat_id=${recipientSeatId}, campaign=${campaignName}`);
            }
            
            // Get or create conversation
            let conversationId: string | null = null;
            
            const { data: existingConv } = await supabase
              .from("conversations")
              .select("id")
              .eq("account_id", account_id)
              .eq("recipient_phone", recipient_phone)
              .maybeSingle();

            if (existingConv) {
              conversationId = existingConv.id;
              console.log(`[report-task-result] Using existing conversation ${conversationId}`);
            } else {
              // Create new conversation only on successful delivery
              // Include seat_id from campaign for proper workspace routing
              // Also include campaign_id and campaign_name for history preservation
              isNewConversation = true;
              const { data: newConv, error: convError } = await supabase
                .from("conversations")
                .insert({
                  account_id: account_id,
                  recipient_phone: recipient_phone,
                  recipient_name: recipient_name,
                  is_active: true,
                  first_message_sent: true,
                  last_message_at: new Date().toISOString(),
                  seat_id: recipientSeatId,  // Route to correct seat workspace (recipient-level > campaign-level)
                  campaign_id: campaignId,  // Link to campaign for reference
                  campaign_name: campaignName,  // Store name for history display after deletion
                })
                .select()
                .single();

              if (convError) {
                console.error(`[report-task-result] Error creating conversation:`, convError);
                isNewConversation = false;
              } else {
                conversationId = newConv.id;
                console.log(`[report-task-result] Created new conversation ${conversationId} for campaign ${campaignName}`);
              }
            }

            // If the sender resolved the recipient, persist it for faster future replies
            if (conversationId && (recipient_telegram_id || recipient_username)) {
              const updateFields: Record<string, unknown> = {};
              if (recipient_telegram_id) updateFields.recipient_telegram_id = recipient_telegram_id;
              if (recipient_username) updateFields.recipient_username = recipient_username;
              await supabase.from("conversations").update(updateFields).eq("id", conversationId);
            }

            // Create message record for the sent message
            if (conversationId) {
              const { error: msgError } = await supabase
                .from("messages")
                .insert({
                  account_id: account_id,
                  conversation_id: conversationId,
                  content: content || '',
                  direction: 'outgoing',
                  status: 'sent',
                  delivered_at: new Date().toISOString(),
                  campaign_recipient_id: campaign_recipient_id,
                  api_credential_id: api_credential_id || null, // Track which API was used
                });

              if (msgError) {
                console.error(`[report-task-result] Error creating message:`, msgError);
              }
            }

            // Update campaign recipient status with API used
            await supabase
              .from("campaign_recipients")
              .update({
                status: "sent",
                sent_at: new Date().toISOString(),
                api_credential_id: api_credential_id || null, // Track which API was used
              })
              .eq("id", campaign_recipient_id);

            // Get campaign_id and recipient phone, then increment sent_count and mark contact as used
            const { data: recipient } = await supabase
              .from("campaign_recipients")
              .select("campaign_id, phone_number")
              .eq("id", campaign_recipient_id)
              .single();

            if (recipient?.campaign_id) {
              const { data: campaign } = await supabase
                .from("campaigns")
                .select("sent_count")
                .eq("id", recipient.campaign_id)
                .single();

              if (campaign) {
                await supabase
                  .from("campaigns")
                  .update({ sent_count: (campaign.sent_count || 0) + 1 })
                  .eq("id", recipient.campaign_id);
              }

              // Auto-mark contact as used in contacts_data (only on successful send)
              if (recipient.phone_number) {
                const { error: updateContactError } = await supabase
                  .from("contacts_data")
                  .update({
                    is_used: true,
                    used_at: new Date().toISOString(),
                    used_in_campaign_id: recipient.campaign_id
                  })
                  .eq("phone_number", recipient.phone_number);

                if (updateContactError) {
                  console.log(`[report-task-result] Could not mark contact as used (may not exist in contacts_data): ${updateContactError.message}`);
                } else {
                  console.log(`[report-task-result] Marked contact ${recipient.phone_number} as used`);
                }
              }
              
              // Check if campaign should auto-complete (all recipients processed)
              await checkAndAutoCompleteCampaign(supabase, recipient.campaign_id);
            }
          } else if (message_id) {
            // Non-campaign message: just update existing message status
            await supabase
              .from("messages")
              .update({
                status: "sent",
                delivered_at: new Date().toISOString(),
              })
              .eq("id", message_id)
              .in("status", ["pending", "sending"]);

            // Persist resolved recipient identifiers to speed up future sends
            if (recipient_telegram_id || recipient_username) {
              const { data: msgRow } = await supabase
                .from("messages")
                .select("conversation_id")
                .eq("id", message_id)
                .maybeSingle();

              if (msgRow?.conversation_id) {
                const updateFields: Record<string, unknown> = {};
                if (recipient_telegram_id) updateFields.recipient_telegram_id = recipient_telegram_id;
                if (recipient_username) updateFields.recipient_username = recipient_username;
                await supabase.from("conversations").update(updateFields).eq("id", msgRow.conversation_id);
              }
            }
          }

          // Increment account message count ONLY for new contacts (first message to this recipient)
          // For campaign messages: only if we created a new conversation
          // For live chat replies: don't count (message_id without campaign_recipient_id means it's a reply)
          const shouldCountMessage = campaign_recipient_id ? isNewConversation : false;

          if (shouldCountMessage && account_id) {
            const { data: account } = await supabase
              .from("telegram_accounts")
              .select("messages_sent_today, status")
              .eq("id", account_id)
              .single();

            if (account) {
              const newCount = (account.messages_sent_today || 0) + 1;
              const dailyLimit = 5; // Default daily limit
              
              // Check if account has hit daily quota - auto-restrict for 12 hours
              if (newCount >= dailyLimit) {
                const restrictedUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12 hours from now
                await supabase
                  .from("telegram_accounts")
                  .update({
                    messages_sent_today: newCount,
                    last_active: new Date().toISOString(),
                    restricted_until: restrictedUntil,
                  })
                  .eq("id", account_id);

                console.log(`[report-task-result] Account ${account_id} hit daily quota (${newCount}/${dailyLimit}). Restricted until ${restrictedUntil}`);
              } else {
                await supabase
                  .from("telegram_accounts")
                  .update({
                    messages_sent_today: newCount,
                    last_active: new Date().toISOString(),
                  })
                  .eq("id", account_id);

                console.log(`[report-task-result] Incremented message count for account ${account_id} (new contact). New count=${newCount}/${dailyLimit}`);
              }
            }
          } else if (account_id) {
            // Just update last_active for replies, don't count
            await supabase
              .from("telegram_accounts")
              .update({ last_active: new Date().toISOString() })
              .eq("id", account_id);
          }
          
          // Update last_campaign_send_at for campaign messages (rate limiting support)
          if (campaign_recipient_id && account_id) {
            await supabase
              .from("telegram_accounts")
              .update({ last_campaign_send_at: new Date().toISOString() })
              .eq("id", account_id);
            console.log(`[report-task-result] Updated last_campaign_send_at for account ${account_id}`);
          }

          // Track account success for health monitoring
          if (account_id) {
            await supabase.rpc('increment_account_success', { acc_id: account_id });
            console.log(`[report-task-result] Incremented success count for account ${account_id}`);
          }

          console.log(`[report-task-result] Message sent successfully for recipient ${campaign_recipient_id || message_id}`);
        } else {
          // Separate PERMANENT ban errors from TEMPORARY restrictions
          // IMPORTANT: Be specific to avoid false positives (e.g. "user was deleted" = recipient, not sender)
          const permanentBanErrors = [
            'deactivated',
            'user_deactivated', 
            'input_user_deactivated',
            'auth_key_unregistered',
            'session_revoked',
            'phone_number_banned',
            'your account',       // "Your account was deleted/banned"
            'account deleted',    // Sender's account deleted (not "user was deleted")
            'account was banned'
          ];
          
          // Errors that should RESTRICT account (12h cooldown for new messages, but can still chat)
          // PeerFlood = too many messages to new users - account needs 12h cooldown but can still chat with existing contacts
          // Privacy restricted = sender account is limited from messaging new users (NOT a recipient setting!)
          const temporaryRestrictionErrors = [
            'flood',
            'spam',
            'user_is_blocked',
            'floodwaiterror',    // Telegram flood wait error
            'peerflood',         // Too many messages to new users - 12h cooldown
            'account restricted', // Only match if it says "account restricted"
            'privacy restricted', // ADD: Sender is restricted from messaging new contacts
            'userprivacyrestrictederror', // ADD: Telethon error class name
            'privacy',           // ADD: Generic privacy error - sender limitation
          ];
          
          // FROZEN account errors - account is frozen by Telegram, set to FROZEN status permanently
          // This is NOT a temporary restriction - account cannot be used anymore
          const frozenAccountErrors = [
            'frozen',
            'frozen accounts',
            'not available for frozen',
          ];
          
          // "Too many requests (caused by SendMessageRequest)" - IMMEDIATE 12h cooldown with NO RETRIES
          // This is a sender-side rate limit when sending new messages - account goes to cooldown immediately
          // IMPORTANT: Only match this SPECIFIC error - other "Too many requests" errors have different causes
          // Only applies to NEW campaign messages, NOT to replies in existing conversations
          const tooManyRequestsSendMessage = [
            'too many requests (caused by sendmessagerequest)',
          ];
          
          // Errors that should just SKIP the recipient (don't affect account status)
          // These are RECIPIENT-related issues - mark recipient as FAILED
          // IMPORTANT: Check these FIRST before other error types!
          const skipRecipientErrors = [
            'user not found',        // Recipient doesn't have Telegram
            'no user',               // Recipient doesn't exist
            'peer_id_invalid',       // Invalid recipient ID
            'user was deleted',      // RECIPIENT deleted their account (not sender!)
            'specified user',        // "The specified user was deleted"
            'user deleted',          // Recipient deleted their account
            // Official Telegram RECIPIENT errors
            'phone_number_invalid',      // Recipient phone format is wrong
            'phone_number_unoccupied',   // Recipient is NOT on Telegram
          ];
          
          // NEW: Account session/API errors - DO NOT skip recipient, retry with different account
          const accountSessionErrors = [
            'api_id_invalid',           // API credentials invalid
            'phone_code_hash_empty',    // Session issue
            'phone_code_empty',         // Session issue
            'phone_code_expired',       // Session expired
            'type_constructor_invalid', // Protocol/session issue
            'firstname_invalid',        // Account setup issue
            'lastname_invalid',         // Account setup issue
          ];
          
          // Media/file errors - skip this operation, not a recipient issue
          const mediaFileErrors = [
            'file_part_invalid',
            'file_parts_invalid',
            'file_part_',  // catches FILE_PART_X_MISSING
            'md5_checksum_invalid',
            'photo_invalid_dimensions',
            'field_name_invalid',
            'field_name_empty',
          ];
          
          // Errors that should RETRY with a DIFFERENT API (not account)
          // NOTE: Privacy errors moved to temporaryRestrictionErrors - they are sender limitations
          const retryWithDifferentApiErrors: string[] = [
            // Privacy removed - it's a sender account restriction, not API issue
          ];
          
          const errorLower = (error || '').toLowerCase();
          
          // Check for "Too many requests (caused by SendMessageRequest)" FIRST - this is IMMEDIATE 12h cooldown, no retries
          const isTooManyRequests = tooManyRequestsSendMessage.some((r: string) => errorLower.includes(r));
          
          // Check for FROZEN account errors - these are permanent, not temporary
          const isFrozenAccount = frozenAccountErrors.some(r => errorLower.includes(r));
          
          // Check for ACCOUNT session/API errors - should mark account as disconnected, retry recipient with different account
          const isAccountSessionError = accountSessionErrors.some(r => errorLower.includes(r));
          
          // Check for media/file errors - skip operation but don't affect account or recipient
          const isMediaError = mediaFileErrors.some(r => errorLower.includes(r));
          
          // Check for API retry errors
          const isApiRetryable = !isTooManyRequests && !isFrozenAccount && !isAccountSessionError && retryWithDifferentApiErrors.some(r => errorLower.includes(r));
          
          // CRITICAL: Check skip-only errors - these are recipient problems that can't be retried
          const isSkipOnly = !isTooManyRequests && !isFrozenAccount && !isApiRetryable && !isAccountSessionError && skipRecipientErrors.some(r => errorLower.includes(r));
          
          // Only check account-related errors if it's NOT a recipient error, API-retryable, frozen, session error, or too many requests
          const isPermanentBan = !isSkipOnly && !isApiRetryable && !isTooManyRequests && !isFrozenAccount && !isAccountSessionError && permanentBanErrors.some(r => errorLower.includes(r));
          const isTemporaryRestriction = !isSkipOnly && !isApiRetryable && !isTooManyRequests && !isFrozenAccount && !isAccountSessionError && temporaryRestrictionErrors.some(r => errorLower.includes(r));
          
          // Track account failure for health monitoring (only for account-related errors, not recipient/API issues)
          // Skip-only errors are recipient problems, API-retryable are API problems - neither affects account stats
          if (account_id && !isSkipOnly && !isApiRetryable && !isMediaError) {
            await supabase.rpc('increment_account_failure', { acc_id: account_id });
            console.log(`[report-task-result] Incremented failure count for account ${account_id}`);
          }
          
          // PRIVACY ERROR RETRY LOGIC: Retry with DIFFERENT ACCOUNT using least-used API
          // Only 1 retry allowed (2 total attempts) - if still fails, mark as failed
          if (isApiRetryable && campaign_recipient_id) {
            console.log(`[report-task-result] Privacy error - will retry with DIFFERENT ACCOUNT using least-used API: ${error}`);
            
            // Get current recipient data INCLUDING account and API info
            const { data: currentRecipient } = await supabase
              .from("campaign_recipients")
              .select("retry_count, campaign_id, api_credential_id, failed_api_ids, sent_by_account_id, failed_account_ids")
              .eq("id", campaign_recipient_id)
              .single();
            
            // TRACK FAILED API AND ACCOUNT
            const failedApiIds: string[] = currentRecipient?.failed_api_ids || [];
            const failedAccountIds: string[] = currentRecipient?.failed_account_ids || [];
            
            const currentApiId = currentRecipient?.api_credential_id;
            if (currentApiId && !failedApiIds.includes(currentApiId)) {
              failedApiIds.push(currentApiId);
            }
            
            // Also track the account that failed
            if (account_id && !failedAccountIds.includes(account_id)) {
              failedAccountIds.push(account_id);
            }
            
            console.log(`[report-task-result] Privacy error - tracked failed API: ${currentApiId}, account: ${account_id}`);
            
            const retryCount = (currentRecipient?.retry_count || 0) + 1;
            const maxRetries = 1; // Only 1 retry (2 total attempts) - use DIFFERENT ACCOUNT with least-used API
            
            if (retryCount > maxRetries) {
              // Already retried once - mark as failed with RAW error
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "failed",
                  failed_reason: error,  // Raw error - no prefixes
                  sent_at: new Date().toISOString(),
                  failed_api_ids: failedApiIds,
                  failed_account_ids: failedAccountIds,
                })
                .eq("id", campaign_recipient_id);
              
              if (currentRecipient?.campaign_id) {
                await supabase.rpc("increment_campaign_failed_count", { cid: currentRecipient.campaign_id });
              }
              
              console.log(`[report-task-result] Recipient ${campaign_recipient_id} FAILED after 2 attempts: ${error}`);
            } else {
              // RETRY with DIFFERENT ACCOUNT (which will get assigned least-used API by get-batch-tasks)
              // Clear both account AND API to force complete reassignment
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "pending",
                  sent_by_account_id: null,  // CRITICAL: Clear account to force new assignment
                  api_credential_id: null,    // Clear API - will get least-used API
                  failed_api_ids: failedApiIds,
                  failed_account_ids: failedAccountIds,  // Track failed accounts to avoid them
                  failed_reason: null,
                  retry_count: retryCount
                })
                .eq("id", campaign_recipient_id);
              
              console.log(`[report-task-result] Privacy error - recipient reset for DIFFERENT ACCOUNT with least-used API (attempt ${retryCount + 1}/2)`);
            }
          } else if (isPermanentBan && account_id) {
            // PERMANENT BAN - mark account as banned, cannot be used anymore
            console.log(`[report-task-result] Account ${account_id} PERMANENTLY BANNED: ${error}`);
            
            await supabase
              .from("telegram_accounts")
              .update({
                status: "banned",
                ban_reason: error,
              })
              .eq("id", account_id);
          } else if (isTemporaryRestriction && account_id) {
            // TEMPORARY RESTRICTION - mark account as restricted for 12 hours
            // IMPORTANT: Only apply restriction for CAMPAIGN messages (new outreach)
            // For LIVE CHAT messages (existing conversations), PeerFlood should NOT restrict
            // because the recipient is already a contact - just mark message as failed
            if (campaign_recipient_id) {
              console.log(`[report-task-result] Account ${account_id} TEMPORARILY RESTRICTED for 12h (campaign message): ${error}`);
              
              await supabase
                .from("telegram_accounts")
                .update({
                  restricted_until: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
                  ban_reason: error,
                })
                .eq("id", account_id);
            } else {
              // Live chat message - DON'T restrict account, just log the error
              // PeerFlood for existing contacts is unusual but shouldn't restrict the account
              console.log(`[report-task-result] PeerFlood on LIVE CHAT for account ${account_id} - NOT restricting (existing conversation): ${error}`);
            }
          } else if (isFrozenAccount && account_id) {
            // FROZEN ACCOUNT - account is frozen by Telegram, set to FROZEN status permanently
            // This is NOT a temporary restriction - account cannot be used for campaigns anymore
            console.log(`[report-task-result] Account ${account_id} FROZEN by Telegram: ${error}`);
            
            await supabase
              .from("telegram_accounts")
              .update({
                status: "frozen",
                ban_reason: error,
              })
              .eq("id", account_id);
            
            // If this was a campaign message, retry with different account
            if (campaign_recipient_id) {
              const { data: currentRecipient } = await supabase
                .from("campaign_recipients")
                .select("failed_account_ids")
                .eq("id", campaign_recipient_id)
                .single();
              
              const failedAccountIds: string[] = currentRecipient?.failed_account_ids || [];
              if (!failedAccountIds.includes(account_id)) {
                failedAccountIds.push(account_id);
              }
              
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "pending",
                  sent_by_account_id: null,
                  api_credential_id: null,
                  failed_reason: null,
                  failed_account_ids: failedAccountIds,
                  scheduled_at: null,
                })
                .eq("id", campaign_recipient_id);
                
              console.log(`[report-task-result] Recipient ${campaign_recipient_id} reset for pickup by different account (frozen account)`);
            }
          } else if (isAccountSessionError && account_id) {
            // ACCOUNT SESSION/API ERROR - mark account as disconnected, retry recipient with different account
            // These are account-specific issues (invalid API, expired session) - NOT recipient problems
            console.log(`[report-task-result] Account ${account_id} session/API error - marking disconnected: ${error}`);
            
            await supabase
              .from("telegram_accounts")
              .update({
                status: "disconnected",
                ban_reason: error,  // Raw error
              })
              .eq("id", account_id);
            
            // If this was a campaign message, retry with different account
            if (campaign_recipient_id) {
              const { data: currentRecipient } = await supabase
                .from("campaign_recipients")
                .select("failed_account_ids")
                .eq("id", campaign_recipient_id)
                .single();
              
              const failedAccountIds: string[] = currentRecipient?.failed_account_ids || [];
              if (!failedAccountIds.includes(account_id)) {
                failedAccountIds.push(account_id);
              }
              
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "pending",
                  sent_by_account_id: null,
                  api_credential_id: null,
                  failed_reason: null,
                  failed_account_ids: failedAccountIds,
                  scheduled_at: null,
                })
                .eq("id", campaign_recipient_id);
                
              console.log(`[report-task-result] Recipient ${campaign_recipient_id} reset for pickup by different account (account session error)`);
            }
          } else if (isMediaError) {
            // MEDIA/FILE ERROR - just log and skip, don't affect account or recipient status
            console.log(`[report-task-result] Media/file error - skipping operation: ${error}`);
            // The Python runner should handle retrying without media if needed
          } else if (isTooManyRequests && campaign_recipient_id && account_id) {
            // RATE LIMIT ("Too many requests") - IMMEDIATELY restrict account for 12h and switch to different account
            // NO RETRIES - instant switch. This error only happens on NEW campaign messages (first contact)
            // The restricted account can STILL handle existing conversations (replies, ongoing chats)
            console.log(`[report-task-result] Account ${account_id} rate limited (Too many requests) - setting 12h cooldown and switching account`);
            
            const restrictedUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
            await supabase
              .from("telegram_accounts")
              .update({
                status: "cooldown",
                restricted_until: restrictedUntil,
                ban_reason: error || "Too many requests",
              })
              .eq("id", account_id);
            
            console.log(`[report-task-result] Account ${account_id} now in COOLDOWN until ${restrictedUntil} (can still reply to existing conversations)`);
            
            // Reset recipient to pending for IMMEDIATE retry with different account
            // Track failed account to prevent reassignment
            const { data: currentRecipient } = await supabase
              .from("campaign_recipients")
              .select("failed_account_ids")
              .eq("id", campaign_recipient_id)
              .single();
            
            const failedAccountIds: string[] = currentRecipient?.failed_account_ids || [];
            if (!failedAccountIds.includes(account_id)) {
              failedAccountIds.push(account_id);
            }
            
            // IMMEDIATE switch - no retry count, no delay
            await supabase
              .from("campaign_recipients")
              .update({
                status: "pending",
                sent_by_account_id: null,
                api_credential_id: null,
                failed_reason: null,
                failed_account_ids: failedAccountIds,
                scheduled_at: null,  // Clear scheduling for immediate pickup
              })
              .eq("id", campaign_recipient_id);
              
            console.log(`[report-task-result] Recipient ${campaign_recipient_id} reset for IMMEDIATE pickup by different account`);
          } else if (isSkipOnly && campaign_recipient_id) {
            // SKIP-ONLY: Recipient issue (not account) - mark as failed immediately
            console.log(`[report-task-result] Recipient issue (skip-only) - marking as failed: ${error}`);
            
            const { data: recipient } = await supabase
              .from("campaign_recipients")
              .select("campaign_id")
              .eq("id", campaign_recipient_id)
              .single();
            
            await supabase
              .from("campaign_recipients")
              .update({
                status: "failed",
                failed_reason: error,
                sent_at: new Date().toISOString(),
              })
              .eq("id", campaign_recipient_id);
            
            if (recipient?.campaign_id) {
              await supabase.rpc("increment_campaign_failed_count", { cid: recipient.campaign_id });
              
              // Check if campaign should auto-complete after marking this recipient failed
              await checkAndAutoCompleteCampaign(supabase, recipient.campaign_id);
            }
          }

          // AUTOMATIC ACCOUNT ROTATION: Try to reassign to next available account (with retry limit)
          // SKIP if the error was already handled by specific error handlers above (privacy, skip-only, etc.)
          if (campaign_recipient_id && !isTooManyRequests && !isSkipOnly && !isApiRetryable) {
            const MAX_RETRIES = 3; // Stop retrying after 3 failed attempts
            
            // Get recipient details including campaign and retry count
            const { data: recipient } = await supabase
              .from("campaign_recipients")
              .select("campaign_id, sent_by_account_id, retry_count")
              .eq("id", campaign_recipient_id)
              .single();

            if (recipient?.campaign_id) {
              const currentRetryCount = recipient.retry_count || 0;
              const failedAccountId = account_id || recipient.sent_by_account_id;
              
              // Check if we've exceeded max retries
              if (currentRetryCount >= MAX_RETRIES) {
                // TOO MANY RETRIES: Mark as permanently failed
                await supabase
                  .from("campaign_recipients")
                  .update({ 
                    status: "failed",
                    failed_reason: `Failed after ${MAX_RETRIES} attempts: ${error}`
                  })
                  .eq("id", campaign_recipient_id);

                // Increment campaign failed_count
                const { data: campaign } = await supabase
                  .from("campaigns")
                  .select("failed_count")
                  .eq("id", recipient.campaign_id)
                  .single();

                if (campaign) {
                  await supabase
                    .from("campaigns")
                    .update({ failed_count: (campaign.failed_count || 0) + 1 })
                    .eq("id", recipient.campaign_id);
                }
                
                // Check if campaign should auto-complete after marking this recipient failed
                await checkAndAutoCompleteCampaign(supabase, recipient.campaign_id);
                
                console.log(`[report-task-result] MAX RETRIES (${MAX_RETRIES}) reached - marked recipient as permanently failed: ${error}`);
              } else {
                // Find OTHER active accounts assigned to this campaign
                const { data: campaignAccounts } = await supabase
                  .from("campaign_accounts")
                  .select("account_id, telegram_accounts!inner(id, status, messages_sent_today, daily_limit, restricted_until)")
                  .eq("campaign_id", recipient.campaign_id)
                  .neq("account_id", failedAccountId);
                
                // Filter to only usable accounts (active, under limit, not temporarily restricted)
                const now = new Date().toISOString();
                const usableAccounts = (campaignAccounts || []).filter((ca: any) => {
                  const acc = ca.telegram_accounts;
                  if (!acc || acc.status !== 'active') return false;
                  const limit = acc.daily_limit ?? 25;
                  const sentToday = acc.messages_sent_today ?? 0;
                  const isRestricted = acc.restricted_until && acc.restricted_until > now;
                  return sentToday < limit && !isRestricted;
                });
                
                if (usableAccounts.length > 0) {
                  // REASSIGN: Pick the first available account, increment retry count
                  const nextAccount = usableAccounts[0];
                  await supabase
                    .from("campaign_recipients")
                    .update({ 
                      status: "pending",
                      sent_by_account_id: nextAccount.account_id,
                      failed_reason: null,
                      retry_count: currentRetryCount + 1  // Increment retry counter
                    })
                    .eq("id", campaign_recipient_id)
                    .in("status", ["sending", "pending"]);
                  
                  console.log(`[report-task-result] AUTO-ROTATION: Reassigned recipient ${campaign_recipient_id.slice(0, 8)} (retry ${currentRetryCount + 1}/${MAX_RETRIES}) from account ${failedAccountId?.slice(0, 8)} to ${nextAccount.account_id.slice(0, 8)}`);
                } else {
                  // NO OTHER ACCOUNTS: Mark as failed
                  await supabase
                    .from("campaign_recipients")
                    .update({ 
                      status: "failed",
                      failed_reason: error
                    })
                    .eq("id", campaign_recipient_id);

                  // Increment campaign failed_count
                  const { data: campaign } = await supabase
                    .from("campaigns")
                    .select("failed_count, name")
                    .eq("id", recipient.campaign_id)
                    .single();

                  if (campaign) {
                    await supabase
                      .from("campaigns")
                      .update({ failed_count: (campaign.failed_count || 0) + 1 })
                      .eq("id", recipient.campaign_id);
                  }
                  
                  // Check if campaign should auto-complete after marking this recipient failed
                  await checkAndAutoCompleteCampaign(supabase, recipient.campaign_id);
                  
                  console.log(`[report-task-result] No other accounts available - marked recipient as failed: ${error}`);
                }
              }
            }
          }

          if (message_id) {
            // Non-campaign message: update existing message as failed
            await supabase
              .from("messages")
              .update({
                status: "failed",
                failed_reason: error,
              })
              .eq("id", message_id)
              .in("status", ["pending", "sending"]);
          }

          console.log(`[report-task-result] Message failed for recipient ${campaign_recipient_id || message_id}: ${error}`);
        }
        break;
      }

      case "validate": {
        const { recipient_id, exists, name, telegram_id } = result;

        if (exists) {
          await supabase
            .from("campaign_recipients")
            .update({
              status: "pending",
              name: name || null,
            })
            .eq("id", recipient_id);
          console.log(`[report-task-result] Recipient ${recipient_id} validated: ${name}`);
        } else {
          await supabase
            .from("campaign_recipients")
            .update({ status: "invalid" })
            .eq("id", recipient_id);
          console.log(`[report-task-result] Recipient ${recipient_id} invalid`);
        }
        break;
      }

      case "spambot_check": {
        const { task_id, account_id, status, ban_reason, restricted_until, response } = result;

        // Keep account active even if spambot says "restricted" - it can still chat
        // Only set to 'banned' if truly banned
        const finalStatus = status === 'restricted' ? 'active' : status;

        // Update account status
        const updateData: Record<string, unknown> = {
          status: finalStatus,
          spambot_status: status, // Store original spambot response
          last_spambot_check: new Date().toISOString(),
        };
        if (ban_reason) updateData.ban_reason = ban_reason;
        if (restricted_until) updateData.restricted_until = restricted_until;

        await supabase
          .from("telegram_accounts")
          .update(updateData)
          .eq("id", account_id);

        // Update task
        await supabase
          .from("account_check_tasks")
          .update({
            status: "completed",
            result: response,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] SpamBot check completed for ${account_id}: ${status} (status kept as ${finalStatus})`);
        break;
      }

      case "incoming_message": {
        const {
          account_id,
          sender_id,
          sender_name,
          sender_username,
          sender_phone,
          sender_avatar,
          content,
          media_url,
          media_type,
          telegram_message_id,
        } = result;

        console.log(`[report-task-result] Processing incoming message from sender_id=${sender_id}, username=${sender_username}, phone=${sender_phone}, telegram_msg_id=${telegram_message_id}, has_avatar=${!!sender_avatar}`);

        // DEDUPLICATION Strategy 1: Check by telegram_message_id (most reliable)
        if (telegram_message_id && account_id) {
          const { data: existingMsg } = await supabase
            .from("messages")
            .select("id")
            .eq("account_id", account_id)
            .eq("telegram_message_id", telegram_message_id)
            .eq("direction", "incoming")
            .limit(1);

          if (existingMsg && existingMsg.length > 0) {
            console.log(`[report-task-result] SKIPPED: Duplicate message detected (telegram_message_id=${telegram_message_id} already exists)`);
            return new Response(
              JSON.stringify({ success: true, skipped: true, reason: "duplicate" }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }

        // DEDUPLICATION Strategy 2: Content-based fallback (catches messages without telegram_message_id or legacy duplicates)
        // Check if same content from same sender within last 24 hours exists
        // SKIP content-based dedup for media messages - they all have "[Photo] " or "[Video] " content
        const isMediaMessage = media_type && (content?.startsWith("[Photo]") || content?.startsWith("[Video]") || content?.startsWith("[File]"));
        
        if (account_id && sender_id && content && !isMediaMessage) {
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          
          // First find conversations with this sender
          const { data: senderConvs } = await supabase
            .from("conversations")
            .select("id")
            .eq("account_id", account_id)
            .eq("recipient_telegram_id", sender_id);
          
          if (senderConvs && senderConvs.length > 0) {
            const convIds = senderConvs.map(c => c.id);
            
            const { data: existingContentMsg } = await supabase
              .from("messages")
              .select("id, created_at")
              .in("conversation_id", convIds)
              .eq("content", content)
              .eq("direction", "incoming")
              .gte("created_at", twentyFourHoursAgo)
              .limit(1);

            if (existingContentMsg && existingContentMsg.length > 0) {
              console.log(`[report-task-result] SKIPPED: Content-based duplicate detected (same content "${content.substring(0, 30)}..." from sender ${sender_id} within 24h)`);
              return new Response(
                JSON.stringify({ success: true, skipped: true, reason: "content_duplicate" }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
          }
        }

        // Find or create conversation with improved matching
        // Use phone number or telegram_id as unique identifier - NEVER use generic "Contact" name
        const phoneDisplay = sender_phone || (sender_username ? `@${sender_username}` : `ID:${sender_id}`);
        const displayName = sender_name && sender_name !== 'Contact' ? sender_name : phoneDisplay;
        let convId = null;
        let existingConvData = null;

        // Priority 1: Try to find by telegram_id first (most reliable)
        if (sender_id) {
          const { data: existingConv } = await supabase
            .from("conversations")
            .select("*")
            .eq("account_id", account_id)
            .eq("recipient_telegram_id", sender_id)
            .limit(1);

          if (existingConv && existingConv.length > 0) {
            convId = existingConv[0].id;
            existingConvData = existingConv[0];
            console.log(`[report-task-result] Found conversation by telegram_id: ${convId}`);
          }
        }

        // Priority 2: Try to find by username (with and without @)
        if (!convId && sender_username) {
          const usernameVariants = [
            `@${sender_username}`,
            sender_username,
            sender_username.replace(/^@/, '')
          ];
          
          for (const variant of usernameVariants) {
            const { data: usernameConv } = await supabase
              .from("conversations")
              .select("*")
              .eq("account_id", account_id)
              .or(`recipient_username.eq.${variant},recipient_phone.eq.${variant}`)
              .limit(1);

            if (usernameConv && usernameConv.length > 0) {
              convId = usernameConv[0].id;
              existingConvData = usernameConv[0];
              console.log(`[report-task-result] Found conversation by username variant ${variant}: ${convId}`);
              break;
            }
          }
        }

        // Priority 3: Try to find by phone number with multiple formats
        if (!convId && sender_phone) {
          const phoneClean = sender_phone.replace(/[^\d]/g, '');
          const phoneVariants = [
            sender_phone,
            `+${phoneClean}`,
            phoneClean,
            sender_phone.replace(/^\+/, '')
          ];
          
          for (const variant of phoneVariants) {
            const { data: phoneConv } = await supabase
              .from("conversations")
              .select("*")
              .eq("account_id", account_id)
              .eq("recipient_phone", variant)
              .limit(1);

            if (phoneConv && phoneConv.length > 0) {
              convId = phoneConv[0].id;
              existingConvData = phoneConv[0];
              console.log(`[report-task-result] Found conversation by phone variant ${variant}: ${convId}`);
              break;
            }
          }
        }

        // Priority 4: Check campaign_recipients for matching phone and link to that conversation
        // Only match by phone number - do NOT use generic unlinked conversation matching
        if (!convId && sender_phone) {
          console.log(`[report-task-result] Searching campaign recipients for phone match...`);
          
          const phoneClean = sender_phone.replace(/[^\d]/g, '');
          const { data: campaignRecipient } = await supabase
            .from("campaign_recipients")
            .select("*, messages!inner(conversation_id, account_id)")
            .or(`phone_number.eq.${sender_phone},phone_number.eq.+${phoneClean},phone_number.eq.${phoneClean}`)
            .limit(1);

          if (campaignRecipient && campaignRecipient.length > 0) {
            const msgs = campaignRecipient[0].messages as any[];
            const matchingMsg = msgs.find((m: any) => m.account_id === account_id);
            if (matchingMsg?.conversation_id) {
              const { data: conv } = await supabase
                .from("conversations")
                .select("*")
                .eq("id", matchingMsg.conversation_id)
                .single();
              
              if (conv) {
                convId = conv.id;
                existingConvData = conv;
                console.log(`[report-task-result] Found conversation via campaign recipient: ${convId}`);
              }
            }
          }
        }

        // Update existing conversation with sender info (link telegram_id)
        if (convId && existingConvData) {
          const updateData: Record<string, unknown> = {
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            unread_count: (existingConvData.unread_count || 0) + 1,
            is_active: true,
          };
          
          // Always update telegram_id if we have it
          if (sender_id) {
            updateData.recipient_telegram_id = sender_id;
          }
          // Only update name if we have a real name (not generic "Contact")
          if (sender_name && sender_name !== 'Contact') {
            updateData.recipient_name = sender_name;
          } else if (!existingConvData.recipient_name || existingConvData.recipient_name === 'Contact') {
            // Use phone/username/id as name if current name is generic
            updateData.recipient_name = phoneDisplay;
          }
          if (sender_username) {
            updateData.recipient_username = `@${sender_username}`;
          }
          if (sender_phone) {
            updateData.recipient_phone = sender_phone;
          }
          // Update avatar if we have one
          if (sender_avatar) {
            updateData.recipient_avatar = `data:image/jpeg;base64,${sender_avatar}`;
          }

          await supabase
            .from("conversations")
            .update(updateData)
            .eq("id", convId);
            
          console.log(`[report-task-result] Updated conversation ${convId} with telegram_id=${sender_id}, has_avatar=${!!sender_avatar}`);
        }

        if (!convId) {
          // DO NOT create new conversations for incoming messages
          // The Python runner should have already filtered this - if we can't find
          // an existing conversation, it means:
          // 1. Phone/username format mismatch from campaign send
          // 2. The runner filter failed
          // Either way, we should NOT create orphan conversations
          console.log(`[report-task-result] WARNING: Could not find existing conversation for incoming message from sender_id=${sender_id}, phone=${sender_phone}, username=${sender_username} - SKIPPING (no conversation created)`);
          
          return new Response(
            JSON.stringify({ 
              success: false, 
              warning: "No matching campaign conversation found - message ignored" 
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (convId) {
          // Save message with telegram_message_id for deduplication
          await supabase.from("messages").insert({
            account_id,
            conversation_id: convId,
            content,
            direction: "incoming",
            status: "delivered",
            delivered_at: new Date().toISOString(),
            media_url: media_url || null,
            media_type: media_type || null,
            telegram_message_id: telegram_message_id || null,
          });

          // Also update campaign reply count if this conversation was from a campaign
          const { data: campaignMsg } = await supabase
            .from("messages")
            .select("campaign_recipient_id")
            .eq("conversation_id", convId)
            .not("campaign_recipient_id", "is", null)
            .limit(1);

          if (campaignMsg && campaignMsg.length > 0 && campaignMsg[0].campaign_recipient_id) {
            const { data: recipient } = await supabase
              .from("campaign_recipients")
              .select("campaign_id")
              .eq("id", campaignMsg[0].campaign_recipient_id)
              .single();

            if (recipient?.campaign_id) {
              const { data: campaign } = await supabase
                .from("campaigns")
                .select("reply_count")
                .eq("id", recipient.campaign_id)
                .single();

              if (campaign) {
                await supabase
                  .from("campaigns")
                  .update({ reply_count: (campaign.reply_count || 0) + 1 })
                  .eq("id", recipient.campaign_id);
                console.log(`[report-task-result] Incremented reply_count for campaign ${recipient.campaign_id}`);
              }
            }
          }

          console.log(`[report-task-result] Incoming message saved from ${sender_name || sender_id} to conversation ${convId}`);
        } else {
          console.log(`[report-task-result] ERROR: Could not find or create conversation for sender ${sender_id}`);
        }
        break;
      }

      case "account_connected": {
        const { account_id, first_name, last_name, username, telegram_id, phone, avatar_base64, skip_profile_update } = result;

        // If skip_profile_update is true, only update last_active
        if (skip_profile_update) {
          await supabase
            .from("telegram_accounts")
            .update({
              status: "active",
              last_active: new Date().toISOString(),
            })
            .eq("id", account_id);
          console.log(`[report-task-result] Account ${account_id} connected (cached profile)`);
          break;
        }

        const updateData: Record<string, unknown> = {
          status: "active",
          last_active: new Date().toISOString(),
        };
        if (first_name) updateData.first_name = first_name;
        if (last_name) updateData.last_name = last_name;
        if (username) updateData.username = username;
        if (telegram_id) updateData.telegram_id = telegram_id;
        if (phone) updateData.phone_number = `+${phone}`;
        if (avatar_base64) updateData.avatar_url = `data:image/jpeg;base64,${avatar_base64}`;

        await supabase
          .from("telegram_accounts")
          .update(updateData)
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} connected with profile sync`);
        break;
      }

      case "account_disconnected": {
        const { account_id, reason } = result;

        await supabase
          .from("telegram_accounts")
          .update({ 
            status: "disconnected",
            ban_reason: reason || "Session expired"
          })
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} disconnected: ${reason}`);
        break;
      }

      case "proxy_error": {
        // Proxy connection failed - mark proxy as error but DO NOT change account proxy assignment
        // STRICT 1:1 POLICY: Admin must manually fix proxy in dashboard
        // IMPORTANT: Do NOT set ban_reason - we can't know session status if proxy fails
        const { account_id, reason, proxy_id } = result;

        // Only update disabled_reason - DO NOT change proxy_id, status, or ban_reason
        // We can't determine if session is valid when proxy fails
        await supabase
          .from("telegram_accounts")
          .update({ 
            disabled_reason: `Proxy error: ${reason || "Connection failed"}`,
            // Clear ban_reason since we can't verify session status with broken proxy
            ban_reason: null
            // NOTE: We do NOT change status, proxy_id, or any fingerprint data
          })
          .eq("id", account_id);

        // If we have the proxy_id (as UUID), mark it as error
        if (proxy_id) {
          // Try as UUID first
          if (proxy_id.includes("-")) {
            await supabase
              .from("proxies")
              .update({ 
                status: "error",
                last_checked: new Date().toISOString()
              })
              .eq("id", proxy_id);
            console.log(`[report-task-result] Marked proxy ${proxy_id} as error (by UUID)`);
          } else {
            // Try as host:port format
            const [host, portStr] = proxy_id.split(":");
            if (host && portStr) {
              await supabase
                .from("proxies")
                .update({ 
                  status: "error",
                  last_checked: new Date().toISOString()
                })
                .eq("host", host)
                .eq("port", parseInt(portStr));
              console.log(`[report-task-result] Marked proxy ${proxy_id} as error (by host:port)`);
            }
          }
        }

        // Log to proxy_errors table
        if (proxy_id && proxy_id.includes("-")) {
          await supabase
            .from("proxy_errors")
            .insert({
              proxy_id: proxy_id,
              error_message: `Proxy error: ${reason || "Connection failed"}`,
              error_type: "proxy_connection_failed"
            });
        }

        console.log(`[report-task-result] Account ${account_id} PROXY ERROR: ${reason}`);
        console.log(`[report-task-result] NOTE: Proxy assignment unchanged - admin must fix in dashboard`);
        break;
      }

      case "proxy_max_retries_exceeded": {
        // Account has failed proxy connection 3 times with 3-minute delays between each
        // Mark as DISCONNECTED with auto_disabled so it won't be picked up until admin fixes
        const { account_id, reason, retry_count } = result;

        console.log(`[report-task-result] Account ${account_id} EXCEEDED MAX PROXY RETRIES (${retry_count}x)`);

        // Mark account as disconnected with auto_disabled - requires admin intervention
        await supabase
          .from("telegram_accounts")
          .update({
            status: "disconnected",
            disabled_reason: `Proxy error: Failed ${retry_count}x (3-min intervals) - requires admin fix`,
            auto_disabled: true,
            last_active: new Date().toISOString()
          })
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} marked as DISCONNECTED + auto_disabled`);
        console.log(`[report-task-result] Admin must fix proxy and manually reactivate account`);
        break;
      }

      case "proxy_success":
      case "connection_success": {
        // Account connected successfully via proxy - mark proxy as active and clear any errors
        const { account_id, proxy_id, response_time } = result;

        // Clear disabled_reason since connection worked
        if (account_id) {
          await supabase
            .from("telegram_accounts")
            .update({ 
              disabled_reason: null,
              last_active: new Date().toISOString()
            })
            .eq("id", account_id);
        }

        // Mark proxy as active since connection succeeded
        if (proxy_id) {
          // Try as UUID first
          if (proxy_id.includes("-")) {
            await supabase
              .from("proxies")
              .update({ 
                status: "active",
                last_checked: new Date().toISOString(),
                response_time: response_time || null
              })
              .eq("id", proxy_id);
            console.log(`[report-task-result] Marked proxy ${proxy_id} as ACTIVE (connection succeeded)`);
          } else {
            // Try as host:port format
            const [host, portStr] = proxy_id.split(":");
            if (host && portStr) {
              await supabase
                .from("proxies")
                .update({ 
                  status: "active",
                  last_checked: new Date().toISOString(),
                  response_time: response_time || null
                })
                .eq("host", host)
                .eq("port", parseInt(portStr));
              console.log(`[report-task-result] Marked proxy ${host}:${portStr} as ACTIVE (connection succeeded)`);
            }
          }
        } else if (account_id) {
          // If no proxy_id provided, lookup from account
          const { data: accountData } = await supabase
            .from("telegram_accounts")
            .select("proxy_id")
            .eq("id", account_id)
            .single();

          if (accountData?.proxy_id) {
            await supabase
              .from("proxies")
              .update({ 
                status: "active",
                last_checked: new Date().toISOString(),
                response_time: response_time || null
              })
              .eq("id", accountData.proxy_id);
            console.log(`[report-task-result] Marked proxy ${accountData.proxy_id} as ACTIVE (via account lookup)`);
          }
        }

        console.log(`[report-task-result] Account ${account_id} connected successfully via proxy`);
        break;
      }

      case "account_banned": {
        const { account_id, reason } = result;

        await supabase
          .from("telegram_accounts")
          .update({ 
            status: "banned",
            ban_reason: reason || "Account banned by Telegram"
          })
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} BANNED by Telegram: ${reason}`);
        break;
      }

      case "account_frozen": {
        // Account deleted/deactivated by user (not by Telegram) - this is a PERMANENT state
        const { account_id, reason, telegram_id } = result;

        const updateData: Record<string, unknown> = { 
          status: "banned",  // Permanent - user deleted their account, use banned not frozen
          ban_reason: reason || "Account deleted by user"
        };
        
        if (telegram_id) {
          updateData.telegram_id = telegram_id;
        }

        await supabase
          .from("telegram_accounts")
          .update(updateData)
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} BANNED (user-deleted): ${reason}`);
        break;
      }

      case "change_name": {
        const { task_id, account_id, success, error, first_name, last_name } = result;

        // Check for frozen account error FIRST
        if (!success && error && account_id) {
          await checkAndMarkFrozenAccount(supabase, account_id, error);
        }

        if (success) {
          // Update account name in database
          await supabase
            .from("telegram_accounts")
            .update({
              first_name: first_name || null,
              last_name: last_name || null,
              last_active: new Date().toISOString(),
            })
            .eq("id", account_id);
        }

        // Update task
        await supabase
          .from("account_check_tasks")
          .update({
            status: success ? "completed" : "failed",
            result: success ? "Name changed" : error,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] Name change ${success ? "completed" : "failed"} for ${account_id}`);
        break;
      }

      case "privacy_settings": {
        const { task_id, account_id, success, error } = result;

        // Check for frozen account error FIRST
        if (!success && error && account_id) {
          await checkAndMarkFrozenAccount(supabase, account_id, error);
        }

        await supabase
          .from("account_check_tasks")
          .update({
            status: success ? "completed" : "failed",
            result: success ? "Privacy settings updated" : error,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] Privacy settings ${success ? "completed" : "failed"} for ${account_id}`);
        break;
      }

      case "change_password": {
        const { task_id, account_id, success, error } = result;

        // Check for frozen account error FIRST
        if (!success && error && account_id) {
          await checkAndMarkFrozenAccount(supabase, account_id, error);
        }

        await supabase
          .from("account_check_tasks")
          .update({
            status: success ? "completed" : "failed",
            result: success ? "Password changed" : error,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] Password change ${success ? "completed" : "failed"} for ${account_id}`);
        break;
      }

      case "logout_sessions": {
        const { task_id, account_id, success, error } = result;

        // Check for frozen account error FIRST
        if (!success && error && account_id) {
          await checkAndMarkFrozenAccount(supabase, account_id, error);
        }

        await supabase
          .from("account_check_tasks")
          .update({
            status: success ? "completed" : "failed",
            result: success ? "Other sessions logged out" : error,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] Logout sessions ${success ? "completed" : "failed"} for ${account_id}`);
        break;
      }

      case "change_photo": {
        const { task_id, account_id, success, error, avatar_url } = result;

        // Check for frozen account error FIRST
        if (!success && error && account_id) {
          await checkAndMarkFrozenAccount(supabase, account_id, error);
        }

        if (success && avatar_url) {
          await supabase
            .from("telegram_accounts")
            .update({
              avatar_url: avatar_url,
              last_active: new Date().toISOString(),
            })
            .eq("id", account_id);
        }

        await supabase
          .from("account_check_tasks")
          .update({
            status: success ? "completed" : "failed",
            result: success ? "Photo changed" : error,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] Photo change ${success ? "completed" : "failed"} for ${account_id}`);
        break;
      }

      case "sync_profile": {
        const { task_id, account_id, success, error, first_name, last_name, username, telegram_id, avatar_url } = result;

        // Check for frozen account error FIRST
        if (!success && error && account_id) {
          await checkAndMarkFrozenAccount(supabase, account_id, error);
        }

        if (success) {
          // Update the account with synced profile data
          const updateData: Record<string, unknown> = {
            last_active: new Date().toISOString(),
          };
          
          if (first_name !== undefined) updateData.first_name = first_name;
          if (last_name !== undefined) updateData.last_name = last_name;
          if (username !== undefined) updateData.username = username;
          if (telegram_id !== undefined) updateData.telegram_id = telegram_id;
          if (avatar_url) updateData.avatar_url = avatar_url;

          await supabase
            .from("telegram_accounts")
            .update(updateData)
            .eq("id", account_id);

          console.log(`[report-task-result] Profile sync completed for ${account_id}: name=${first_name} ${last_name}, username=${username}, has_avatar=${!!avatar_url}`);
        }

        await supabase
          .from("account_check_tasks")
          .update({
            status: success ? "completed" : "failed",
            result: success ? "Profile synced" : error,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] Profile sync ${success ? "completed" : "failed"} for ${account_id}`);
        break;
      }

      case "verify_session": {
        const { task_id, account_id, status, error, user_data } = result;

        // Only update task status if "skip" - account status was already handled by get_or_create_client
        if (status === "skip") {
          await supabase
            .from("account_check_tasks")
            .update({
              status: "completed",
              result: "Status already reported during connection",
              completed_at: new Date().toISOString(),
            })
            .eq("id", task_id);
          console.log(`[report-task-result] Session verification for ${account_id}: skipped (already reported)`);
          break;
        }

        // Update account status based on verification result
        const updateData: Record<string, unknown> = {
          last_active: new Date().toISOString(),
        };

        if (status === "active") {
          updateData.status = "active";
          updateData.ban_reason = null; // Clear any previous ban reason
          // Update user data if provided
          if (user_data) {
            if (user_data.telegram_id) updateData.telegram_id = user_data.telegram_id;
            if (user_data.username) updateData.username = user_data.username;
            if (user_data.first_name) updateData.first_name = user_data.first_name;
            if (user_data.last_name) updateData.last_name = user_data.last_name;
          }
        } else if (status === "banned") {
          updateData.status = "banned";
          updateData.ban_reason = error || "banned";
        } else if (status === "frozen") {
          // FROZEN: Account is temporarily restricted by Telegram
          updateData.status = "frozen";
          updateData.ban_reason = error || "frozen";
          updateData.restricted_until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
          // Keep user data if provided
          if (user_data) {
            if (user_data.telegram_id) updateData.telegram_id = user_data.telegram_id;
            if (user_data.username) updateData.username = user_data.username;
            if (user_data.first_name) updateData.first_name = user_data.first_name;
            if (user_data.last_name) updateData.last_name = user_data.last_name;
          }
        } else {
          updateData.status = "disconnected";
          updateData.ban_reason = error || "disconnected";
        }

        await supabase
          .from("telegram_accounts")
          .update(updateData)
          .eq("id", account_id);

        // Update task status
        await supabase
          .from("account_check_tasks")
          .update({
            status: "completed",
            result: status === "active" ? "Session verified - active" : `${status}: ${error || 'Unknown error'}`,
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id);

        console.log(`[report-task-result] Session verification for ${account_id}: ${status}${error ? ` (${error})` : ''}`);
        break;
      }
      case "fingerprint_generated": {
        // ONLY save fingerprint if account doesn't already have one
        // NEVER overwrite existing fingerprints
        const { account_id, device_model, system_version, app_version, lang_code, system_lang_code } = result;

        // Check if account already has fingerprint data
        const { data: existing } = await supabase
          .from("telegram_accounts")
          .select("device_model, system_version")
          .eq("id", account_id)
          .single();

        if (existing?.device_model && existing?.system_version) {
          console.log(`[report-task-result] Fingerprint already exists for ${account_id}, SKIPPING update`);
          break;
        }

        // Only update if no fingerprint exists
        await supabase
          .from("telegram_accounts")
          .update({
            device_model,
            system_version,
            app_version,
            lang_code,
            system_lang_code,
          })
          .eq("id", account_id);

        console.log(`[report-task-result] Fingerprint saved for ${account_id}: ${device_model} (${system_version})`);
        break;
      }

      case "session_updated": {
        // CRITICAL: Persist updated session file (with entity cache) back to database
        // This preserves:
        // 1. Entity cache (access_hash values for contacts/users) - reduces API calls
        // 2. Authentication state - maintains session continuity
        // 3. Update state (pts, qts) - proper event ordering
        const { account_id, session_data } = result;

        if (!account_id || !session_data) {
          console.log(`[report-task-result] session_updated: Missing account_id or session_data`);
          break;
        }

        // Validate session is proper base64 SQLite format
        try {
          // Decode and check SQLite header
          const sessionBytes = Uint8Array.from(atob(session_data), c => c.charCodeAt(0));
          
          if (sessionBytes.length < 16) {
            console.log(`[report-task-result] session_updated: Session too small (${sessionBytes.length} bytes)`);
            break;
          }

          // Check SQLite magic header: "SQLite format 3\0"
          const sqliteHeader = new TextDecoder().decode(sessionBytes.slice(0, 15));
          if (sqliteHeader !== 'SQLite format 3') {
            console.log(`[report-task-result] session_updated: Invalid SQLite header for ${account_id}`);
            break;
          }

          // Update session_data and last_active
          const { error: updateError } = await supabase
            .from("telegram_accounts")
            .update({
              session_data: session_data,
              last_active: new Date().toISOString(),
            })
            .eq("id", account_id);

          if (updateError) {
            console.error(`[report-task-result] session_updated: Update failed for ${account_id}:`, updateError);
          } else {
            console.log(`[report-task-result] Session cache saved for ${account_id} (${sessionBytes.length} bytes)`);
          }
        } catch (e) {
          console.error(`[report-task-result] session_updated: Validation failed for ${account_id}:`, e);
        }
        break;
      }

      case "warmup": {
        const { task_id, task_type: warmupType, account_id, success, error, channel } = result;

        // Check if it's an interaction task (from interaction_scheduler)
        if (warmupType === "interaction") {
          await supabase
            .from("interaction_scheduler")
            .update({
              status: success ? "completed" : "failed",
              sent_at: success ? new Date().toISOString() : null,
            })
            .eq("id", task_id);
          
          console.log(`[report-task-result] Interaction ${success ? "completed" : "failed"}`);
        } else {
          // Regular warmup task (from warmup_schedule)
          await supabase
            .from("warmup_schedule")
            .update({
              status: success ? "completed" : "failed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", task_id);

          // Also try maturation_tasks for backwards compatibility
          await supabase
            .from("maturation_tasks")
            .update({
              status: success ? "completed" : "failed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", task_id);
          
          console.log(`[report-task-result] Warmup ${warmupType} ${success ? "completed" : "failed"} for ${account_id}: ${channel || ""}`);
        }

        // Update account last_active
        if (account_id) {
          await supabase
            .from("telegram_accounts")
            .update({ last_active: new Date().toISOString() })
            .eq("id", account_id);
        }
        break;
      }

      case "contact_import": {
        const { 
          task_id, 
          success,
          valid_numbers, 
          invalid_numbers, 
          account_failed, 
          failed_account_id,
          remaining_numbers,
          error 
        } = result;
        
        // Check for consecutive invalid numbers - switch account after 5
        const CONSECUTIVE_INVALID_THRESHOLD = 5;
        const invalidArr = invalid_numbers || [];
        const validArr = valid_numbers || [];
        
        // Calculate consecutive invalid at the end of this batch
        let consecutiveInvalidAtEnd = 0;
        if (invalidArr.length > 0 && remaining_numbers && remaining_numbers.length > 0) {
          // Count how many invalid numbers are at the end (no valid in between)
          // Simple heuristic: if last 5+ were invalid, trigger switch
          const totalProcessed = validArr.length + invalidArr.length;
          if (totalProcessed >= CONSECUTIVE_INVALID_THRESHOLD) {
            // Check if all recent are invalid (simple: if no valid found recently)
            // We track by checking if invalid count is growing without valid
            const { data: task } = await supabase
              .from("contact_import_tasks")
              .select("valid_numbers, invalid_numbers, failed_account_ids")
              .eq("id", task_id)
              .single();
            
            const prevValid = (task?.valid_numbers as string[] || []).length;
            const prevInvalid = (task?.invalid_numbers as string[] || []).length;
            const newValid = validArr.length - prevValid;
            const newInvalid = invalidArr.length - prevInvalid;
            
            // If we got 5+ new invalid and 0 new valid, switch account
            if (newInvalid >= CONSECUTIVE_INVALID_THRESHOLD && newValid === 0) {
              console.log(`[report-task-result] ${newInvalid} consecutive invalid numbers - switching account`);
              
              const existingFailed: string[] = task?.failed_account_ids || [];
              const currentAccountId = failed_account_id || result.current_account_id;
              const newFailed = currentAccountId ? [...existingFailed, currentAccountId] : existingFailed;
              
              await supabase
                .from("contact_import_tasks")
                .update({
                  status: "pending",
                  failed_account_ids: newFailed,
                  remaining_numbers: remaining_numbers || [],
                  valid_numbers: validArr,
                  invalid_numbers: invalidArr,
                  current_account_id: null,
                  result: `Switched account after ${newInvalid} consecutive invalid numbers`
                })
                .eq("id", task_id);
              
              break;
            }
          }
        }
        
        if (account_failed && failed_account_id) {
          // Account failed - update task to retry with different account
          const { data: task } = await supabase
            .from("contact_import_tasks")
            .select("failed_account_ids")
            .eq("id", task_id)
            .single();
          
          const existingFailed: string[] = task?.failed_account_ids || [];
          const newFailed = [...existingFailed, failed_account_id];
          
          await supabase
            .from("contact_import_tasks")
            .update({
              status: "pending", // Reset to pending so it gets picked up again
              failed_account_ids: newFailed,
              remaining_numbers: remaining_numbers || [],
              valid_numbers: validArr,
              invalid_numbers: invalidArr,
              current_account_id: null,
              result: error || "Account failed, retrying with different account"
            })
            .eq("id", task_id);
          
          console.log(`[report-task-result] Contact import task ${task_id} - account ${failed_account_id} failed, will retry`);
        } else if (success) {
          // All done - insert valid contacts and complete task
          const { data: task } = await supabase
            .from("contact_import_tasks")
            .select("tag_id")
            .eq("id", task_id)
            .single();
          
          if (task?.tag_id && validArr.length > 0) {
            // Insert valid contacts
            const contactsToInsert = validArr.map((phone: string) => ({
              phone_number: phone,
              tag_id: task.tag_id,
              is_used: false,
            }));
            
            // Upsert to avoid duplicates
            for (const contact of contactsToInsert) {
              await supabase
                .from("contacts_data")
                .upsert(contact, { onConflict: "phone_number" });
            }
            
            console.log(`[report-task-result] Inserted ${validArr.length} valid contacts`);
          }
          
          await supabase
            .from("contact_import_tasks")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              valid_numbers: validArr,
              invalid_numbers: invalidArr,
              result: `Added ${validArr.length} contacts, ${invalidArr.length} invalid`
            })
            .eq("id", task_id);
          
          console.log(`[report-task-result] Contact import completed: ${validArr.length} valid, ${invalidArr.length} invalid`);
        } else {
          // Task failed completely
          await supabase
            .from("contact_import_tasks")
            .update({
              status: "failed",
              completed_at: new Date().toISOString(),
              result: error || "Import failed"
            })
            .eq("id", task_id);
          
          console.log(`[report-task-result] Contact import failed: ${error}`);
        }
        break;
      }

      case "contact_import_complete": {
        const { task_id, tag_id, valid_numbers, invalid_numbers, account_id } = result;

        // Get current task state to merge results (accumulate across multiple reports)
        const { data: existingTask } = await supabase
          .from("contact_import_tasks")
          .select("status, completed_at, valid_numbers, invalid_numbers, phone_numbers, failed_account_ids, current_account_id")
          .eq("id", task_id)
          .maybeSingle();

        // Merge incoming numbers with existing ones (deduplicate)
        const existingValid: string[] = (existingTask?.valid_numbers as string[]) || [];
        const existingInvalid: string[] = (existingTask?.invalid_numbers as string[]) || [];
        const incomingValid: string[] = valid_numbers || [];
        const incomingInvalid: string[] = invalid_numbers || [];
        
        const mergedValid = Array.from(new Set([...existingValid, ...incomingValid]));
        const mergedInvalid = Array.from(new Set([...existingInvalid, ...incomingInvalid]));
        
        // Calculate how many numbers have been processed
        const totalSubmitted = (existingTask?.phone_numbers as string[])?.length || 0;
        const totalProcessed = mergedValid.length + mergedInvalid.length;
        const isComplete = totalProcessed >= totalSubmitted;

        console.log(`[report-task-result] Contact import progress: ${totalProcessed}/${totalSubmitted} (valid=${mergedValid.length}, invalid=${mergedInvalid.length}, complete=${isComplete})`);

        // CHECK: If all numbers are invalid (0 valid) and we have 10+ numbers checked, 
        // this might be an account issue - retry with different account
        const MIN_NUMBERS_FOR_RETRY = 10;
        const currentAccountId = account_id || existingTask?.current_account_id;
        const existingFailed: string[] = (existingTask?.failed_account_ids as string[]) || [];
        
        if (isComplete && mergedValid.length === 0 && mergedInvalid.length >= MIN_NUMBERS_FOR_RETRY) {
          // Check if we've already tried with this account
          if (currentAccountId && !existingFailed.includes(currentAccountId)) {
            // First time this account failed with all invalid - retry with different account
            const newFailed = [...existingFailed, currentAccountId];
            
            console.log(`[report-task-result] All ${mergedInvalid.length} numbers invalid - switching account (tried: ${newFailed.length})`);
            
            // Only retry if we haven't tried too many accounts (max 3 retries)
            if (newFailed.length < 3) {
              await supabase
                .from("contact_import_tasks")
                .update({
                  status: "pending",
                  failed_account_ids: newFailed,
                  remaining_numbers: existingTask?.phone_numbers || [],
                  valid_numbers: [],
                  invalid_numbers: [],
                  current_account_id: null,
                  result: `Retrying with different account (attempt ${newFailed.length + 1}/3)`
                })
                .eq("id", task_id);
              
              break;
            }
          }
        }

        // Insert valid contacts (upsert to avoid duplicates)
        if (tag_id && incomingValid.length > 0) {
          const contactsToInsert = incomingValid.map((phone: string) => ({
            phone_number: phone,
            tag_id: tag_id,
            is_used: false,
          }));

          for (const contact of contactsToInsert) {
            await supabase
              .from("contacts_data")
              .upsert(contact, { onConflict: "phone_number" });
          }

          console.log(`[report-task-result] Inserted ${incomingValid.length} valid contacts`);
        }

        // Update task with merged results
        await supabase
          .from("contact_import_tasks")
          .update({
            status: isComplete ? "completed" : "in_progress",
            completed_at: isComplete ? new Date().toISOString() : null,
            valid_numbers: mergedValid,
            invalid_numbers: mergedInvalid,
            result: isComplete 
              ? `Added ${mergedValid.length} contacts, ${mergedInvalid.length} invalid`
              : `Processing: ${totalProcessed}/${totalSubmitted}`,
          })
          .eq("id", task_id);

        console.log(
          `[report-task-result] Contact import ${isComplete ? 'completed' : 'in progress'}: ${mergedValid.length} valid, ${mergedInvalid.length} invalid`
        );
        break;
      }

      case "contact_import_failed": {
        const { task_id, account_id, valid_numbers, invalid_numbers, remaining_numbers, error } = result;

        // Idempotency guard: don't downgrade/overwrite a task that's already completed
        const { data: existingTask } = await supabase
          .from("contact_import_tasks")
          .select("status, completed_at, failed_account_ids")
          .eq("id", task_id)
          .maybeSingle();

        if (existingTask?.status === "completed" && existingTask?.completed_at) {
          console.log(
            `[report-task-result] Contact import task ${task_id} already completed - ignoring failure report from account ${account_id}`
          );
          break;
        }

        const existingFailed: string[] = (existingTask?.failed_account_ids as any) || [];
        const newFailed = Array.from(new Set([...(existingFailed || []), account_id].filter(Boolean)));

        await supabase
          .from("contact_import_tasks")
          .update({
            status: "pending", // Reset to pending so it gets picked up again
            failed_account_ids: newFailed,
            remaining_numbers: remaining_numbers || [],
            valid_numbers: valid_numbers || [],
            invalid_numbers: invalid_numbers || [],
            current_account_id: null,
            result: error || "Account failed, retrying with different account",
          })
          .eq("id", task_id);

        console.log(
          `[report-task-result] Contact import - account ${account_id} failed, will retry with another account`
        );
        break;
      }

      case "warmup_chat": {
        // Handle warmup chat message results (includes both text messages and add_contact)
        // Support both message_type and task_subtype for backward compatibility
        const { task_id, pair_id, account_id, success, error, message_type, task_subtype, is_cycle_last, error_type } = result;
        const actualMessageType = message_type || task_subtype;

        if (success) {
          // Update message as sent
          await supabase
            .from("warmup_messages")
            .update({
              status: "sent",
              sent_at: new Date().toISOString(),
            })
            .eq("id", task_id);

          // If this was an add_contact task, mark contacts_exchanged=true on the pair
          // This ensures contacts are saved permanently and never added again
          if (actualMessageType === "add_contact" && pair_id) {
            await supabase
              .from("warmup_pairs")
              .update({ contacts_exchanged: true })
              .eq("id", pair_id);
            console.log(`[report-task-result] Marked pair ${pair_id} as contacts_exchanged=true`);
          }

          // Increment messages_exchanged on the pair (only for text messages, not contacts)
          if (pair_id && actualMessageType !== "add_contact") {
            const { data: pairData } = await supabase
              .from("warmup_pairs")
              .select("messages_exchanged, session_id, cycles_completed_today, last_cycle_date")
              .eq("id", pair_id)
              .single();

            if (pairData) {
              // Get today's date in local format (YYYY-MM-DD)
              const today = new Date().toISOString().split('T')[0];
              
              // Check if we need to reset cycles_completed_today (new day)
              const isNewDay = pairData.last_cycle_date !== today;
              const currentCycles = isNewDay ? 0 : (pairData.cycles_completed_today || 0);
              
              // Check if this is the last message in the cycle
              if (is_cycle_last) {
                // Increment cycles_completed_today
                await supabase
                  .from("warmup_pairs")
                  .update({
                    messages_exchanged: (pairData.messages_exchanged || 0) + 1,
                    last_message_at: new Date().toISOString(),
                    cycles_completed_today: currentCycles + 1,
                    last_cycle_date: today,
                    status: "completed", // Mark pair as completed when cycle finishes
                  })
                  .eq("id", pair_id);
                
                console.log(`[report-task-result] Cycle completed for pair ${pair_id}, total cycles today: ${currentCycles + 1}`);
              } else {
                await supabase
                  .from("warmup_pairs")
                  .update({
                    messages_exchanged: (pairData.messages_exchanged || 0) + 1,
                    last_message_at: new Date().toISOString(),
                    // Reset cycle count if new day, but don't increment yet
                    ...(isNewDay ? { cycles_completed_today: 0, last_cycle_date: today } : {}),
                  })
                  .eq("id", pair_id);
              }
            }
          }

          // Update account last_active
          if (account_id) {
            await supabase
              .from("telegram_accounts")
              .update({ last_active: new Date().toISOString() })
              .eq("id", account_id);
          }

          console.log(`[report-task-result] Warmup ${actualMessageType || 'chat'} sent successfully: ${task_id}`);
        } else {
          // Determine the failure reason for the pair
          let pairFailedReason = error || "Unknown error";
          if (error_type === "proxy_error" || (error && error.toLowerCase().includes("proxy"))) {
            pairFailedReason = "Proxy error";
          } else if (error_type === "connection_error" || (error && (error.toLowerCase().includes("timeout") || error.toLowerCase().includes("connection")))) {
            pairFailedReason = "Connection error";
          }

          // Mark message as failed with error message
          await supabase
            .from("warmup_messages")
            .update({
              status: "failed",
              error_message: error || "Unknown error",
            })
            .eq("id", task_id);

          // Also log to warmup_errors table if we have session info
          if (pair_id) {
            const { data: pairData } = await supabase
              .from("warmup_pairs")
              .select("session_id")
              .eq("id", pair_id)
              .single();

            if (pairData?.session_id) {
              await supabase
                .from("warmup_errors")
                .insert({
                  session_id: pairData.session_id,
                  account_id: account_id,
                  pair_id: pair_id,
                  error_message: error || "Unknown error",
                  error_type: error_type || "warmup_chat",
                });
            }

            // AUTO-STOP PAIR ON ERROR: Cancel pending messages and mark pair as failed with reason
            console.log(`[report-task-result] Auto-stopping pair ${pair_id} due to error: ${pairFailedReason}`);
            
            // Cancel all pending messages for this pair
            const { data: cancelledMsgs } = await supabase
              .from("warmup_messages")
              .update({ status: "cancelled", error_message: "Pair stopped due to error" })
              .eq("pair_id", pair_id)
              .eq("status", "pending")
              .select("id");
            
            console.log(`[report-task-result] Cancelled ${cancelledMsgs?.length || 0} pending messages for pair ${pair_id}`);
            
            // Mark pair as failed with reason (not just "stopped")
            await supabase
              .from("warmup_pairs")
              .update({ status: "failed", failed_reason: pairFailedReason })
              .eq("id", pair_id);

            // If proxy error, also mark the proxy as error
            if (pairFailedReason === "Proxy error" && account_id) {
              const { data: accountData } = await supabase
                .from("telegram_accounts")
                .select("proxy_id")
                .eq("id", account_id)
                .single();
              
              if (accountData?.proxy_id) {
                await supabase
                  .from("proxies")
                  .update({ status: "error", last_checked: new Date().toISOString() })
                  .eq("id", accountData.proxy_id);
                
                console.log(`[report-task-result] Marked proxy ${accountData.proxy_id} as error`);
              }
            }
            
            // Check if all pairs are now stopped/completed/failed - if so, stop the session
            if (pairData?.session_id) {
              const { data: remainingActive } = await supabase
                .from("warmup_pairs")
                .select("id")
                .eq("session_id", pairData.session_id)
                .eq("status", "active");
              
              if (!remainingActive || remainingActive.length === 0) {
                console.log(`[report-task-result] All pairs stopped/completed/failed, stopping session ${pairData.session_id}`);
                await supabase
                  .from("warmup_sessions")
                  .update({ status: "stopped", stopped_at: new Date().toISOString() })
                  .eq("id", pairData.session_id);
              }
            }
          }

          console.log(`[report-task-result] Warmup chat failed: ${task_id} - ${error}`);
        }
        break;
      }

      case "warmup_contacts_exchanged": {
        // Mark that both accounts in a warmup pair have exchanged contacts
        // This is called BEFORE the first chat message when contacts_exchanged was false
        const { pair_id } = result;
        
        if (pair_id) {
          await supabase
            .from("warmup_pairs")
            .update({ contacts_exchanged: true })
            .eq("id", pair_id);
          
          console.log(`[report-task-result] Marked pair ${pair_id} as contacts_exchanged=true (upfront exchange)`);
        }
        break;
      }

      default:
        console.log(`[report-task-result] Unknown task type: ${task_type}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[report-task-result] Error:", errMsg);
    return new Response(JSON.stringify({ success: false, error: errMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
