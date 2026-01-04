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

    const { messagesPerPairMin = 5, messagesPerPairMax = 10 } = await req.json();

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

    // 3. Get all active accounts with session data
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, first_name")
      .eq("status", "active")
      .not("session_data", "is", null);

    if (accountsError) {
      throw new Error(`Failed to fetch accounts: ${accountsError.message}`);
    }

    if (!accounts || accounts.length < 2) {
      return new Response(
        JSON.stringify({ error: "Need at least 2 active accounts with sessions" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${accounts.length} active accounts`);

    // 4. Shuffle accounts randomly
    const shuffled = [...accounts].sort(() => Math.random() - 0.5);

    // 5. Create new session
    const { data: session, error: sessionError } = await supabase
      .from("warmup_sessions")
      .insert({
        status: "active",
        total_pairs: Math.floor(shuffled.length / 2),
        messages_per_pair_min: messagesPerPairMin,
        messages_per_pair_max: messagesPerPairMax,
      })
      .select()
      .single();

    if (sessionError) {
      throw new Error(`Failed to create session: ${sessionError.message}`);
    }

    console.log("Created session:", session.id);

    // 6. Create 1-to-1 pairs (A↔B, C↔D, etc.)
    const pairs = [];
    for (let i = 0; i < shuffled.length - 1; i += 2) {
      pairs.push({
        account_a_id: shuffled[i].id,
        account_b_id: shuffled[i + 1].id,
        session_id: session.id,
        status: "active",
      });
    }

    const { data: createdPairs, error: pairsError } = await supabase
      .from("warmup_pairs")
      .insert(pairs)
      .select();

    if (pairsError) {
      throw new Error(`Failed to create pairs: ${pairsError.message}`);
    }

    console.log(`Created ${createdPairs.length} pairs`);

    // 7. Get message templates
    const { data: templates, error: templatesError } = await supabase
      .from("warmup_message_templates")
      .select("*")
      .order("sequence_order");

    if (templatesError || !templates?.length) {
      throw new Error("No message templates found");
    }

    // Group templates by conversation flow (every 10 templates is a flow)
    const conversationFlows: typeof templates[] = [];
    for (let i = 0; i < templates.length; i += 10) {
      conversationFlows.push(templates.slice(i, i + 10));
    }

    // 8. Schedule messages for each pair
    const now = new Date();
    const allMessages = [];

    for (const pair of createdPairs) {
      // Pick a random conversation flow
      const flow = conversationFlows[Math.floor(Math.random() * conversationFlows.length)];
      
      // Random number of messages (5-10)
      const messageCount = Math.floor(
        Math.random() * (messagesPerPairMax - messagesPerPairMin + 1) + messagesPerPairMin
      );
      const selectedTemplates = flow.slice(0, messageCount);

      let currentTime = new Date(now.getTime() + Math.random() * 30 * 60 * 1000); // Start within 30 mins

      for (const template of selectedTemplates) {
        // Add random delay: 2-45 minutes between messages
        const delayMinutes = 2 + Math.random() * 43;
        currentTime = new Date(currentTime.getTime() + delayMinutes * 60 * 1000);

        // Ensure we're in active hours (8 AM - 11 PM)
        const hours = currentTime.getHours();
        if (hours < 8) {
          currentTime.setHours(8, Math.floor(Math.random() * 60), 0);
        } else if (hours >= 23) {
          // Schedule for next day
          currentTime.setDate(currentTime.getDate() + 1);
          currentTime.setHours(8 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 60), 0);
        }

        // Determine sender based on template position
        const senderId = template.sender_position === "A" ? pair.account_a_id : pair.account_b_id;
        const receiverId = template.sender_position === "A" ? pair.account_b_id : pair.account_a_id;

        allMessages.push({
          pair_id: pair.id,
          sender_account_id: senderId,
          receiver_account_id: receiverId,
          message_content: template.message_text,
          message_type: "text",
          scheduled_at: currentTime.toISOString(),
          reply_delay_seconds: Math.floor(delayMinutes * 60),
          status: "pending",
        });
      }
    }

    // Insert all messages
    const { error: messagesError } = await supabase
      .from("warmup_messages")
      .insert(allMessages);

    if (messagesError) {
      throw new Error(`Failed to create messages: ${messagesError.message}`);
    }

    console.log(`Scheduled ${allMessages.length} messages for ${createdPairs.length} pairs`);

    return new Response(
      JSON.stringify({
        success: true,
        session_id: session.id,
        pairs_created: createdPairs.length,
        messages_scheduled: allMessages.length,
        unpaired_account: shuffled.length % 2 === 1 ? shuffled[shuffled.length - 1].phone_number : null,
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
