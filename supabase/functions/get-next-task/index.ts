import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LIVE_CONVERSATION_TIMEOUT_MINUTES = 5;
const WARMUP_DAYS = 5; // Days before account is ready for campaigns

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json().catch(() => ({}));
    const { account_id, runner } = body;

    console.log(`[get-next-task] Request for runner: ${runner || 'all'}, account: ${account_id || 'any'}`);

    // Reset any messages stuck in "sending" status for more than 2 minutes
    const sendingCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuckMessages } = await supabase
      .from("messages")
      .update({ status: "pending" })
      .eq("status", "sending")
      .lt("created_at", sendingCutoff)
      .select("id");
    
    if (stuckMessages && stuckMessages.length > 0) {
      console.log(`[get-next-task] Reset ${stuckMessages.length} stuck messages`);
    }

    // Check for paused campaigns - cancel pending messages
    const { data: pausedCampaigns } = await supabase
      .from("campaigns")
      .select("id")
      .in("status", ["paused", "draft"]);
    
    if (pausedCampaigns && pausedCampaigns.length > 0) {
      const pausedIds = pausedCampaigns.map((c: any) => c.id);
      
      // Get campaign_recipient_ids for paused campaigns
      const { data: pausedRecipients } = await supabase
        .from("campaign_recipients")
        .select("id")
        .in("campaign_id", pausedIds)
        .eq("status", "pending");
      
      if (pausedRecipients && pausedRecipients.length > 0) {
        const recipientIds = pausedRecipients.map((r: any) => r.id);
        
        // Cancel pending messages for paused campaigns
        await supabase
          .from("messages")
          .update({ status: "cancelled", failed_reason: "Campaign paused" })
          .in("campaign_recipient_id", recipientIds)
          .eq("status", "pending");
        
        console.log(`[get-next-task] Cancelled messages for ${pausedRecipients.length} paused campaign recipients`);
      }
    }

    // Get all active accounts - exclude banned, restricted
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("*")
      .eq("status", "active");

    if (accountsError) {
      console.error("[get-next-task] Error fetching accounts:", accountsError);
      return new Response(JSON.stringify({ task: "wait", seconds: 5, reason: "Database error" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!accounts || accounts.length === 0) {
      console.log("[get-next-task] No active accounts");
      return new Response(JSON.stringify({ task: "wait", seconds: 30, reason: "No active accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Separate warmed-up accounts (>5 days old) from new accounts
    const now = new Date();
    const warmedUpAccounts = accounts.filter((a: any) => {
      const createdAt = new Date(a.created_at);
      const daysSinceCreation = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
      return daysSinceCreation >= WARMUP_DAYS;
    });
    
    const newAccounts = accounts.filter((a: any) => {
      const createdAt = new Date(a.created_at);
      const daysSinceCreation = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
      return daysSinceCreation < WARMUP_DAYS;
    });

    console.log(`[get-next-task] Accounts: ${warmedUpAccounts.length} warmed-up, ${newAccounts.length} warming`);

    // Get live conversation IDs (incoming messages in last 5 minutes)
    const cutoff = new Date(Date.now() - LIVE_CONVERSATION_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    const { data: liveMessages } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("direction", "incoming")
      .gte("created_at", cutoff);

    const liveConvIds = new Set((liveMessages || []).map((m: { conversation_id: string }) => m.conversation_id));
    console.log(`[get-next-task] Live conversations: ${liveConvIds.size}`);

    // ========== RUNNER-SPECIFIC TASK FILTERING ==========
    
    // RUNNER: campaign - Only campaign messages
    if (runner === "campaign") {
      if (warmedUpAccounts.length > 0) {
        const { data: campaignMessages } = await supabase
          .from("messages")
          .select("*, conversations(*), campaign_recipients(campaign_id)")
          .eq("status", "pending")
          .eq("direction", "outgoing")
          .not("campaign_recipient_id", "is", null)
          .limit(50);

        if (campaignMessages && campaignMessages.length > 0) {
          for (const msg of campaignMessages) {
            if (liveConvIds.has(msg.conversation_id)) continue;

            const conv = msg.conversations || {};
            const campaignRecipientId = msg.campaign_recipient_id;
            const campaignRecipient = msg.campaign_recipients;
            
            if (!campaignRecipient || !campaignRecipient.campaign_id) {
              await supabase
                .from("messages")
                .update({ status: "cancelled", failed_reason: "Campaign recipient deleted" })
                .eq("id", msg.id);
              continue;
            }

            // Check if campaign is paused
            const { data: campaign } = await supabase
              .from("campaigns")
              .select("status")
              .eq("id", campaignRecipient.campaign_id)
              .single();
            
            if (campaign && (campaign.status === "paused" || campaign.status === "draft")) {
              console.log(`[get-next-task] Campaign ${campaignRecipient.campaign_id} is paused - sending stop signal`);
              return new Response(JSON.stringify({
                task: "wait",
                seconds: 5,
                stop_signal: true,
                reason: "Campaign paused"
              }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }

            const account = warmedUpAccounts.find((a: { id: string }) => a.id === msg.account_id);
            if (!account) continue;

            if ((account.messages_sent_today || 0) >= (account.daily_limit || 10)) {
              console.log(`[get-next-task] Account ${account.phone_number} at daily limit`);
              continue;
            }

            await supabase
              .from("messages")
              .update({ status: "sending" })
              .eq("id", msg.id)
              .eq("status", "pending");

            console.log(`[get-next-task] Campaign task: message ${msg.id.slice(0, 8)}`);
            return new Response(JSON.stringify({
              task: "send",
              message: {
                id: msg.id,
                content: msg.content,
                media_url: msg.media_url,
                media_type: msg.media_type,
                campaign_recipient_id: msg.campaign_recipient_id,
              },
              recipient: conv.recipient_username || conv.recipient_phone,
              account: {
                id: account.id,
                phone_number: account.phone_number,
                session_data: account.session_data,
              },
              mode: "campaign",
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }

        // Also handle validation for campaign runner
        const { data: validatingRecipients } = await supabase
          .from("campaign_recipients")
          .select("*")
          .eq("status", "validating")
          .limit(10);

        if (validatingRecipients && validatingRecipients.length > 0) {
          const account = warmedUpAccounts[0];
          console.log(`[get-next-task] Validate task: ${validatingRecipients.length} recipients`);
          return new Response(JSON.stringify({
            task: "validate",
            recipients: validatingRecipients.map((r: { id: string; phone_number: string; name: string | null }) => ({
              id: r.id,
              phone_number: r.phone_number,
              name: r.name,
            })),
            account: {
              id: account.id,
              phone_number: account.phone_number,
              session_data: account.session_data,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 1,
        accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RUNNER: warmup - Only warmup tasks
    if (runner === "warmup") {
      if (newAccounts.length > 0) {
        const { data: warmupTasks } = await supabase
          .from("maturation_tasks")
          .select("*, telegram_accounts(*)")
          .eq("status", "pending")
          .lte("scheduled_at", new Date().toISOString())
          .limit(1);

        if (warmupTasks && warmupTasks.length > 0) {
          const task = warmupTasks[0];
          const accountData = task.telegram_accounts;
          
          if (accountData && accountData.status === "active") {
            console.log(`[get-next-task] Warmup task ${task.task_type} for ${task.account_id}`);
            return new Response(JSON.stringify({
              task: "warmup_" + task.task_type,
              task_id: task.id,
              account: {
                id: accountData.id,
                phone_number: accountData.phone_number,
                session_data: accountData.session_data,
              },
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 30,
        reason: "No warmup tasks",
        accounts: newAccounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RUNNER: account - Only account management tasks
    if (runner === "account") {
      const { data: checkTasks } = await supabase
        .from("account_check_tasks")
        .select("*, telegram_accounts(*)")
        .eq("status", "pending")
        .in("task_type", ["spambot_check", "change_name", "privacy_settings", "change_password", "logout_sessions", "change_photo"])
        .limit(1);

      if (checkTasks && checkTasks.length > 0) {
        const task = checkTasks[0];
        const accountData = task.telegram_accounts;
        const taskType = task.task_type;

        if (accountData) {
          if (taskType === "spambot_check") {
            const lastCheck = accountData.last_spambot_check;
            if (lastCheck) {
              const hoursSinceCheck = (Date.now() - new Date(lastCheck).getTime()) / (1000 * 60 * 60);
              if (hoursSinceCheck < 96) {
                await supabase
                  .from("account_check_tasks")
                  .update({
                    status: "skipped",
                    result: `Already checked ${hoursSinceCheck.toFixed(1)} hours ago.`,
                    completed_at: new Date().toISOString(),
                  })
                  .eq("id", task.id);
              } else {
                console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
                return new Response(JSON.stringify({
                  task: "spambot_check",
                  task_id: task.id,
                  account: {
                    id: accountData.id,
                    phone_number: accountData.phone_number,
                    session_data: accountData.session_data,
                  },
                }), {
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
              }
            } else {
              console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
              return new Response(JSON.stringify({
                task: "spambot_check",
                task_id: task.id,
                account: {
                  id: accountData.id,
                  phone_number: accountData.phone_number,
                  session_data: accountData.session_data,
                },
              }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          } else {
            console.log(`[get-next-task] ${taskType} for ${task.account_id}`);
            return new Response(JSON.stringify({
              task: taskType,
              task_id: task.id,
              task_data: task.result ? JSON.parse(task.result) : {},
              account: {
                id: accountData.id,
                phone_number: accountData.phone_number,
                session_data: accountData.session_data,
              },
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 5,
        reason: "No account tasks",
        accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RUNNER: livechat - Only for keeping connections alive and listening
    if (runner === "livechat") {
      // Live chat messages (instant delivery for active conversations)
      if (liveConvIds.size > 0) {
        const { data: liveChatMessages } = await supabase
          .from("messages")
          .select("*, conversations(*)")
          .eq("status", "pending")
          .eq("direction", "outgoing")
          .in("conversation_id", Array.from(liveConvIds))
          .limit(1);

        if (liveChatMessages && liveChatMessages.length > 0) {
          const msg = liveChatMessages[0];
          const conv = msg.conversations || {};
          const account = accounts.find((a: { id: string }) => a.id === msg.account_id);

          if (account) {
            await supabase
              .from("messages")
              .update({ status: "sending" })
              .eq("id", msg.id)
              .eq("status", "pending");

            console.log(`[get-next-task] Live chat task: message ${msg.id.slice(0, 8)}`);
            return new Response(JSON.stringify({
              task: "send",
              message: {
                id: msg.id,
                content: msg.content,
                media_url: msg.media_url,
                media_type: msg.media_type,
                campaign_recipient_id: msg.campaign_recipient_id,
              },
              recipient: conv.recipient_username || conv.recipient_phone,
              account: {
                id: account.id,
                phone_number: account.phone_number,
                session_data: account.session_data,
              },
              mode: "live",
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      }

      return new Response(JSON.stringify({
        task: "wait",
        seconds: 0.05,
        accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
          id: a.id,
          phone_number: a.phone_number,
          session_data: a.session_data,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ========== DEFAULT: ALL TASKS (original behavior) ==========

    // Priority 1: Live chat messages (instant delivery for active conversations)
    if (liveConvIds.size > 0) {
      const { data: liveMessages } = await supabase
        .from("messages")
        .select("*, conversations(*)")
        .eq("status", "pending")
        .eq("direction", "outgoing")
        .in("conversation_id", Array.from(liveConvIds))
        .limit(1);

      if (liveMessages && liveMessages.length > 0) {
        const msg = liveMessages[0];
        const conv = msg.conversations || {};
        const account = accounts.find((a: { id: string }) => a.id === msg.account_id);

        if (account) {
          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id)
            .eq("status", "pending");

          console.log(`[get-next-task] Live chat task: message ${msg.id.slice(0, 8)}`);
          return new Response(JSON.stringify({
            task: "send",
            message: {
              id: msg.id,
              content: msg.content,
              media_url: msg.media_url,
              media_type: msg.media_type,
              campaign_recipient_id: msg.campaign_recipient_id,
            },
            recipient: conv.recipient_username || conv.recipient_phone,
            account: {
              id: account.id,
              phone_number: account.phone_number,
              session_data: account.session_data,
            },
            mode: "live",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Priority 2: Campaign messages (only use warmed-up accounts)
    if (warmedUpAccounts.length > 0) {
      const { data: campaignMessages } = await supabase
        .from("messages")
        .select("*, conversations(*), campaign_recipients(campaign_id)")
        .eq("status", "pending")
        .eq("direction", "outgoing")
        .limit(50);

      if (campaignMessages && campaignMessages.length > 0) {
        for (const msg of campaignMessages) {
          if (liveConvIds.has(msg.conversation_id)) continue;

          const conv = msg.conversations || {};
          const campaignRecipientId = msg.campaign_recipient_id;

          // Skip orphaned messages
          if (!campaignRecipientId) {
            if (!conv.is_active && !conv.recipient_telegram_id) {
              await supabase
                .from("messages")
                .update({ status: "cancelled", failed_reason: "Campaign deleted" })
                .eq("id", msg.id);
              continue;
            }
          } else {
            const campaignRecipient = msg.campaign_recipients;
            if (!campaignRecipient || !campaignRecipient.campaign_id) {
              await supabase
                .from("messages")
                .update({ status: "cancelled", failed_reason: "Campaign recipient deleted" })
                .eq("id", msg.id);
              continue;
            }

            // Check if campaign is paused
            const { data: campaign } = await supabase
              .from("campaigns")
              .select("status")
              .eq("id", campaignRecipient.campaign_id)
              .single();
            
            if (campaign && (campaign.status === "paused" || campaign.status === "draft")) {
              console.log(`[get-next-task] Campaign ${campaignRecipient.campaign_id} is paused`);
              continue;
            }
          }

          // Only use warmed-up accounts for campaigns
          const account = warmedUpAccounts.find((a: { id: string }) => a.id === msg.account_id);
          if (!account) {
            console.log(`[get-next-task] Account ${msg.account_id} not warmed-up or unavailable`);
            continue;
          }

          // Check daily limit
          if ((account.messages_sent_today || 0) >= (account.daily_limit || 10)) {
            console.log(`[get-next-task] Account ${account.phone_number} at daily limit`);
            continue;
          }

          await supabase
            .from("messages")
            .update({ status: "sending" })
            .eq("id", msg.id)
            .eq("status", "pending");

          console.log(`[get-next-task] Campaign task: message ${msg.id.slice(0, 8)}`);
          return new Response(JSON.stringify({
            task: "send",
            message: {
              id: msg.id,
              content: msg.content,
              media_url: msg.media_url,
              media_type: msg.media_type,
              campaign_recipient_id: msg.campaign_recipient_id,
            },
            recipient: conv.recipient_username || conv.recipient_phone,
            account: {
              id: account.id,
              phone_number: account.phone_number,
              session_data: account.session_data,
            },
            mode: "campaign",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Priority 3: Validate recipients
    const { data: validatingRecipients } = await supabase
      .from("campaign_recipients")
      .select("*")
      .eq("status", "validating")
      .limit(10);

    if (validatingRecipients && validatingRecipients.length > 0 && warmedUpAccounts.length > 0) {
      const account = warmedUpAccounts[0];
      console.log(`[get-next-task] Validate task: ${validatingRecipients.length} recipients`);
      return new Response(JSON.stringify({
        task: "validate",
        recipients: validatingRecipients.map((r: { id: string; phone_number: string; name: string | null }) => ({
          id: r.id,
          phone_number: r.phone_number,
          name: r.name,
        })),
        account: {
          id: account.id,
          phone_number: account.phone_number,
          session_data: account.session_data,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Priority 4: Account management tasks
    const { data: checkTasks } = await supabase
      .from("account_check_tasks")
      .select("*, telegram_accounts(*)")
      .eq("status", "pending")
      .in("task_type", ["spambot_check", "change_name", "privacy_settings", "change_password", "logout_sessions", "change_photo"])
      .limit(1);

    if (checkTasks && checkTasks.length > 0) {
      const task = checkTasks[0];
      const accountData = task.telegram_accounts;
      const taskType = task.task_type;

      if (accountData) {
        if (taskType === "spambot_check") {
          const lastCheck = accountData.last_spambot_check;
          if (lastCheck) {
            const hoursSinceCheck = (Date.now() - new Date(lastCheck).getTime()) / (1000 * 60 * 60);
            if (hoursSinceCheck < 96) {
              await supabase
                .from("account_check_tasks")
                .update({
                  status: "skipped",
                  result: `Already checked ${hoursSinceCheck.toFixed(1)} hours ago.`,
                  completed_at: new Date().toISOString(),
                })
                .eq("id", task.id);
            } else {
              console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
              return new Response(JSON.stringify({
                task: "spambot_check",
                task_id: task.id,
                account: {
                  id: accountData.id,
                  phone_number: accountData.phone_number,
                  session_data: accountData.session_data,
                },
              }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          } else {
            console.log(`[get-next-task] SpamBot check for ${task.account_id}`);
            return new Response(JSON.stringify({
              task: "spambot_check",
              task_id: task.id,
              account: {
                id: accountData.id,
                phone_number: accountData.phone_number,
                session_data: accountData.session_data,
              },
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } else {
          console.log(`[get-next-task] ${taskType} for ${task.account_id}`);
          return new Response(JSON.stringify({
            task: taskType,
            task_id: task.id,
            task_data: task.result ? JSON.parse(task.result) : {},
            account: {
              id: accountData.id,
              phone_number: accountData.phone_number,
              session_data: accountData.session_data,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Priority 5: Warm-up tasks for new accounts
    if (newAccounts.length > 0) {
      const { data: warmupTasks } = await supabase
        .from("maturation_tasks")
        .select("*, telegram_accounts(*)")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .limit(1);

      if (warmupTasks && warmupTasks.length > 0) {
        const task = warmupTasks[0];
        const accountData = task.telegram_accounts;
        
        if (accountData && accountData.status === "active") {
          console.log(`[get-next-task] Warmup task ${task.task_type} for ${task.account_id}`);
          return new Response(JSON.stringify({
            task: "warmup_" + task.task_type,
            task_id: task.id,
            account: {
              id: accountData.id,
              phone_number: accountData.phone_number,
              session_data: accountData.session_data,
            },
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // No tasks - wait briefly
    return new Response(JSON.stringify({
      task: "wait",
      seconds: 0.05,
      accounts: accounts.map((a: { id: string; phone_number: string; session_data: string }) => ({
        id: a.id,
        phone_number: a.phone_number,
        session_data: a.session_data,
      })),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[get-next-task] Error:", errMsg);
    return new Response(JSON.stringify({ task: "wait", seconds: 5, reason: `Error: ${errMsg}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
