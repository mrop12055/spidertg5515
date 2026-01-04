import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    console.log(`[report-task-result] Task type: ${task_type}`, result);

    switch (task_type) {
      case "send": {
        let { message_id, success, error, campaign_recipient_id, account_id, content, recipient_phone, recipient_name, recipient_telegram_id, recipient_username, skip_account, retry_with_different_account } = result;
        let isNewConversation = false; // Track if this is first message to a new contact

        if (success) {
          // For campaign messages: Create conversation and message ONLY on successful send
          if (campaign_recipient_id && account_id) {
            // FALLBACK: If content/recipient_phone/name are missing, fetch from campaign_recipients
            // Also fetch seat_id from campaign for proper seat assignment
            let campaignSeatId: string | null = null;
            
            const { data: recipientData } = await supabase
              .from("campaign_recipients")
              .select("phone_number, name, campaign_id, campaigns(message_template, seat_id)")
              .eq("id", campaign_recipient_id)
              .single();
            
            if (recipientData) {
              recipient_phone = recipient_phone || recipientData.phone_number;
              recipient_name = recipient_name || recipientData.name;
              campaignSeatId = (recipientData.campaigns as any)?.seat_id || null;
              if (!content) {
                const template = (recipientData.campaigns as any)?.message_template || '';
                content = template
                  .replace(/{name}/g, recipientData.name || 'there')
                  .replace(/{phone}/g, recipientData.phone_number);
              }
              console.log(`[report-task-result] Fetched recipient data: phone=${recipient_phone}, seat_id=${campaignSeatId}`);
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
                  seat_id: campaignSeatId,  // Route to correct seat workspace
                })
                .select()
                .single();

              if (convError) {
                console.error(`[report-task-result] Error creating conversation:`, convError);
                isNewConversation = false;
              } else {
                conversationId = newConv.id;
                console.log(`[report-task-result] Created new conversation ${conversationId}`);
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
                });

              if (msgError) {
                console.error(`[report-task-result] Error creating message:`, msgError);
              }
            }

            // Update campaign recipient status
            await supabase
              .from("campaign_recipients")
              .update({
                status: "sent",
                sent_at: new Date().toISOString(),
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
              await supabase
                .from("telegram_accounts")
                .update({
                  messages_sent_today: newCount,
                  last_active: new Date().toISOString(),
                })
                .eq("id", account_id);

              console.log(`[report-task-result] Incremented message count for account ${account_id} (new contact). New count=${newCount}`);

              // Apply scheduler rotation/cooldown based on backend settings
              const { data: schedulerRow } = await supabase
                .from("app_settings")
                .select("value")
                .eq("key", "scheduler")
                .maybeSingle();

              const scheduler = (schedulerRow?.value as any) || {};
              const enabled = scheduler.enabled !== false;
              const maxBeforeRotation = Number(scheduler.maxMessagesBeforeRotation || 0);
              const cooldownSeconds = Number(scheduler.cooldownDuration || 0);

              if (
                enabled &&
                maxBeforeRotation > 0 &&
                cooldownSeconds > 0 &&
                newCount % maxBeforeRotation === 0
              ) {
                const until = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
                await supabase
                  .from("telegram_accounts")
                  .update({
                    status: "cooldown",
                    restricted_until: until,
                  })
                  .eq("id", account_id)
                  .eq("status", "active");

                console.log(`[report-task-result] Applied cooldown to account ${account_id} for ${cooldownSeconds}s (until ${until})`);
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
          
          // Errors that should RESTRICT account (24h cooldown for new messages, but can still chat)
          const temporaryRestrictionErrors = [
            'restricted',
            'flood',
            'spam',
            'user_is_blocked',
            'frozen accounts',   // ImportContactsRequest errors on frozen accounts
            'too many requests', // Rate limit - account needs 24h cooldown
            'floodwaiterror'     // Telegram flood wait error
          ];
          
          // Errors that should just SKIP the recipient (don't affect account status)
          // These are recipient-related issues, NOT account problems
          const skipRecipientErrors = [
            'user not found',        // Recipient doesn't have Telegram
            'no user',               // Recipient doesn't exist
            'peer_id_invalid',       // Invalid recipient ID
            'user was deleted',      // RECIPIENT deleted their account (not sender!)
            'specified user',        // "The specified user was deleted"
          ];
          
          // Errors that should RETRY with a different account (max 5 attempts)
          // Privacy errors may be account-specific - recipient blocked THIS account but might accept others
          const retryWithDifferentAccountErrors = [
            'privacy',           // Recipient has privacy settings blocking THIS account
            'privacy restricted' // Recipient blocked messages from THIS unknown user
          ];
          
          const MAX_ACCOUNT_RETRIES = 5;  // Try up to 5 different accounts
          
          const errorLower = (error || '').toLowerCase();
          const isPermanentBan = permanentBanErrors.some(r => errorLower.includes(r));
          const isTemporaryRestriction = temporaryRestrictionErrors.some(r => errorLower.includes(r));
          const isSkipOnly = skipRecipientErrors.some(r => errorLower.includes(r));
          // Also check for explicit skip_account flag from Python runner
          const isRetryable = retryWithDifferentAccountErrors.some(r => errorLower.includes(r)) || (skip_account && retry_with_different_account);
          
          if (isPermanentBan && account_id) {
            // PERMANENT BAN - mark account as banned, cannot be used anymore
            console.log(`[report-task-result] Account ${account_id} PERMANENTLY BANNED: ${error}`);
            
            await supabase
              .from("telegram_accounts")
              .update({
                status: "banned",
                ban_reason: error,
              })
              .eq("id", account_id);
          } else if (isRetryable && campaign_recipient_id && account_id) {
            // PRIVACY ERROR - try with a different account (up to 5 attempts)
            // Takes priority over temporary restriction since "privacy restricted" contains "restricted"
            console.log(`[report-task-result] Privacy/skip error for recipient ${campaign_recipient_id} - checking for retry with different account (skip_account=${skip_account})`);
            
            // Count recent privacy errors for this account in the last 10 minutes
            // If too many consecutive privacy errors, apply a short cooldown to rotate to other accounts
            const PRIVACY_ERROR_THRESHOLD = 3;  // 3+ privacy errors = switch accounts
            const PRIVACY_COOLDOWN_SECONDS = 60;  // 1 minute cooldown
            
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const { count: recentPrivacyErrors } = await supabase
              .from("campaign_recipients")
              .select("id", { count: "exact", head: true })
              .contains("failed_account_ids", [account_id])
              .gte("sent_at", tenMinutesAgo);
            
            if ((recentPrivacyErrors || 0) >= PRIVACY_ERROR_THRESHOLD) {
              // Too many privacy errors - apply short cooldown to force switch
              const until = new Date(Date.now() + PRIVACY_COOLDOWN_SECONDS * 1000).toISOString();
              await supabase
                .from("telegram_accounts")
                .update({
                  status: "cooldown",
                  restricted_until: until,
                  last_active: new Date().toISOString(),
                })
                .eq("id", account_id)
                .eq("status", "active");
              
              console.log(`[report-task-result] Account ${account_id} hit ${recentPrivacyErrors} privacy errors - applying ${PRIVACY_COOLDOWN_SECONDS}s cooldown`);
            } else {
              // Just update last_active
              await supabase
                .from("telegram_accounts")
                .update({
                  last_active: new Date().toISOString(),
                })
                .eq("id", account_id);
              
              console.log(`[report-task-result] Privacy error is recipient-specific - account ${account_id} remains available`);
            }
            
            // Get recipient's current failed_account_ids
            const { data: recipientData } = await supabase
              .from("campaign_recipients")
              .select("campaign_id, failed_account_ids")
              .eq("id", campaign_recipient_id)
              .single();
            
            if (recipientData) {
              const failedAccountIds: string[] = recipientData.failed_account_ids || [];
              const updatedFailedIds = [...failedAccountIds, account_id];
              
              if (updatedFailedIds.length < MAX_ACCOUNT_RETRIES) {
                // Still have retries left - reset to pending for another account to try
                await supabase
                  .from("campaign_recipients")
                  .update({
                    status: "pending",
                    sent_by_account_id: null,  // Clear so a different account gets assigned
                    failed_account_ids: updatedFailedIds,
                  })
                  .eq("id", campaign_recipient_id);
                
                console.log(`[report-task-result] Privacy error - retry ${updatedFailedIds.length}/${MAX_ACCOUNT_RETRIES}. Recipient reset to pending for different account.`);
              } else {
                // Max retries reached - mark as permanently failed
                await supabase
                  .from("campaign_recipients")
                  .update({
                    status: "failed",
                    failed_reason: `Privacy restricted by ${updatedFailedIds.length} accounts`,
                    sent_at: new Date().toISOString(),
                    failed_account_ids: updatedFailedIds,
                  })
                  .eq("id", campaign_recipient_id);
                
                // Increment campaign failed count
                await supabase.rpc("increment_campaign_failed_count", { cid: recipientData.campaign_id });
                
                console.log(`[report-task-result] Privacy error - max retries (${MAX_ACCOUNT_RETRIES}) reached. Recipient marked as failed.`);
              }
            }
          } else if (isTemporaryRestriction && !isSkipOnly && !isRetryable && account_id) {
            // TEMPORARY - set to restricted status with 24h cooldown
            // Account can still be used for replying to existing chats, but not new campaign messages
            console.log(`[report-task-result] Account ${account_id} RESTRICTED for 24h: ${error}`);
            
            await supabase
              .from("telegram_accounts")
              .update({
                status: "restricted",
                ban_reason: error,
                restricted_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              })
              .eq("id", account_id);
            
            // Reset the current recipient to pending so it can be retried
            // by another account or when this account becomes available again
            if (campaign_recipient_id) {
              await supabase
                .from("campaign_recipients")
                .update({
                  status: "pending",
                  sent_by_account_id: null,  // Clear so a different account can pick it up
                  failed_reason: null,
                })
                .eq("id", campaign_recipient_id);
              
              console.log(`[report-task-result] Recipient ${campaign_recipient_id} reset to pending for retry (account restricted)`);
            }
          } else if (isSkipOnly && campaign_recipient_id) {
            // Recipient-side issue (e.g. "user was deleted") - mark recipient as failed, keep account active
            console.log(`[report-task-result] Recipient-side issue - marking as failed: ${error}`);
            
            // Get campaign_id for updating failed count
            const { data: recipientData } = await supabase
              .from("campaign_recipients")
              .select("campaign_id")
              .eq("id", campaign_recipient_id)
              .single();
            
            // Mark recipient as failed with the reason
            await supabase
              .from("campaign_recipients")
              .update({
                status: "failed",
                failed_reason: error || "Recipient account deleted/invalid",
                sent_at: new Date().toISOString(),
              })
              .eq("id", campaign_recipient_id);
            
            // Increment campaign failed count
            if (recipientData?.campaign_id) {
              await supabase.rpc("increment_campaign_failed_count", { cid: recipientData.campaign_id });
            }
            
            console.log(`[report-task-result] Recipient ${campaign_recipient_id} marked as failed - moving to next`);
          } else if (isSkipOnly) {
            // Skip-only error but no recipient ID - just log
            console.log(`[report-task-result] Recipient-side issue (no recipient_id): ${error}`);
          }
          
          // Reassign recipients if account was banned OR temporarily restricted (but NOT skip-only errors)
          if ((isPermanentBan || (isTemporaryRestriction && !isSkipOnly)) && account_id) {
            
            // Get pending recipients from this account
            const { data: pendingRecipients } = await supabase
              .from("campaign_recipients")
              .select("id, campaign_id")
              .eq("sent_by_account_id", account_id)
              .in("status", ["pending", "sending"]);
            
            if (pendingRecipients && pendingRecipients.length > 0) {
              // Check if OTHER active accounts exist in the same campaigns
              const campaignIds = [...new Set(pendingRecipients.map(r => r.campaign_id))];
              
              // Get all active accounts assigned to these campaigns
              const { data: campaignAccounts } = await supabase
                .from("campaign_accounts")
                .select("account_id, campaign_id, telegram_accounts!inner(id, status)")
                .in("campaign_id", campaignIds)
                .neq("account_id", account_id);
              
              // Filter to only active accounts
              const activeAccountsByCampaign: Record<string, string[]> = {};
              for (const ca of (campaignAccounts || [])) {
                const acc = ca.telegram_accounts as any;
                if (acc && acc.status === 'active') {
                  if (!activeAccountsByCampaign[ca.campaign_id]) {
                    activeAccountsByCampaign[ca.campaign_id] = [];
                  }
                  activeAccountsByCampaign[ca.campaign_id].push(ca.account_id);
                }
              }
              
              // Reassign or fail recipients based on available accounts
              const recipientsToReassign: { id: string; newAccountId: string }[] = [];
              const recipientsToFail: { id: string; campaignId: string }[] = [];
              const accountAssignmentCounters: Record<string, number> = {};
              
              for (const recipient of pendingRecipients) {
                const availableAccounts = activeAccountsByCampaign[recipient.campaign_id] || [];
                
                if (availableAccounts.length > 0) {
                  // Round-robin assignment to available accounts
                  const accountIndex = (accountAssignmentCounters[recipient.campaign_id] || 0) % availableAccounts.length;
                  const newAccountId = availableAccounts[accountIndex];
                  accountAssignmentCounters[recipient.campaign_id] = (accountAssignmentCounters[recipient.campaign_id] || 0) + 1;
                  
                  recipientsToReassign.push({ id: recipient.id, newAccountId });
                } else {
                  // No other active accounts, mark as failed
                  recipientsToFail.push({ id: recipient.id, campaignId: recipient.campaign_id });
                }
              }
              
              // Reassign recipients to other active accounts
              for (const { id, newAccountId } of recipientsToReassign) {
                await supabase
                  .from("campaign_recipients")
                  .update({ 
                    sent_by_account_id: newAccountId,
                    status: "pending"  // Reset to pending for new account to pick up
                  })
                  .eq("id", id);
              }
              
              if (recipientsToReassign.length > 0) {
                console.log(`[report-task-result] Reassigned ${recipientsToReassign.length} recipients to other active accounts`);
              }
              
              // Mark remaining as failed (no other accounts available)
              if (recipientsToFail.length > 0) {
                const failedIds = recipientsToFail.map(r => r.id);
                await supabase
                  .from("campaign_recipients")
                  .update({ status: "failed" })
                  .in("id", failedIds);
                
                // Update failed counts for affected campaigns
                const failedByCampaign: Record<string, number> = {};
                for (const r of recipientsToFail) {
                  failedByCampaign[r.campaignId] = (failedByCampaign[r.campaignId] || 0) + 1;
                }
                
                for (const [cid, count] of Object.entries(failedByCampaign)) {
                  const { data: campaign } = await supabase
                    .from("campaigns")
                    .select("failed_count")
                    .eq("id", cid)
                    .single();
                  
                  if (campaign) {
                    await supabase
                      .from("campaigns")
                      .update({ failed_count: (campaign.failed_count || 0) + count })
                      .eq("id", cid);
                  }
                }
                
                console.log(`[report-task-result] Marked ${recipientsToFail.length} recipients as failed (no other accounts available)`);
              }
            }
            
            // Check if ALL accounts for running campaigns are now restricted
            // Get running campaigns and their assigned accounts
            const { data: runningCampaigns } = await supabase
              .from("campaigns")
              .select("id, name")
              .eq("status", "running");
            
            if (runningCampaigns && runningCampaigns.length > 0) {
              for (const campaign of runningCampaigns) {
                // Get accounts assigned to this campaign
                const { data: campaignAccountLinks } = await supabase
                  .from("campaign_accounts")
                  .select("account_id, telegram_accounts!inner(id, status)")
                  .eq("campaign_id", campaign.id);
                
                // Check if any assigned account is still active
                const hasActiveAccount = (campaignAccountLinks || []).some((ca: any) => {
                  const acc = ca.telegram_accounts;
                  return acc && acc.status === 'active';
                });
                
                // No accounts assigned at all OR no active accounts
                const noAccountsAssigned = !campaignAccountLinks || campaignAccountLinks.length === 0;
                
                if (noAccountsAssigned || !hasActiveAccount) {
                  // Check if there are still pending recipients
                  const { count: pendingCount } = await supabase
                    .from("campaign_recipients")
                    .select("id", { count: "exact", head: true })
                    .eq("campaign_id", campaign.id)
                    .eq("status", "pending");
                  
                  if (pendingCount && pendingCount > 0) {
                    // There are pending recipients but no active accounts - mark as failed
                    const reason = noAccountsAssigned ? "no accounts assigned" : "all accounts restricted/banned";
                    console.log(`[report-task-result] Campaign "${campaign.name}" has ${reason} - marking as failed (${pendingCount} pending)`);
                    await supabase
                      .from("campaigns")
                      .update({ status: "failed" })
                      .eq("id", campaign.id);
                  } else {
                    // No pending recipients - mark as completed
                    console.log(`[report-task-result] Campaign "${campaign.name}" has no pending recipients - marking as completed`);
                    await supabase
                      .from("campaigns")
                      .update({ status: "completed" })
                      .eq("id", campaign.id);
                  }
                }
              }
            }
          }

          // AUTOMATIC ACCOUNT ROTATION: Try to reassign to next available account (with retry limit)
          // SKIP if the error was already handled by specific error handlers above (privacy, skip-only, etc.)
          if (campaign_recipient_id && !isRetryable && !isSkipOnly) {
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
        } = result;

        console.log(`[report-task-result] Processing incoming message from sender_id=${sender_id}, username=${sender_username}, phone=${sender_phone}, has_avatar=${!!sender_avatar}`);

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
          // Save message
          await supabase.from("messages").insert({
            account_id,
            conversation_id: convId,
            content,
            direction: "incoming",
            status: "delivered",
            delivered_at: new Date().toISOString(),
            media_url: media_url || null,
            media_type: media_type || null,
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
        const { task_id, account_id, success, error } = result;

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
          updateData.ban_reason = error || "Session revoked or account banned";
        } else if (status === "frozen") {
          // FROZEN: Account is temporarily restricted by Telegram
          updateData.status = "frozen";
          updateData.ban_reason = error || "Account frozen by Telegram";
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
          updateData.ban_reason = error || "Session invalid or connection failed";
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

      case "account_restricted": {
        const { account_id, reason, restricted_until } = result;

        // Set campaign restriction timer but keep account active (can still chat)
        await supabase
          .from("telegram_accounts")
          .update({
            // status stays 'active' - account can still chat with existing contacts
            ban_reason: reason,
            restricted_until: restricted_until || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          })
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} campaign-restricted: ${reason}`);
        break;
      }

      case "fingerprint_generated": {
        const { account_id, device_model, system_version, app_version, lang_code, system_lang_code } = result;

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
