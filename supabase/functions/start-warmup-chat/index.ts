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

    const { messagesPerPairMin = 20, messagesPerPairMax = 30, specificPairAccountIds } = await req.json();

    console.log("Starting warmup chat with settings:", { messagesPerPairMin, messagesPerPairMax, specificPairAccountIds });

    // If specific pair is requested, only warmup those 2 accounts
    if (specificPairAccountIds && specificPairAccountIds.length === 2) {
      console.log("Starting warmup for specific pair:", specificPairAccountIds);
      
      // Get the two specific accounts - allow active OR restricted for warmup
      const { data: accounts, error: accountsError } = await supabase
        .from("telegram_accounts")
        .select("id, phone_number, first_name, telegram_id, username, status")
        .in("id", specificPairAccountIds)
        .in("status", ["active", "restricted"])
        .not("session_data", "is", null);

      if (accountsError || !accounts || accounts.length !== 2) {
        // Get more details about what's wrong
        const { data: allAccounts } = await supabase
          .from("telegram_accounts")
          .select("id, phone_number, status, session_data")
          .in("id", specificPairAccountIds);
        
        const details = (allAccounts || []).map((a: any) => 
          `${a.phone_number}: status=${a.status}, session=${a.session_data ? 'yes' : 'no'}`
        ).join(', ');
        
        console.log(`[start-warmup-chat] Accounts not usable: ${details}`);
        
        return new Response(
          JSON.stringify({ 
            error: "Both accounts must be active/restricted with valid sessions",
            details: details
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Try to find an existing active session, or create a new one
      let session;
      const { data: existingSession } = await supabase
        .from("warmup_sessions")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (existingSession) {
        // Use existing session and update total_pairs count
        session = existingSession;
        await supabase
          .from("warmup_sessions")
          .update({ total_pairs: (session.total_pairs || 0) + 1 })
          .eq("id", session.id);
        console.log("Using existing session:", session.id);
      } else {
        // Create a new session for this specific pair
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

        if (sessionError) {
          throw new Error(`Failed to create session: ${sessionError.message}`);
        }
        session = newSession;
        console.log("Created new session:", session.id);
      }

      // Check if these accounts have EVER exchanged contacts (check any previous pair between them)
      const { data: previousPairWithContacts } = await supabase
        .from("warmup_pairs")
        .select("id, contacts_exchanged")
        .eq("contacts_exchanged", true)
        .or(`and(account_a_id.eq.${accounts[0].id},account_b_id.eq.${accounts[1].id}),and(account_a_id.eq.${accounts[1].id},account_b_id.eq.${accounts[0].id})`)
        .limit(1);

      const contactsAlreadyExchanged = previousPairWithContacts && previousPairWithContacts.length > 0;
      console.log(`Contacts already exchanged (from previous pair): ${contactsAlreadyExchanged}`);

      // Check if an active pair already exists for these accounts in THIS session
      const { data: existingActivePair } = await supabase
        .from("warmup_pairs")
        .select("*")
        .eq("session_id", session.id)
        .or(`and(account_a_id.eq.${accounts[0].id},account_b_id.eq.${accounts[1].id}),and(account_a_id.eq.${accounts[1].id},account_b_id.eq.${accounts[0].id})`)
        .limit(1)
        .maybeSingle();

      let createdPair;
      
      if (existingActivePair) {
        // Reuse existing pair - just schedule new messages for it
        console.log(`Reusing existing pair: ${existingActivePair.id}`);
        createdPair = existingActivePair;
        
        // Update pair status to active if it was completed
        if (createdPair.status !== 'active') {
          await supabase
            .from("warmup_pairs")
            .update({ status: 'active' })
            .eq("id", createdPair.id);
        }
      } else {
        // Create the pair with contacts_exchanged already set if they've exchanged before
        const { data: newPair, error: pairError } = await supabase
          .from("warmup_pairs")
          .insert({
            account_a_id: accounts[0].id,
            account_b_id: accounts[1].id,
            session_id: session.id,
            status: "active",
            contacts_exchanged: contactsAlreadyExchanged, // Carry over from previous pair
          })
          .select()
          .single();

        if (pairError) {
          throw new Error(`Failed to create pair: ${pairError.message}`);
        }
        createdPair = newPair;
        console.log(`Created new pair: ${createdPair.id}`);
      }

      // Get ALL message templates
      const { data: templates } = await supabase
        .from("warmup_message_templates")
        .select("*");

      if (!templates?.length) {
        throw new Error("No message templates found");
      }

      // Get ALL previously used template IDs for this pair (from today's warmup_messages)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { data: usedMessagesToday } = await supabase
        .from("warmup_messages")
        .select("template_id")
        .or(`and(sender_account_id.eq.${accounts[0].id},receiver_account_id.eq.${accounts[1].id}),and(sender_account_id.eq.${accounts[1].id},receiver_account_id.eq.${accounts[0].id})`)
        .not("template_id", "is", null)
        .gte("created_at", today.toISOString());

      const usedTemplateIds = new Set((usedMessagesToday || []).map((m: any) => m.template_id));
      console.log(`Templates used today by this pair: ${usedTemplateIds.size}`);

      // Filter out ALL used templates to ensure random new ones
      let availableTemplates = templates.filter(t => !usedTemplateIds.has(t.id));
      
      // If all templates used today, reset and use all (allow repeats)
      if (availableTemplates.length === 0) {
        console.log("All templates used today, resetting pool");
        availableTemplates = templates;
      }
      
      // Shuffle available templates for true randomness
      const shuffledTemplates = [...availableTemplates].sort(() => Math.random() - 0.5);
      
      // Pick a "cycle template" (first template after shuffle) to track
      const cycleTemplateId = shuffledTemplates[0]?.id;
      
      const messageCount = Math.floor(
        Math.random() * (messagesPerPairMax - messagesPerPairMin + 1) + messagesPerPairMin
      );
      
      // Pick random templates and alternate sender positions
      const selectedTemplates = shuffledTemplates.slice(0, messageCount).map((t, i) => ({
        ...t,
        sender_position: i % 2 === 0 ? "A" : "B" // Alternate A and B
      }));
      
      // Update pair with the template we're using
      if (cycleTemplateId) {
        await supabase
          .from("warmup_pairs")
          .update({ last_template_id: cycleTemplateId })
          .eq("id", createdPair.id);
      }

      // Schedule tasks
      const now = new Date();
      let currentTime = new Date(now.getTime() + (10 + Math.random() * 20) * 1000);
      const allMessages: any[] = [];

      // Only add contact tasks if this is the first time these accounts interact
      if (!contactsAlreadyExchanged) {
        console.log("First warmup for this pair - scheduling contact exchange (BOTH first, then chat)");
        
        // IMPORTANT: Both accounts save each other as contacts FIRST before any chatting
        // Account A saves Account B as contact
        const contactTime1 = new Date(currentTime);
        allMessages.push({
          pair_id: createdPair.id,
          sender_account_id: accounts[0].id,
          receiver_account_id: accounts[1].id,
          message_content: accounts[1].first_name || "Friend",
          message_type: "add_contact",
          scheduled_at: contactTime1.toISOString(),
          reply_delay_seconds: 3,
          status: "pending",
        });

        // Account B saves Account A as contact (scheduled at SAME time or 1-2 seconds later)
        // This ensures both contacts are saved nearly simultaneously
        const contactTime2 = new Date(contactTime1.getTime() + (1000 + Math.random() * 1000));
        allMessages.push({
          pair_id: createdPair.id,
          sender_account_id: accounts[1].id,
          receiver_account_id: accounts[0].id,
          message_content: accounts[0].first_name || "Friend",
          message_type: "add_contact",
          scheduled_at: contactTime2.toISOString(),
          reply_delay_seconds: 3,
          status: "pending",
        });

        // Wait 8-12 seconds after BOTH contacts are saved before starting chat
        // This gives enough time for both contact operations to complete
        currentTime = new Date(contactTime2.getTime() + (8000 + Math.random() * 4000));
      } else {
        console.log("Contacts already exchanged - skipping contact tasks");
      }

      // Schedule chat messages with human-like timing
      for (let i = 0; i < selectedTemplates.length; i++) {
        const template = selectedTemplates[i];
        const isLastMessage = i === selectedTemplates.length - 1;
        
        // Human-like timing variations
        const isQuickReply = Math.random() < 0.3; // 30% quick replies
        const isSlowThinking = Math.random() < 0.15; // 15% slow thinking
        const isTypingLong = template.message_text.length > 50;
        
        let baseDelay: number;
        if (isQuickReply) {
          baseDelay = 3 + Math.random() * 8; // 3-11 seconds quick
        } else if (isSlowThinking) {
          baseDelay = 30 + Math.random() * 60; // 30-90 seconds slow
        } else {
          baseDelay = 8 + Math.random() * 25; // 8-33 seconds normal
        }
        
        // Typing simulation based on message length (40-60 chars per minute)
        const typingSpeed = 40 + Math.random() * 20;
        const typingTime = (template.message_text.length / typingSpeed) * 60;
        
        // Random jitter
        const jitter = Math.random() * 5;
        
        // Occasional long pause (distraction)
        const distractionPause = Math.random() < 0.08 ? (60 + Math.random() * 120) : 0;
        
        const delaySeconds = baseDelay + typingTime + jitter + distractionPause;
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
          reply_delay_seconds: Math.floor(delaySeconds),
          status: "pending",
          template_id: template.id,
          is_cycle_last: isLastMessage, // Mark last message of cycle
        });
      }

      if (allMessages.length > 0) {
        const { error: messagesError } = await supabase
          .from("warmup_messages")
          .insert(allMessages);

        if (messagesError) {
          throw new Error(`Failed to create messages: ${messagesError.message}`);
        }
      }

      const estimatedDurationMinutes = Math.ceil((allMessages.length * 30) / 60);

      console.log(`Single pair warmup: ${allMessages.length} messages scheduled`);

      return new Response(
        JSON.stringify({
          success: true,
          session_id: session.id,
          pairs_created: 1,
          messages_scheduled: allMessages.length,
          estimated_duration_minutes: estimatedDurationMinutes,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- FULL WARMUP FOR ALL ACCOUNTS ---

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

    // 7. Get ALL message templates for random selection
    const { data: templates, error: templatesError } = await supabase
      .from("warmup_message_templates")
      .select("*");

    if (templatesError || !templates?.length) {
      throw new Error("No message templates found");
    }

    console.log(`Found ${templates.length} message templates`);

    // 8. Create account lookup map
    const accountMap = new Map(accounts.map(a => [a.id, a]));

    // 9. Check which account combinations already have contacts exchanged (check ALL previous pairs)
    // Build a set of account pairs that have exchanged contacts
    const contactsExchangedSet = new Set<string>();
    
    // Get all previous pairs with contacts_exchanged=true for all involved accounts
    const pairAccountIds = createdPairs.flatMap(p => [p.account_a_id, p.account_b_id]);
    const { data: previousPairsWithContacts } = await supabase
      .from("warmup_pairs")
      .select("account_a_id, account_b_id")
      .eq("contacts_exchanged", true)
      .or(`account_a_id.in.(${pairAccountIds.join(',')}),account_b_id.in.(${pairAccountIds.join(',')})`);

    for (const pp of (previousPairsWithContacts || [])) {
      // Store both directions (a-b and b-a)
      contactsExchangedSet.add(`${pp.account_a_id}-${pp.account_b_id}`);
      contactsExchangedSet.add(`${pp.account_b_id}-${pp.account_a_id}`);
    }

    console.log(`Found ${contactsExchangedSet.size / 2} account pairs with prior contact exchange`);

    // 10. Schedule contact tasks + messages for each pair
    const now = new Date();
    const allMessages: any[] = [];
    const pairsNeedingContactFlag: string[] = []; // Track pairs that need contacts_exchanged=true after scheduling

    for (let pairIndex = 0; pairIndex < createdPairs.length; pairIndex++) {
      const pair = createdPairs[pairIndex];
      const accountA = accountMap.get(pair.account_a_id);
      const accountB = accountMap.get(pair.account_b_id);
      
      if (!accountA || !accountB) continue;

      // Check if this account combination already exchanged contacts (in ANY previous pair)
      const contactsAlreadyExchanged = contactsExchangedSet.has(`${pair.account_a_id}-${pair.account_b_id}`);

      // Stagger pair start times (each pair starts 5-15 seconds after previous)
      const pairStartOffset = pairIndex * (5000 + Math.random() * 10000);
      let currentTime = new Date(now.getTime() + 10000 + pairStartOffset);

      // Only add contact tasks if first warmup for this pair
      if (!contactsAlreadyExchanged) {
        // Track this pair needs contacts_exchanged flag after add_contact succeeds
        pairsNeedingContactFlag.push(pair.id);
        
        // IMPORTANT: Both accounts save each other as contacts FIRST before any chatting
        // Account A saves Account B as contact
        const contactTime1 = new Date(currentTime);
        allMessages.push({
          pair_id: pair.id,
          sender_account_id: pair.account_a_id,
          receiver_account_id: pair.account_b_id,
          message_content: accountB.first_name || "Friend",
          message_type: "add_contact",
          scheduled_at: contactTime1.toISOString(),
          reply_delay_seconds: 3,
          status: "pending",
        });

        // Account B saves Account A as contact (scheduled at SAME time or 1-2 seconds later)
        const contactTime2 = new Date(contactTime1.getTime() + (1000 + Math.random() * 1000));
        allMessages.push({
          pair_id: pair.id,
          sender_account_id: pair.account_b_id,
          receiver_account_id: pair.account_a_id,
          message_content: accountA.first_name || "Friend",
          message_type: "add_contact",
          scheduled_at: contactTime2.toISOString(),
          reply_delay_seconds: 3,
          status: "pending",
        });

        // Wait 8-12 seconds after BOTH contacts are saved before starting chat
        currentTime = new Date(contactTime2.getTime() + (8000 + Math.random() * 4000));
        
        console.log(`Pair ${pair.id}: scheduling contact exchange (first warmup between these accounts)`);
      } else {
        console.log(`Pair ${pair.id}: skipping contact exchange (already done in previous session)`);
      }

      // Get ALL previously used template IDs for this pair TODAY
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { data: usedMessagesToday } = await supabase
        .from("warmup_messages")
        .select("template_id")
        .or(`and(sender_account_id.eq.${pair.account_a_id},receiver_account_id.eq.${pair.account_b_id}),and(sender_account_id.eq.${pair.account_b_id},receiver_account_id.eq.${pair.account_a_id})`)
        .not("template_id", "is", null)
        .gte("created_at", today.toISOString());

      const usedTemplateIds = new Set((usedMessagesToday || []).map((m: any) => m.template_id));
      
      // Filter out ALL used templates to ensure random new ones
      let availableTemplates = templates.filter(t => !usedTemplateIds.has(t.id));
      
      // If all templates used today, reset and use all (allow repeats)
      if (availableTemplates.length === 0) {
        availableTemplates = templates;
      }
      
      // Shuffle available templates for true randomness
      const shuffledTemplates = [...availableTemplates].sort(() => Math.random() - 0.5);
      
      // Pick a "cycle template" (first template after shuffle) to track
      const cycleTemplateId = shuffledTemplates[0]?.id;
      
      // Random number of messages between min and max
      const messageCount = Math.floor(
        Math.random() * (messagesPerPairMax - messagesPerPairMin + 1) + messagesPerPairMin
      );
      
      // Pick random templates and alternate sender positions
      const selectedTemplates = shuffledTemplates.slice(0, messageCount).map((t, i) => ({
        ...t,
        sender_position: i % 2 === 0 ? "A" : "B" // Alternate A and B
      }));
      
      // Update pair with the template we're using
      if (cycleTemplateId) {
        await supabase
          .from("warmup_pairs")
          .update({ last_template_id: cycleTemplateId })
          .eq("id", pair.id);
      }

      // Schedule chat messages with human-like timing
      for (let i = 0; i < selectedTemplates.length; i++) {
        const template = selectedTemplates[i];
        const isLastMessage = i === selectedTemplates.length - 1;
        
        // Human-like timing variations
        const isQuickReply = Math.random() < 0.3; // 30% quick replies
        const isSlowThinking = Math.random() < 0.15; // 15% slow thinking
        
        let baseDelay: number;
        if (isQuickReply) {
          baseDelay = 3 + Math.random() * 8; // 3-11 seconds quick
        } else if (isSlowThinking) {
          baseDelay = 30 + Math.random() * 60; // 30-90 seconds slow
        } else {
          baseDelay = 8 + Math.random() * 25; // 8-33 seconds normal
        }
        
        // Typing simulation based on message length (40-60 chars per minute)
        const typingSpeed = 40 + Math.random() * 20;
        const typingTime = (template.message_text.length / typingSpeed) * 60;
        
        // Random jitter
        const jitter = Math.random() * 5;
        
        // Occasional long pause (distraction)
        const distractionPause = Math.random() < 0.08 ? (60 + Math.random() * 120) : 0;
        
        const delaySeconds = baseDelay + typingTime + jitter + distractionPause;
        currentTime = new Date(currentTime.getTime() + delaySeconds * 1000);

        const senderId = template.sender_position === "A" ? pair.account_a_id : pair.account_b_id;
        const receiverId = template.sender_position === "A" ? pair.account_b_id : pair.account_a_id;

        allMessages.push({
          pair_id: pair.id,
          sender_account_id: senderId,
          receiver_account_id: receiverId,
          message_content: template.message_text,
          message_type: "text",
          scheduled_at: currentTime.toISOString(),
          reply_delay_seconds: Math.floor(delaySeconds),
          status: "pending",
          template_id: template.id,
          is_cycle_last: isLastMessage, // Mark last message of cycle
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
