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
        const { message_id, success, error, campaign_recipient_id, account_id } = result;

        if (success) {
          // Update message status (from pending or sending to sent)
          await supabase
            .from("messages")
            .update({
              status: "sent",
              delivered_at: new Date().toISOString(),
            })
            .eq("id", message_id)
            .in("status", ["pending", "sending"]);

          // Increment account message count
          const { data: account } = await supabase
            .from("telegram_accounts")
            .select("messages_sent_today")
            .eq("id", account_id)
            .single();

          if (account) {
            await supabase
              .from("telegram_accounts")
              .update({
                messages_sent_today: (account.messages_sent_today || 0) + 1,
                last_active: new Date().toISOString(),
              })
              .eq("id", account_id);
          }

          // Update campaign recipient if applicable
          if (campaign_recipient_id) {
            await supabase
              .from("campaign_recipients")
              .update({
                status: "sent",
                sent_at: new Date().toISOString(),
              })
              .eq("id", campaign_recipient_id);

            // Get campaign_id and increment sent_count
            const { data: recipient } = await supabase
              .from("campaign_recipients")
              .select("campaign_id")
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
            }
          }

          console.log(`[report-task-result] Message ${message_id} sent successfully`);
        } else {
          // Check if error indicates account restriction
          const restrictionErrors = [
            'restricted',
            'flood',
            'too many requests',
            'wait',
            'spam',
            'banned',
            'deactivated',
            'phone_number_banned',
            'user_deactivated',
            'auth_key_unregistered',
            'session_revoked',
            'user_is_blocked'
          ];
          
          const errorLower = (error || '').toLowerCase();
          const isRestricted = restrictionErrors.some(r => errorLower.includes(r));
          
          if (isRestricted && account_id) {
            console.log(`[report-task-result] Account ${account_id} appears restricted, stopping immediately`);
            
            // Mark account as restricted
            await supabase
              .from("telegram_accounts")
              .update({
                status: "restricted",
                ban_reason: error,
                restricted_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              })
              .eq("id", account_id);
            
            // Cancel ALL pending messages from this account
            const { data: cancelledMessages } = await supabase
              .from("messages")
              .update({ 
                status: "cancelled", 
                failed_reason: `Account restricted: ${error}` 
              })
              .eq("account_id", account_id)
              .eq("status", "pending")
              .select("id, campaign_recipient_id");
            
            if (cancelledMessages && cancelledMessages.length > 0) {
              console.log(`[report-task-result] Cancelled ${cancelledMessages.length} pending messages from restricted account`);
              
              // Update campaign recipients status
              const recipientIds = cancelledMessages
                .filter(m => m.campaign_recipient_id)
                .map(m => m.campaign_recipient_id);
              
              if (recipientIds.length > 0) {
                await supabase
                  .from("campaign_recipients")
                  .update({ status: "failed" })
                  .in("id", recipientIds);
              }
            }
          }
          
          // Update message as failed (from pending or sending to failed)
          await supabase
            .from("messages")
            .update({
              status: "failed",
              failed_reason: error,
            })
            .eq("id", message_id)
            .in("status", ["pending", "sending"]);

          // Update campaign recipient if applicable
          if (campaign_recipient_id) {
            await supabase
              .from("campaign_recipients")
              .update({ status: "failed" })
              .eq("id", campaign_recipient_id);

            // Get campaign_id and increment failed_count
            const { data: recipient } = await supabase
              .from("campaign_recipients")
              .select("campaign_id")
              .eq("id", campaign_recipient_id)
              .single();

            if (recipient?.campaign_id) {
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
            }
          }

          console.log(`[report-task-result] Message ${message_id} failed: ${error}`);
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

        // Update account status
        const updateData: Record<string, unknown> = {
          status: status,
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

        console.log(`[report-task-result] SpamBot check completed for ${account_id}: ${status}`);
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

        // Priority 4: Look for conversations without telegram_id that we recently messaged
        // This is crucial for campaign conversations where we only have phone number initially
        if (!convId) {
          console.log(`[report-task-result] Searching for unlinked campaign conversations...`);
          
          // Find conversations for this account that don't have telegram_id set
          const { data: unlinkedConvs } = await supabase
            .from("conversations")
            .select("*, messages!inner(direction, created_at)")
            .eq("account_id", account_id)
            .is("recipient_telegram_id", null)
            .order("last_message_at", { ascending: false })
            .limit(20);

          if (unlinkedConvs && unlinkedConvs.length > 0) {
            // Find one that has only outgoing messages (fresh campaign conversation waiting for reply)
            for (const conv of unlinkedConvs) {
              const hasOnlyOutgoing = (conv.messages as any[]).every((m: any) => m.direction === 'outgoing');
              if (hasOnlyOutgoing) {
                convId = conv.id;
                existingConvData = conv;
                console.log(`[report-task-result] Found unlinked campaign conversation: ${convId} (phone: ${conv.recipient_phone})`);
                break;
              }
            }
          }
        }

        // Priority 5: Check campaign_recipients for matching phone and link to that conversation
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
          // Create new conversation only if we really couldn't find one
          console.log(`[report-task-result] Creating new conversation for ${displayName}`);
          const { data: newConv } = await supabase
            .from("conversations")
            .insert({
              account_id,
              recipient_telegram_id: sender_id,
              recipient_name: displayName,
              recipient_username: sender_username ? `@${sender_username}` : null,
              recipient_phone: sender_phone || phoneDisplay,
              recipient_avatar: sender_avatar ? `data:image/jpeg;base64,${sender_avatar}` : null,
              is_active: true,
              unread_count: 1,
              last_message_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (newConv) convId = newConv.id;
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
        const { account_id, first_name, last_name, username, telegram_id, phone, avatar_base64 } = result;

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

        console.log(`[report-task-result] Account ${account_id} connected`);
        break;
      }

      case "account_disconnected": {
        const { account_id, reason } = result;

        await supabase
          .from("telegram_accounts")
          .update({ status: "disconnected" })
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} disconnected: ${reason}`);
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

      case "account_restricted": {
        const { account_id, reason, restricted_until } = result;

        await supabase
          .from("telegram_accounts")
          .update({
            status: "restricted",
            ban_reason: reason,
            restricted_until: restricted_until || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          })
          .eq("id", account_id);

        console.log(`[report-task-result] Account ${account_id} restricted: ${reason}`);
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
