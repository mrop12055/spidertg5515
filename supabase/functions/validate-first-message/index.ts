import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// URL detection patterns
const URL_PATTERNS = [
  /https?:\/\/[^\s]+/gi,
  /www\.[^\s]+/gi,
  /[a-zA-Z0-9-]+\.(com|net|org|io|co|me|app|dev|xyz|info|biz|ru|ua|de|fr|uk|cn)[^\s]*/gi,
  /t\.me\/[^\s]+/gi,
  /telegram\.me\/[^\s]+/gi,
  /bit\.ly\/[^\s]+/gi,
  /tinyurl\.com\/[^\s]+/gi,
];

// High-risk patterns for first messages
const HIGH_RISK_PATTERNS = [
  /join.*group/i,
  /click.*link/i,
  /free.*money/i,
  /earn.*\$/i,
  /investment.*opportunity/i,
  /crypto.*profit/i,
  /limited.*offer/i,
  /act.*now/i,
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

    const { account_id, recipient_phone, recipient_telegram_id, message_content } = await req.json();

    console.log(`[validate-first-message] Validating message for account ${account_id}`);

    const validation = {
      is_valid: true,
      is_first_message: false,
      has_prior_contact: false,
      warnings: [] as string[],
      blocks: [] as string[],
      risk_level: "low" as "low" | "medium" | "high",
    };

    // Check for existing conversation (prior contact)
    const { data: existingConversation } = await supabase
      .from("conversations")
      .select("id, has_prior_contact, first_message_sent")
      .eq("account_id", account_id)
      .or(`recipient_phone.eq.${recipient_phone},recipient_telegram_id.eq.${recipient_telegram_id}`)
      .maybeSingle();

    if (existingConversation) {
      validation.has_prior_contact = existingConversation.has_prior_contact || existingConversation.first_message_sent;
      validation.is_first_message = !existingConversation.first_message_sent;
    } else {
      // No conversation exists, this is definitely a first message
      validation.is_first_message = true;
    }

    console.log(`[validate-first-message] Is first message: ${validation.is_first_message}, Has prior contact: ${validation.has_prior_contact}`);

    // Check for URLs in message
    let hasUrl = false;
    for (const pattern of URL_PATTERNS) {
      if (pattern.test(message_content)) {
        hasUrl = true;
        break;
      }
    }

    if (hasUrl) {
      if (validation.is_first_message && !validation.has_prior_contact) {
        validation.blocks.push("URLs are blocked in first messages to new contacts");
        validation.is_valid = false;
        validation.risk_level = "high";
      } else {
        validation.warnings.push("Message contains URL - use with caution");
        validation.risk_level = "medium";
      }
    }

    // Check for high-risk patterns
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(message_content)) {
        if (validation.is_first_message) {
          validation.blocks.push(`High-risk spam pattern detected: "${pattern.source}"`);
          validation.is_valid = false;
          validation.risk_level = "high";
        } else {
          validation.warnings.push("Message contains potentially spammy content");
          if (validation.risk_level !== "high") validation.risk_level = "medium";
        }
        break;
      }
    }

    // Check message length for first message
    if (validation.is_first_message && message_content.length > 500) {
      validation.warnings.push("Long first messages may appear spammy - consider shortening");
      if (validation.risk_level === "low") validation.risk_level = "medium";
    }

    // Check for excessive emoji usage
    const emojiCount = (message_content.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
    if (emojiCount > 5) {
      validation.warnings.push("Excessive emoji usage may trigger spam filters");
      if (validation.risk_level === "low") validation.risk_level = "medium";
    }

    // Check for CAPS LOCK abuse
    const upperCount = (message_content.match(/[A-Z]/g) || []).length;
    const letterCount = (message_content.match(/[a-zA-Z]/g) || []).length;
    if (letterCount > 10 && upperCount / letterCount > 0.5) {
      validation.warnings.push("Excessive capital letters may trigger spam filters");
      if (validation.risk_level === "low") validation.risk_level = "medium";
    }

    console.log(`[validate-first-message] Validation complete. Valid: ${validation.is_valid}, Risk: ${validation.risk_level}`);

    return new Response(JSON.stringify({
      success: true,
      validation,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[validate-first-message] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
