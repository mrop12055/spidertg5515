import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const url = new URL(req.url);
    const path = url.pathname.replace('/telegram-api', '');
    
    
    console.log(`[telegram-api] ${req.method} ${path}`);

    // Route handling
    switch (true) {
      // ==================== ACCOUNTS ====================
      case path === '/accounts' && req.method === 'GET': {
        const { data, error } = await supabase
          .from('telegram_accounts')
          .select('*, proxies(*)');
        
        if (error) throw error;
        return jsonResponse(data);
      }

      case path === '/accounts' && req.method === 'POST': {
        const body = await req.json();
        const { data, error } = await supabase
          .from('telegram_accounts')
          .insert(body)
          .select()
          .single();
        
        if (error) throw error;
        return jsonResponse(data, 201);
      }

      case path.startsWith('/accounts/') && req.method === 'PATCH': {
        const id = path.split('/')[2];
        const body = await req.json();
        const { data, error } = await supabase
          .from('telegram_accounts')
          .update(body)
          .eq('id', id)
          .select()
          .single();
        
        if (error) throw error;
        return jsonResponse(data);
      }

      case path.startsWith('/accounts/') && req.method === 'DELETE': {
        const id = path.split('/')[2];
        const { error } = await supabase
          .from('telegram_accounts')
          .delete()
          .eq('id', id);
        
        if (error) throw error;
        return jsonResponse({ success: true });
      }

      // ==================== PROXIES ====================
      case path === '/proxies' && req.method === 'GET': {
        const { data, error } = await supabase
          .from('proxies')
          .select('*');
        
        if (error) throw error;
        return jsonResponse(data);
      }

      case path === '/proxies' && req.method === 'POST': {
        const body = await req.json();
        const { data, error } = await supabase
          .from('proxies')
          .insert(body)
          .select()
          .single();
        
        if (error) throw error;
        return jsonResponse(data, 201);
      }

      case path === '/proxies/bulk' && req.method === 'POST': {
        const body = await req.json();
        const { data, error } = await supabase
          .from('proxies')
          .insert(body.proxies)
          .select();
        
        if (error) throw error;
        return jsonResponse(data, 201);
      }

      case path.startsWith('/proxies/') && req.method === 'DELETE': {
        const id = path.split('/')[2];
        const { error } = await supabase
          .from('proxies')
          .delete()
          .eq('id', id);
        
        if (error) throw error;
        return jsonResponse({ success: true });
      }

      // ==================== CONVERSATIONS ====================
      case path === '/conversations' && req.method === 'GET': {
        const accountId = url.searchParams.get('account_id');
        let query = supabase
          .from('conversations')
          .select('*')
          .order('updated_at', { ascending: false });
        
        if (accountId) {
          query = query.eq('account_id', accountId);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        return jsonResponse(data);
      }

      case path === '/conversations' && req.method === 'POST': {
        const body = await req.json();
        const { data, error } = await supabase
          .from('conversations')
          .insert(body)
          .select()
          .single();
        
        if (error) throw error;
        return jsonResponse(data, 201);
      }

      // ==================== MESSAGES ====================
      case path === '/messages' && req.method === 'GET': {
        const conversationId = url.searchParams.get('conversation_id');
        if (!conversationId) {
          return jsonResponse({ error: 'conversation_id required' }, 400);
        }
        
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true });
        
        if (error) throw error;
        return jsonResponse(data);
      }

      case path === '/messages' && req.method === 'POST': {
        const body = await req.json();
        const { data, error } = await supabase
          .from('messages')
          .insert(body)
          .select()
          .single();
        
        if (error) throw error;
        
        // Update conversation's last_message_at
        await supabase
          .from('conversations')
          .update({ 
            last_message_at: new Date().toISOString(),
            unread_count: body.direction === 'incoming' ? 
              supabase.rpc('increment_unread', { conv_id: body.conversation_id }) : undefined
          })
          .eq('id', body.conversation_id);
        
        return jsonResponse(data, 201);
      }

      case path.startsWith('/messages/') && req.method === 'PATCH': {
        const id = path.split('/')[2];
        const body = await req.json();
        const { data, error } = await supabase
          .from('messages')
          .update(body)
          .eq('id', id)
          .select()
          .single();
        
        if (error) throw error;
        return jsonResponse(data);
      }

      // ==================== CAMPAIGNS ====================
      case path === '/campaigns' && req.method === 'GET': {
        const { data, error } = await supabase
          .from('campaigns')
          .select('*, campaign_accounts(account_id)')
          .order('created_at', { ascending: false });
        
        if (error) throw error;
        return jsonResponse(data);
      }

      case path === '/campaigns' && req.method === 'POST': {
        const body = await req.json();
        const { account_ids, ...campaignData } = body;
        
        const { data: campaign, error } = await supabase
          .from('campaigns')
          .insert(campaignData)
          .select()
          .single();
        
        if (error) throw error;
        
        // Link accounts to campaign
        if (account_ids?.length) {
          await supabase
            .from('campaign_accounts')
            .insert(account_ids.map((aid: string) => ({
              campaign_id: campaign.id,
              account_id: aid
            })));
        }
        
        return jsonResponse(campaign, 201);
      }


      default:
        return jsonResponse({ error: 'Not found', path }, 404);
    }
  } catch (err) {
    const error = err as Error;
    console.error('[telegram-api] Error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
