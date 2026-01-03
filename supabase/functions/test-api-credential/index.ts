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

    // Find an active account using this API credential to test with
    const { data: testAccount } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number")
      .eq("api_credential_id", api_credential_id)
      .in("status", ["active", "cooldown", "restricted"])
      .not("session_data", "is", null)
      .limit(1)
      .maybeSingle();

    if (!testAccount) {
      // No account to test with - try to find any account with session data
      const { data: anyAccount } = await supabase
        .from("telegram_accounts")
        .select("id, phone_number")
        .not("session_data", "is", null)
        .limit(1)
        .maybeSingle();

      if (!anyAccount) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: "No accounts with session data available to test this API credential" 
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Temporarily assign this account to the API credential for testing
      await supabase
        .from("telegram_accounts")
        .update({ 
          api_credential_id: api_credential_id,
          api_id: credential.api_id,
          api_hash: credential.api_hash
        })
        .eq("id", anyAccount.id);

      // Create test task
      const { data: task, error: taskError } = await supabase
        .from("account_check_tasks")
        .insert({
          account_id: anyAccount.id,
          task_type: "api_test",
          status: "pending",
        })
        .select()
        .single();

      if (taskError) {
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

      console.log(`[test-api-credential] Created test task ${task.id} for account ${anyAccount.phone_number}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          task_id: task.id,
          account_id: anyAccount.id,
          message: `Testing with account ${anyAccount.phone_number}` 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create test task for the existing account
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
