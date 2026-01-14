import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

export interface DbTelegramAccount {
  id: string;
  phone_number: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  status: 'active' | 'banned' | 'restricted' | 'disconnected' | 'cooldown';
  proxy_id: string | null;
  session_data: string | null;
  api_id: string | null;
  api_hash: string | null;
  created_at: string;
  last_active: string | null;
  messages_sent_today: number;
  daily_limit: number;
  maturity_score: number;
  maturity_days: number;
  restricted_until: string | null;
  ban_reason: string | null;
  avatar_url: string | null;
  telegram_id: number | null;
}

export interface DbProxy {
  id: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  proxy_type: 'http' | 'https' | 'socks4' | 'socks5';
  status: 'active' | 'inactive' | 'error';
  assigned_account_id: string | null;
  last_checked: string | null;
  response_time: number | null;
  country: string | null;
  created_at: string;
}

export interface DbConversation {
  id: string;
  account_id: string;
  recipient_phone: string | null;
  recipient_telegram_id: number | null;
  recipient_name: string | null;
  recipient_username: string | null;
  recipient_avatar: string | null;
  unread_count: number;
  is_active: boolean;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  account_id: string;
  conversation_id: string;
  telegram_message_id: number | null;
  content: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

export interface DbCampaign {
  id: string;
  name: string;
  message_template: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed';
  scheduled_at: string | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  reply_count: number;
  created_at: string;
  updated_at: string;
}

export const useDatabase = () => {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<DbTelegramAccount[]>([]);
  const [proxies, setProxies] = useState<DbProxy[]>([]);
  const [conversations, setConversations] = useState<DbConversation[]>([]);
  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [campaigns, setCampaigns] = useState<DbCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch all data
  const fetchData = useCallback(async () => {
    try {
      // Important: avoid selecting very large columns (e.g. session_data) in admin UI fetches
      const accountsSelect =
        'id,phone_number,username,first_name,last_name,status,proxy_id,created_at,last_active,messages_sent_today,daily_limit,maturity_score,maturity_days,restricted_until,ban_reason,avatar_url,telegram_id' as const;

      const [accountsRes, proxiesRes, conversationsRes, messagesRes, campaignsRes] = await Promise.all([
        supabase.from('telegram_accounts').select(accountsSelect).order('created_at', { ascending: false }),
        supabase.from('proxies').select('*').order('created_at', { ascending: false }),
        supabase.from('conversations').select('*').order('updated_at', { ascending: false }),
        // Keep UI responsive: load the most recent messages only (older messages can be paginated later)
        supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(10000),
        supabase.from('campaigns').select('*').order('created_at', { ascending: false }),
      ]);

      if (accountsRes.data) setAccounts(accountsRes.data as DbTelegramAccount[]);
      if (proxiesRes.data) setProxies(proxiesRes.data as DbProxy[]);
      if (conversationsRes.data) setConversations(conversationsRes.data as DbConversation[]);
      if (messagesRes.data) setMessages(messagesRes.data as DbMessage[]);
      if (campaignsRes.data) setCampaigns(campaignsRes.data as DbCampaign[]);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Set up realtime subscriptions
  useEffect(() => {
    fetchData();

    // Subscribe to realtime updates
    const accountsChannel = supabase
      .channel('accounts-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_accounts' }, () => {
        fetchData();
      })
      .subscribe();

    const messagesChannel = supabase
      .channel('messages-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
        fetchData();
      })
      .subscribe();

    const conversationsChannel = supabase
      .channel('conversations-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => {
        fetchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(accountsChannel);
      supabase.removeChannel(messagesChannel);
      supabase.removeChannel(conversationsChannel);
    };
  }, [fetchData]);

  // Account operations
  const addAccount = async (account: Partial<DbTelegramAccount>) => {
    const { data, error } = await supabase
      .from('telegram_accounts')
      .insert(account as any)
      .select()
      .single();

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return null;
    }
    
    toast({ title: 'Account added successfully' });
    await fetchData();
    return data;
  };

  const updateAccount = async (id: string, updates: Partial<DbTelegramAccount>) => {
    const { error } = await supabase
      .from('telegram_accounts')
      .update(updates as any)
      .eq('id', id);

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return false;
    }
    
    await fetchData();
    return true;
  };

  const deleteAccount = async (id: string) => {
    const { error } = await supabase
      .from('telegram_accounts')
      .delete()
      .eq('id', id);

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return false;
    }
    
    toast({ title: 'Account deleted' });
    await fetchData();
    return true;
  };

  // Proxy operations
  const addProxy = async (proxy: Partial<DbProxy>) => {
    const { data, error } = await supabase
      .from('proxies')
      .insert(proxy as any)
      .select()
      .single();

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return null;
    }
    
    toast({ title: 'Proxy added successfully' });
    await fetchData();
    return data;
  };

  const addProxiesBulk = async (proxyText: string) => {
    const lines = proxyText.split('\n').filter(l => l.trim());
    const proxiesToAdd = lines.map((line) => {
      const parts = line.split(':');
      // Detect proxy type from 5th part or default to http
      const typeStr = parts[4]?.toLowerCase().trim() || 'http';
      let proxyType: 'http' | 'https' | 'socks4' | 'socks5' = 'http';
      if (typeStr === 'socks5' || typeStr === 's5') proxyType = 'socks5';
      else if (typeStr === 'socks4' || typeStr === 's4') proxyType = 'socks4';
      else if (typeStr === 'https') proxyType = 'https';
      
      return {
        host: parts[0] || '',
        port: parseInt(parts[1]) || 8080,
        username: parts[2] || null,
        password: parts[3] || null,
        proxy_type: proxyType,
        status: 'active' as const,
      };
    });

    const { error } = await supabase
      .from('proxies')
      .insert(proxiesToAdd as any);

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return false;
    }
    
    toast({ title: `${proxiesToAdd.length} proxies added` });
    await fetchData();
    return true;
  };

  const deleteProxy = async (id: string) => {
    const { error } = await supabase
      .from('proxies')
      .delete()
      .eq('id', id);

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return false;
    }
    
    await fetchData();
    return true;
  };

  const assignProxy = async (accountId: string, proxyId: string) => {
    const { error } = await supabase
      .from('telegram_accounts')
      .update({ proxy_id: proxyId })
      .eq('id', accountId);

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return false;
    }
    
    await fetchData();
    return true;
  };

  // Message operations
  const sendMessage = async (accountId: string, conversationId: string, content: string) => {
    const { data, error } = await supabase
      .from('messages')
      .insert({
        account_id: accountId,
        conversation_id: conversationId,
        content,
        direction: 'outgoing',
        status: 'pending',
      } as any)
      .select()
      .single();

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return null;
    }
    
    await fetchData();
    return data;
  };

  const markConversationAsRead = async (conversationId: string) => {
    await supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId);
    
    await fetchData();
  };

  const startNewConversation = async (accountId: string, recipientPhone: string, recipientName?: string) => {
    // Check if conversation exists
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('recipient_phone', recipientPhone)
      .maybeSingle();

    if (existing) return existing.id;

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        account_id: accountId,
        recipient_phone: recipientPhone,
        recipient_name: recipientName,
        is_active: false,
        unread_count: 0,
      } as any)
      .select()
      .single();

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return null;
    }

    await fetchData();
    return data.id;
  };

  // Campaign operations
  const createCampaign = async (campaign: Partial<DbCampaign>) => {
    const { data, error } = await supabase
      .from('campaigns')
      .insert(campaign as any)
      .select()
      .single();

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return null;
    }
    
    toast({ title: 'Campaign created' });
    await fetchData();
    return data;
  };

  const updateCampaign = async (id: string, updates: Partial<DbCampaign>) => {
    const { error } = await supabase
      .from('campaigns')
      .update(updates as any)
      .eq('id', id);

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return false;
    }
    
    await fetchData();
    return true;
  };

  const deleteCampaign = async (id: string) => {
    const { error } = await supabase
      .from('campaigns')
      .delete()
      .eq('id', id);

    if (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
      return false;
    }
    
    toast({ title: 'Campaign deleted' });
    await fetchData();
    return true;
  };

  return {
    // Data
    accounts,
    proxies,
    conversations,
    messages,
    campaigns,
    loading,

    // Actions
    fetchData,
    addAccount,
    updateAccount,
    deleteAccount,
    addProxy,
    addProxiesBulk,
    deleteProxy,
    assignProxy,
    sendMessage,
    markConversationAsRead,
    startNewConversation,
    createCampaign,
    updateCampaign,
    deleteCampaign,
  };
};
