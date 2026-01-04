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

    const { api_credential_id } = await req.json();

    if (!api_credential_id) {
      return new Response(
        JSON.stringify({ success: false, error: "api_credential_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[test-api-credential] Testing API credential: ${api_credential_id}`);

    // Get the API credential
    const { data: credential, error: credError } = await supabase
      .from("telegram_api_credentials")
      .select("*")
      .eq("id", api_credential_id)
      .single();

    if (credError || !credential) {
      return new Response(
        JSON.stringify({ success: false, error: "API credential not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use the dedicated test account (+919304373119) for API validation
    const TEST_PHONE = "+919304373119";
    
    const { data: testAccount } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, session_data, api_credential_id")
      .eq("phone_number", TEST_PHONE)
      .not("session_data", "is", null)
      .maybeSingle();

    if (!testAccount) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: `Test account ${TEST_PHONE} not found or has no session data` 
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Store original API credential to restore after test
    const originalCredentialId = testAccount.api_credential_id;

    // Temporarily assign the API credential being tested to this account
    await supabase
      .from("telegram_accounts")
      .update({ 
        api_credential_id: api_credential_id,
        api_id: credential.api_id,
        api_hash: credential.api_hash
      })
      .eq("id", testAccount.id);

    console.log(`[test-api-credential] Temporarily assigned API credential ${api_credential_id} to test account ${TEST_PHONE}`);

    // Create test task
    const { data: task, error: taskError } = await supabase
      .from("account_check_tasks")
      .insert({
        account_id: testAccount.id,
        task_type: "api_test",
        status: "pending",
      })
      .select()
      .single();

    if (taskError) {
      // Restore original credential on failure
      await supabase
        .from("telegram_accounts")
        .update({ api_credential_id: originalCredentialId })
        .eq("id", testAccount.id);
        
      console.error(`[test-api-credential] Failed to create task:`, taskError);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to create test task" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mark credential as being tested
    await supabase
      .from("telegram_api_credentials")
      .update({ last_validated_at: null })
      .eq("id", api_credential_id);

    console.log(`[test-api-credential] Created test task ${task.id} for account ${testAccount.phone_number}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        task_id: task.id,
        account_id: testAccount.id,
        message: `Testing with account ${testAccount.phone_number}` 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("[test-api-credential] Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
