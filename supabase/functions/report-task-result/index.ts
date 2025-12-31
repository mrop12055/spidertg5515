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
          content,
          media_url,
          media_type,
        } = result;

        // Find or create conversation
        const phoneDisplay = sender_username ? `@${sender_username}` : `User ${sender_id}`;
        let convId = null;

        // Try to find by telegram_id first
        const { data: existingConv } = await supabase
          .from("conversations")
          .select("*")
          .eq("account_id", account_id)
          .eq("recipient_telegram_id", sender_id)
          .limit(1);

        if (existingConv && existingConv.length > 0) {
          convId = existingConv[0].id;
          // Update existing conversation
          await supabase
            .from("conversations")
            .update({
              last_message_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              unread_count: (existingConv[0].unread_count || 0) + 1,
              is_active: true,
              recipient_telegram_id: sender_id,
              recipient_name: sender_name || existingConv[0].recipient_name,
            })
            .eq("id", convId);
        } else if (sender_username) {
          // Try to find by username
          const { data: usernameConv } = await supabase
            .from("conversations")
            .select("*")
            .eq("account_id", account_id)
            .eq("recipient_username", `@${sender_username}`)
            .limit(1);

          if (usernameConv && usernameConv.length > 0) {
            convId = usernameConv[0].id;
            await supabase
              .from("conversations")
              .update({
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                unread_count: (usernameConv[0].unread_count || 0) + 1,
                is_active: true,
                recipient_telegram_id: sender_id,
                recipient_name: sender_name || usernameConv[0].recipient_name,
              })
              .eq("id", convId);
          }
        }

        if (!convId) {
          // Create new conversation
          const { data: newConv } = await supabase
            .from("conversations")
            .insert({
              account_id,
              recipient_telegram_id: sender_id,
              recipient_name: sender_name || phoneDisplay,
              recipient_username: sender_username ? `@${sender_username}` : null,
              recipient_phone: phoneDisplay,
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

          console.log(`[report-task-result] Incoming message saved from ${sender_name || sender_id}`);
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
