import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Conversation } from '@/types/telegram';
import { useEffect } from 'react';

// Transform DB row to Conversation type
const transformConversation = (c: any): Conversation => ({
  id: c.id,
  accountId: c.account_id,
  recipientPhone: c.recipient_phone || '',
  recipientName: c.recipient_name || undefined,
  recipientUsername: c.recipient_username || undefined,
  recipientAvatar: c.recipient_avatar || undefined,
  unreadCount: c.unread_count || 0,
  isActive: c.is_active || false,
  createdAt: new Date(c.created_at),
  updatedAt: new Date(c.updated_at || c.created_at),
  lastMessageAt: c.last_message_at ? new Date(c.last_message_at) : undefined,
  lastMessageContent: c.last_message_content || undefined,
  blockedByRecipient: c.blocked_by_recipient || false,
  firstMessageSent: c.first_message_sent ?? false,
  hasReply: c.has_reply ?? false,
  seatId: c.seat_id || undefined,
});

const fetchConversations = async (): Promise<Conversation[]> => {
  // Fetch only conversations with first_message_sent=true to reduce data by ~70%
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 100;
  const all: any[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabase
      .from('conversations')
      .select('id,account_id,recipient_phone,recipient_telegram_id,recipient_name,recipient_username,recipient_avatar,unread_count,is_active,last_message_at,last_message_content,created_at,updated_at,blocked_by_recipient,first_message_sent,has_reply,seat_id')
      // Removed first_message_sent filter - incoming-only conversations also have replies
      .not('last_message_at', 'is', null)
      .order('last_message_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;
    
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  return all.map(transformConversation);
};

export const useConversations = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 30000, // Data stays fresh for 30 seconds
    gcTime: 300000, // Cache persists for 5 minutes
    refetchOnWindowFocus: false,
  });

  // Setup realtime subscription for optimistic updates
  useEffect(() => {
    let debounceTimer: NodeJS.Timeout | null = null;
    
    const debouncedUpdate = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }, 3000); // 3 second debounce
    };

    const channel = supabase
      .channel('conversations-cache-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            const newConv = transformConversation(payload.new);
            // Add if it has a last message (either we sent first or they replied)
            if (newConv.lastMessageAt) {
              queryClient.setQueryData<Conversation[]>(['conversations'], (old) => {
                if (!old) return [newConv];
                if (old.some(c => c.id === newConv.id)) return old;
                return [newConv, ...old];
              });
            }
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as any;
            queryClient.setQueryData<Conversation[]>(['conversations'], (old) => {
              if (!old) return [];
              return old.map(c => {
                if (c.id !== updated.id) return c;
                return {
                  ...c,
                  recipientName: updated.recipient_name || c.recipientName,
                  recipientUsername: updated.recipient_username || c.recipientUsername,
                  recipientAvatar: updated.recipient_avatar || c.recipientAvatar,
                  unreadCount: updated.unread_count ?? c.unreadCount,
                  isActive: updated.is_active ?? c.isActive,
                  lastMessageAt: updated.last_message_at ? new Date(updated.last_message_at) : c.lastMessageAt,
                  lastMessageContent: updated.last_message_content ?? c.lastMessageContent,
                  blockedByRecipient: updated.blocked_by_recipient ?? c.blockedByRecipient,
                  hasReply: updated.has_reply ?? c.hasReply,
                  updatedAt: new Date(updated.updated_at || Date.now()),
                };
              });
            });
          } else if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as any)?.id;
            if (!deletedId) return;
            queryClient.setQueryData<Conversation[]>(['conversations'], (old) => {
              if (!old) return [];
              return old.filter(c => c.id !== deletedId);
            });
          }
        }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    conversations: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
    isStale: query.isStale,
  };
};
