import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Python file contents - these are the source of truth
const PYTHON_FILES: Record<string, string> = {};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const url = new URL(req.url);
    const fileName = url.searchParams.get("file");

    // List available files
    const { data: files, error: listError } = await supabase.storage
      .from("python-scripts")
      .list("", { limit: 100 });

    if (listError) {
      console.error("List error:", listError);
      return new Response(JSON.stringify({ error: "Failed to list files" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If specific file requested
    if (fileName) {
      const { data, error } = await supabase.storage
        .from("python-scripts")
        .download(fileName);

      if (error || !data) {
        return new Response(JSON.stringify({ error: `File not found: ${fileName}` }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const content = await data.text();
      return new Response(content, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    }

    // Return list of available files
    const fileList = files?.map(f => f.name).filter(n => n.endsWith(".py") || n.endsWith(".txt") || n.endsWith(".bat") || n.endsWith(".zip")) || [];

    return new Response(JSON.stringify({ files: fileList }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
