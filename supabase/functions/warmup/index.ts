import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * UNIFIED WARMUP ENDPOINT
 * 
 * Consolidates: start-warmup-chat, stop-warmup-chat, schedule-warmup-tasks
 * 
 * Routes:
 * - POST /start - Start warmup session
 * - POST /stop - Stop warmup session
 * - POST /schedule - Schedule warmup tasks
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/warmup', '');

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json().catch(() => ({}));

    // Route: START WARMUP
    if (path === '/start' || path === '') {
      return await handleStartWarmup(supabase, body);
    }

    // Route: STOP WARMUP
    if (path === '/stop') {
      return await handleStopWarmup(supabase, body);
    }

    // Route: SCHEDULE TASKS
    if (path === '/schedule') {
      return await handleScheduleTasks(supabase, body);
    }

    return jsonResponse({ error: "Not found", path }, 404);

  } catch (error) {
    console.error(`[warmup] Error:`, error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// ==================== START WARMUP ====================
async function handleStartWarmup(supabase: any, body: any) {
  const { messagesPerPairMin = 20, messagesPerPairMax = 30, specificPairAccountIds } = body;

  console.log("[warmup/start] Settings:", { messagesPerPairMin, messagesPerPairMax, specificPairAccountIds });

  // Specific pair warmup
  if (specificPairAccountIds?.length === 2) {
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, first_name, telegram_id, username, status")
      .in("id", specificPairAccountIds)
      .in("status", ["active", "restricted"])
      .not("session_data", "is", null);

    if (accountsError || !accounts || accounts.length !== 2) {
      return jsonResponse({ error: "Both accounts must be active/restricted with valid sessions" }, 400);
    }

    // Find or create session
    let session;
    const { data: existingSession } = await supabase
      .from("warmup_sessions")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (existingSession) {
      session = existingSession;
      await supabase.from("warmup_sessions")
        .update({ total_pairs: (session.total_pairs || 0) + 1 })
        .eq("id", session.id);
    } else {
      const { data: newSession, error: sessionError } = await supabase
        .from("warmup_sessions")
        .insert({
          status: "active",
          total_pairs: 1,
          messages_per_pair_min: messagesPerPairMin,
          messages_per_pair_max: messagesPerPairMax,
        })
        .select()
        .single();
      if (sessionError) throw new Error(`Failed to create session: ${sessionError.message}`);
      session = newSession;
    }

    // Check previous contact exchange
    const { data: previousPair } = await supabase
      .from("warmup_pairs")
      .select("id, contacts_exchanged")
      .eq("contacts_exchanged", true)
      .or(`and(account_a_id.eq.${accounts[0].id},account_b_id.eq.${accounts[1].id}),and(account_a_id.eq.${accounts[1].id},account_b_id.eq.${accounts[0].id})`)
      .limit(1);

    const contactsAlreadyExchanged = previousPair && previousPair.length > 0;

    // Create pair
    const { data: createdPair, error: pairError } = await supabase
      .from("warmup_pairs")
      .insert({
        account_a_id: accounts[0].id,
        account_b_id: accounts[1].id,
        session_id: session.id,
        status: "active",
        contacts_exchanged: contactsAlreadyExchanged,
      })
      .select()
      .single();

    if (pairError) throw new Error(`Failed to create pair: ${pairError.message}`);

    // Get templates
    const { data: templates } = await supabase.from("warmup_message_templates").select("*");
    if (!templates?.length) throw new Error("No message templates found");

    // Select category
    const allCategories = [...new Set(templates.map((t: any) => t.category))];
    const selectedCategory = allCategories[Math.floor(Math.random() * allCategories.length)];
    
    const categoryTemplates = templates
      .filter((t: any) => t.category === selectedCategory)
      .sort((a: any, b: any) => a.sequence_order - b.sequence_order);

    const maxMessages = Math.min(categoryTemplates.length, messagesPerPairMax);
    const minMessages = Math.min(messagesPerPairMin, maxMessages);
    const messageCount = Math.floor(Math.random() * (maxMessages - minMessages + 1) + minMessages);
    const selectedTemplates = categoryTemplates.slice(0, messageCount);

    // Schedule messages
    const now = new Date();
    let currentTime = new Date(now.getTime() + (10 + Math.random() * 20) * 1000);
    const allMessages: any[] = [];

    // Add contact tasks if first time
    if (!contactsAlreadyExchanged) {
      allMessages.push({
        pair_id: createdPair.id,
        sender_account_id: accounts[0].id,
        receiver_account_id: accounts[1].id,
        message_content: accounts[1].first_name || "Friend",
        message_type: "add_contact",
        scheduled_at: currentTime.toISOString(),
        status: "pending",
      });

      const contactTime2 = new Date(currentTime.getTime() + 1000 + Math.random() * 1000);
      allMessages.push({
        pair_id: createdPair.id,
        sender_account_id: accounts[1].id,
        receiver_account_id: accounts[0].id,
        message_content: accounts[0].first_name || "Friend",
        message_type: "add_contact",
        scheduled_at: contactTime2.toISOString(),
        status: "pending",
      });

      currentTime = new Date(contactTime2.getTime() + 8000 + Math.random() * 4000);
    }

    // Schedule chat messages
    for (let i = 0; i < selectedTemplates.length; i++) {
      const template = selectedTemplates[i];
      const isLastMessage = i === selectedTemplates.length - 1;
      
      const baseDelay = 8 + Math.random() * 25;
      const typingTime = (template.message_text.length / 50) * 60;
      const delaySeconds = baseDelay + typingTime + Math.random() * 5;
      
      currentTime = new Date(currentTime.getTime() + delaySeconds * 1000);

      const senderId = template.sender_position === "A" ? createdPair.account_a_id : createdPair.account_b_id;
      const receiverId = template.sender_position === "A" ? createdPair.account_b_id : createdPair.account_a_id;

      allMessages.push({
        pair_id: createdPair.id,
        sender_account_id: senderId,
        receiver_account_id: receiverId,
        message_content: template.message_text,
        message_type: "text",
        scheduled_at: currentTime.toISOString(),
        status: "pending",
        template_id: template.id,
        is_cycle_last: isLastMessage,
      });
    }

    if (allMessages.length > 0) {
      await supabase.from("warmup_messages").insert(allMessages);
    }

    return jsonResponse({
      success: true,
      session_id: session.id,
      pairs_created: 1,
      messages_scheduled: allMessages.length,
    });
  }

  // Full warmup for all accounts
  await supabase.from("warmup_sessions")
    .update({ status: "stopped", stopped_at: new Date().toISOString() })
    .eq("status", "active");

  await supabase.from("warmup_messages")
    .update({ status: "cancelled" })
    .eq("status", "pending");

  const { data: accounts, error: accountsError } = await supabase
    .from("telegram_accounts")
    .select("id, phone_number, first_name, telegram_id, username, warmup_unpaired")
    .eq("status", "active")
    .not("session_data", "is", null)
    .order("created_at", { ascending: true });

  if (accountsError) throw new Error(`Failed to fetch accounts: ${accountsError.message}`);
  if (!accounts || accounts.length < 2) {
    return jsonResponse({ error: "Need at least 2 active accounts with sessions" }, 400);
  }

  // Create session
  const { data: session, error: sessionError } = await supabase
    .from("warmup_sessions")
    .insert({
      status: "active",
      total_pairs: Math.floor(accounts.length / 2),
      messages_per_pair_min: messagesPerPairMin,
      messages_per_pair_max: messagesPerPairMax,
    })
    .select()
    .single();

  if (sessionError) throw new Error(`Failed to create session: ${sessionError.message}`);

  // Create sequential pairs
  const pairs = [];
  for (let i = 0; i < accounts.length - 1; i += 2) {
    pairs.push({
      account_a_id: accounts[i].id,
      account_b_id: accounts[i + 1].id,
      session_id: session.id,
      status: "active",
    });
  }

  const { data: createdPairs, error: pairsError } = await supabase
    .from("warmup_pairs")
    .insert(pairs)
    .select();

  if (pairsError) throw new Error(`Failed to create pairs: ${pairsError.message}`);

  return jsonResponse({
    success: true,
    session_id: session.id,
    pairs_created: createdPairs.length,
    accounts_used: accounts.length,
  });
}

// ==================== STOP WARMUP ====================
async function handleStopWarmup(supabase: any, body: any) {
  const { session_id } = body;

  console.log("[warmup/stop] Stopping warmup", session_id ? `session: ${session_id}` : "all sessions");

  let query = supabase.from("warmup_sessions")
    .update({ status: "stopped", stopped_at: new Date().toISOString() });
  
  if (session_id) {
    query = query.eq("id", session_id);
  } else {
    query = query.eq("status", "active");
  }

  await query;

  // Cancel pending messages
  if (session_id) {
    const { data: pairs } = await supabase
      .from("warmup_pairs")
      .select("id")
      .eq("session_id", session_id);
    
    if (pairs?.length > 0) {
      await supabase.from("warmup_messages")
        .update({ status: "cancelled" })
        .eq("status", "pending")
        .in("pair_id", pairs.map((p: any) => p.id));
    }
  } else {
    await supabase.from("warmup_messages")
      .update({ status: "cancelled" })
      .eq("status", "pending");
  }

  return jsonResponse({ success: true });
}

// ==================== SCHEDULE TASKS ====================
async function handleScheduleTasks(supabase: any, body: any) {
  const { account_id, tasks } = body;

  if (!account_id || !tasks?.length) {
    return jsonResponse({ error: "account_id and tasks array required" }, 400);
  }

  console.log(`[warmup/schedule] Scheduling ${tasks.length} tasks for account ${account_id}`);

  const scheduledTasks = tasks.map((task: any) => ({
    account_id,
    task_type: task.type,
    task_description: task.description,
    day_number: task.day || 1,
    scheduled_at: task.scheduled_at || new Date().toISOString(),
    status: "pending",
  }));

  const { data, error } = await supabase.from("warmup_schedule").insert(scheduledTasks).select();

  if (error) throw new Error(`Failed to schedule tasks: ${error.message}`);

  return jsonResponse({
    success: true,
    scheduled: data.length,
  });
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
