import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// 14-day warmup schedule
const WARMUP_SCHEDULE = [
  // Day 1-3: Light activity - just viewing and joining
  { day: 1, tasks: [{ type: "join_channel", count: 1 }, { type: "view_content", count: 2 }] },
  { day: 2, tasks: [{ type: "view_content", count: 3 }] },
  { day: 3, tasks: [{ type: "join_channel", count: 1 }, { type: "view_content", count: 2 }] },
  
  // Day 4-7: Moderate activity - add reactions
  { day: 4, tasks: [{ type: "view_content", count: 3 }, { type: "send_reaction", count: 1 }] },
  { day: 5, tasks: [{ type: "join_channel", count: 1 }, { type: "send_reaction", count: 2 }] },
  { day: 6, tasks: [{ type: "view_content", count: 2 }, { type: "send_reaction", count: 2 }] },
  { day: 7, tasks: [{ type: "profile_update", count: 1 }, { type: "view_content", count: 3 }] },
  
  // Day 8-10: Add contacts and interactions
  { day: 8, tasks: [{ type: "add_contact", count: 1 }, { type: "view_content", count: 2 }] },
  { day: 9, tasks: [{ type: "send_reaction", count: 2 }, { type: "join_channel", count: 1 }] },
  { day: 10, tasks: [{ type: "interaction", count: 1 }, { type: "view_content", count: 2 }] },
  
  // Day 11-14: Full activity
  { day: 11, tasks: [{ type: "interaction", count: 1 }, { type: "send_reaction", count: 2 }] },
  { day: 12, tasks: [{ type: "view_content", count: 3 }, { type: "join_channel", count: 1 }] },
  { day: 13, tasks: [{ type: "interaction", count: 2 }, { type: "send_reaction", count: 1 }] },
  { day: 14, tasks: [{ type: "profile_update", count: 1 }, { type: "view_content", count: 2 }] },
];

const WARMUP_CHANNELS = [
  "telegram",
  "durov",
  "TelegramTips",
  "android",
  "ios",
];

const INTERACTION_MESSAGES = [
  "Hey! 👋",
  "How are you?",
  "Good morning! ☀️",
  "What's up?",
  "Hi there!",
  "Hello! 😊",
];

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
    const { account_ids, force_schedule } = body;

    console.log("[schedule-warmup] Starting warmup task scheduling");

    // Get accounts that need warmup scheduling
    let accountsQuery = supabase
      .from("telegram_accounts")
      .select("id, phone_number, created_at, warmup_phase, warmup_started_at")
      .eq("status", "active");

    if (account_ids && account_ids.length > 0) {
      accountsQuery = accountsQuery.in("id", account_ids);
    }

    const { data: accounts, error: accountsError } = await accountsQuery;

    if (accountsError) {
      throw accountsError;
    }

    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "No accounts to schedule warmup for",
        scheduled: 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[schedule-warmup] Processing ${accounts.length} accounts`);

    let totalScheduled = 0;
    const now = new Date();

    for (const account of accounts) {
      // Calculate warmup day
      const warmupStart = account.warmup_started_at 
        ? new Date(account.warmup_started_at) 
        : new Date(account.created_at);
      
      const daysSinceStart = Math.floor((now.getTime() - warmupStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      
      // Skip if warmup complete (>14 days)
      if (daysSinceStart > 14 && !force_schedule) {
        console.log(`[schedule-warmup] Account ${account.phone_number} warmup complete (day ${daysSinceStart})`);
        continue;
      }

      const currentDay = Math.min(daysSinceStart, 14);
      const schedule = WARMUP_SCHEDULE.find(s => s.day === currentDay);

      if (!schedule) {
        continue;
      }

      // Check for existing pending tasks today
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const { data: existingTasks } = await supabase
        .from("warmup_schedule")
        .select("id")
        .eq("account_id", account.id)
        .gte("scheduled_at", todayStart.toISOString())
        .eq("status", "pending");

      if (existingTasks && existingTasks.length > 0 && !force_schedule) {
        console.log(`[schedule-warmup] Account ${account.phone_number} already has ${existingTasks.length} pending tasks`);
        continue;
      }

      // Get other active accounts for interaction tasks
      const { data: otherAccounts } = await supabase
        .from("telegram_accounts")
        .select("id, phone_number")
        .eq("status", "active")
        .neq("id", account.id)
        .limit(5);

      // Schedule tasks for this account
      const tasksToInsert: {
        account_id: string;
        task_type: string;
        day_number: number;
        scheduled_at: string;
        channel_username?: string;
        task_description: string;
        status: string;
      }[] = [];

      for (const taskDef of schedule.tasks) {
        for (let i = 0; i < taskDef.count; i++) {
          // Spread tasks throughout the day with random delays
          const baseDelay = Math.floor(Math.random() * 8 * 60 * 60 * 1000); // 0-8 hours
          const scheduledTime = new Date(now.getTime() + baseDelay + (i * 30 * 60 * 1000)); // +30min per task

          const task: {
            account_id: string;
            task_type: string;
            day_number: number;
            scheduled_at: string;
            channel_username?: string;
            task_description: string;
            status: string;
          } = {
            account_id: account.id,
            task_type: taskDef.type,
            day_number: currentDay,
            scheduled_at: scheduledTime.toISOString(),
            task_description: `Day ${currentDay}: ${taskDef.type}`,
            status: "pending",
          };

          // Add channel for channel-related tasks
          if (["join_channel", "view_content", "send_reaction"].includes(taskDef.type)) {
            task.channel_username = WARMUP_CHANNELS[Math.floor(Math.random() * WARMUP_CHANNELS.length)];
          }

          tasksToInsert.push(task);
        }
      }

      // Handle interaction tasks - schedule bidirectional messaging
      if (schedule.tasks.some(t => t.type === "interaction") && otherAccounts && otherAccounts.length > 0) {
        const interactionTasks = tasksToInsert.filter(t => t.task_type === "interaction");
        
        for (let i = 0; i < interactionTasks.length; i++) {
          const targetAccount = otherAccounts[i % otherAccounts.length];
          
          // Schedule message from current to target
          const scheduledTime = new Date(now.getTime() + Math.random() * 4 * 60 * 60 * 1000);
          await supabase
            .from("interaction_scheduler")
            .insert({
              sender_account_id: account.id,
              receiver_account_id: targetAccount.id,
              message_content: INTERACTION_MESSAGES[Math.floor(Math.random() * INTERACTION_MESSAGES.length)],
              scheduled_at: scheduledTime.toISOString(),
              status: "pending",
            });

          // Schedule reply from target to current (30min - 2hr later)
          const replyTime = new Date(scheduledTime.getTime() + (30 + Math.random() * 90) * 60 * 1000);
          await supabase
            .from("interaction_scheduler")
            .insert({
              sender_account_id: targetAccount.id,
              receiver_account_id: account.id,
              message_content: INTERACTION_MESSAGES[Math.floor(Math.random() * INTERACTION_MESSAGES.length)],
              scheduled_at: replyTime.toISOString(),
              status: "pending",
            });
        }

        // Remove interaction tasks from warmup_schedule (handled by interaction_scheduler)
        const filtered = tasksToInsert.filter(t => t.task_type !== "interaction");
        tasksToInsert.length = 0;
        tasksToInsert.push(...filtered);
      }

      if (tasksToInsert.length > 0) {
        const { error: insertError } = await supabase
          .from("warmup_schedule")
          .insert(tasksToInsert);

        if (insertError) {
          console.error(`[schedule-warmup] Error inserting tasks for ${account.phone_number}:`, insertError);
        } else {
          totalScheduled += tasksToInsert.length;
          console.log(`[schedule-warmup] Scheduled ${tasksToInsert.length} tasks for ${account.phone_number} (day ${currentDay})`);
        }
      }

      // Update warmup phase if needed
      const newPhase = Math.min(Math.floor(daysSinceStart / 3.5), 4);
      if (newPhase !== account.warmup_phase) {
        await supabase
          .from("telegram_accounts")
          .update({ warmup_phase: newPhase })
          .eq("id", account.id);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Scheduled ${totalScheduled} warmup tasks`,
      scheduled: totalScheduled,
      accounts_processed: accounts.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[schedule-warmup] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
