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

    const { messagesPerPairMin = 20, messagesPerPairMax = 30 } = await req.json();

    console.log("Starting warmup chat with settings:", { messagesPerPairMin, messagesPerPairMax });

    // 1. Stop any existing active sessions
    await supabase
      .from("warmup_sessions")
      .update({ status: "stopped", stopped_at: new Date().toISOString() })
      .eq("status", "active");

    // 2. Cancel pending messages from previous sessions
    await supabase
      .from("warmup_messages")
      .update({ status: "cancelled" })
      .eq("status", "pending");

    // 3. Get all active accounts with session data (ordered by created_at for sequential pairing)
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, first_name, telegram_id, username, warmup_unpaired")
      .eq("status", "active")
      .not("session_data", "is", null)
      .order("created_at", { ascending: true });

    if (accountsError) {
      throw new Error(`Failed to fetch accounts: ${accountsError.message}`);
    }

    if (!accounts || accounts.length < 2) {
      // Check if there's an unpaired account waiting
      const unpairedAccount = accounts?.find(a => a.warmup_unpaired);
      if (unpairedAccount) {
        return new Response(
          JSON.stringify({ 
            error: "Need at least 2 active accounts with sessions",
            unpaired_account: unpairedAccount.phone_number 
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ error: "Need at least 2 active accounts with sessions" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${accounts.length} active accounts`);

    // 4. Check for previously unpaired accounts first
    const unpairedAccounts = accounts.filter(a => a.warmup_unpaired);
    const pairedAccounts = accounts.filter(a => !a.warmup_unpaired);
    
    // Combine: unpaired first, then rest
    const orderedAccounts = [...unpairedAccounts, ...pairedAccounts];

    // 5. Create new session
    const { data: session, error: sessionError } = await supabase
      .from("warmup_sessions")
      .insert({
        status: "active",
        total_pairs: Math.floor(orderedAccounts.length / 2),
        messages_per_pair_min: messagesPerPairMin,
        messages_per_pair_max: messagesPerPairMax,
      })
      .select()
      .single();

    if (sessionError) {
      throw new Error(`Failed to create session: ${sessionError.message}`);
    }

    console.log("Created session:", session.id);

    // 6. Create SEQUENTIAL pairs (A-B, C-D, E-F, etc.)
    const pairs = [];
    const pairedAccountIds: string[] = [];
    let unpairedAccountId: string | null = null;
    let unpairedPhone: string | null = null;

    for (let i = 0; i < orderedAccounts.length - 1; i += 2) {
      const accountA = orderedAccounts[i];
      const accountB = orderedAccounts[i + 1];
      
      pairs.push({
        account_a_id: accountA.id,
        account_b_id: accountB.id,
        session_id: session.id,
        status: "active",
      });
      
      pairedAccountIds.push(accountA.id, accountB.id);
    }

    // Handle odd account
    if (orderedAccounts.length % 2 === 1) {
      const lastAccount = orderedAccounts[orderedAccounts.length - 1];
      unpairedAccountId = lastAccount.id;
      unpairedPhone = lastAccount.phone_number;
      console.log(`Odd account left unpaired: ${unpairedPhone}`);
    }

    // Update warmup_unpaired flags
    if (pairedAccountIds.length > 0) {
      await supabase
        .from("telegram_accounts")
        .update({ warmup_unpaired: false })
        .in("id", pairedAccountIds);
    }

    if (unpairedAccountId) {
      await supabase
        .from("telegram_accounts")
        .update({ warmup_unpaired: true })
        .eq("id", unpairedAccountId);
    }

    const { data: createdPairs, error: pairsError } = await supabase
      .from("warmup_pairs")
      .insert(pairs)
      .select();

    if (pairsError) {
      throw new Error(`Failed to create pairs: ${pairsError.message}`);
    }

    console.log(`Created ${createdPairs.length} pairs`);

    // 7. Get message templates grouped by category
    const { data: templates, error: templatesError } = await supabase
      .from("warmup_message_templates")
      .select("*")
      .order("category")
      .order("sequence_order");

    if (templatesError || !templates?.length) {
      throw new Error("No message templates found");
    }

    // Group templates by category (each category is a complete conversation)
    const conversationsByCategory = new Map<string, typeof templates>();
    for (const template of templates) {
      const category = template.category || 'default';
      if (!conversationsByCategory.has(category)) {
        conversationsByCategory.set(category, []);
      }
      conversationsByCategory.get(category)!.push(template);
    }
    
    const conversationFlows = Array.from(conversationsByCategory.values());
    console.log(`Found ${conversationFlows.length} conversation scripts`);

    // 8. Create account lookup map
    const accountMap = new Map(accounts.map(a => [a.id, a]));

    // 9. Schedule messages for each pair - ALL messages at once with human-like timing
    const now = new Date();
    const allMessages: any[] = [];
    const contactTasks: any[] = [];

    for (const pair of createdPairs) {
      const accountA = accountMap.get(pair.account_a_id);
      const accountB = accountMap.get(pair.account_b_id);
      
      if (!accountA || !accountB) continue;

      // Pick a random conversation flow
      const flow = conversationFlows[Math.floor(Math.random() * conversationFlows.length)];
      
      // Random number of messages between min and max
      const messageCount = Math.floor(
        Math.random() * (messagesPerPairMax - messagesPerPairMin + 1) + messagesPerPairMin
      );
      const selectedTemplates = flow.slice(0, Math.min(messageCount, flow.length));

      // Start within 1-5 minutes
      let currentTime = new Date(now.getTime() + (60 + Math.random() * 240) * 1000);

      for (let i = 0; i < selectedTemplates.length; i++) {
        const template = selectedTemplates[i];
        
        // Human-like timing:
        // - Base delay: 15-30 seconds
        // - Typing time based on message length: ~3 seconds per 30 chars
        // - Random jitter: 5-15 seconds
        // - Occasional longer pause (10% chance): 45-90 seconds
        const baseDelay = 15 + Math.random() * 15; // 15-30 seconds
        const typingTime = Math.max(2, (template.message_text.length / 30) * 3); // ~3s per 30 chars
        const jitter = 5 + Math.random() * 10; // 5-15 seconds
        const occasionalPause = Math.random() < 0.1 ? (45 + Math.random() * 45) : 0; // 10% chance of 45-90s pause
        
        const delaySeconds = baseDelay + typingTime + jitter + occasionalPause;
        currentTime = new Date(currentTime.getTime() + delaySeconds * 1000);

        // Determine sender based on template position (A or B)
        const senderId = template.sender_position === "A" ? pair.account_a_id : pair.account_b_id;
        const receiverId = template.sender_position === "A" ? pair.account_b_id : pair.account_a_id;
        const sender = template.sender_position === "A" ? accountA : accountB;
        const receiver = template.sender_position === "A" ? accountB : accountA;

        allMessages.push({
          pair_id: pair.id,
          sender_account_id: senderId,
          receiver_account_id: receiverId,
          message_content: template.message_text,
          message_type: "text",
          scheduled_at: currentTime.toISOString(),
          reply_delay_seconds: Math.floor(delaySeconds),
          status: "pending",
        });
      }
    }

    // Insert all messages in batch
    if (allMessages.length > 0) {
      const { error: messagesError } = await supabase
        .from("warmup_messages")
        .insert(allMessages);

      if (messagesError) {
        throw new Error(`Failed to create messages: ${messagesError.message}`);
      }
    }

    // Calculate estimated duration
    const firstMessage = allMessages[0];
    const lastMessage = allMessages[allMessages.length - 1];
    const estimatedDurationMinutes = firstMessage && lastMessage
      ? Math.ceil((new Date(lastMessage.scheduled_at).getTime() - new Date(firstMessage.scheduled_at).getTime()) / 60000)
      : 0;

    console.log(`Scheduled ${allMessages.length} messages for ${createdPairs.length} pairs (est. ${estimatedDurationMinutes} minutes)`);

    return new Response(
      JSON.stringify({
        success: true,
        session_id: session.id,
        pairs_created: createdPairs.length,
        messages_scheduled: allMessages.length,
        estimated_duration_minutes: estimatedDurationMinutes,
        unpaired_account: unpairedPhone,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error starting warmup:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
