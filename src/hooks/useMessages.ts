import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localClient as supabase } from '@/lib/localClient';
import { Message } from '@/types/telegram';
import { useEffect, useCallback } from 'react';

// Transform DB row to Message type
const transformMessage = (m: any, recipientPhone?: string): Message => {
  let status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' = 'pending';
  if (m.status === 'sent' || m.status === 'sending') status = 'sent';
  else if (m.status === 'delivered') status = 'delivered';
  else if (m.status === 'read') status = 'read';
  else if (m.status === 'failed' || m.status === 'cancelled') status = 'failed';
  
  return {
    id: m.id,
    conversationId: m.conversation_id,
    accountId: m.account_id,
    recipientPhone: recipientPhone || m.conversations?.recipient_phone || '',
    content: m.content,
    direction: m.direction as Message['direction'],
    status,
    timestamp: new Date(m.created_at),
    telegramMessageId: m.telegram_message_id || undefined,
    failedReason: m.failed_reason || undefined,
    mediaUrl: m.media_url || undefined,
    mediaType: m.media_type || undefined,
    campaignRecipientId: m.campaign_recipient_id || undefined,
  };
};

const fetchMessagesForConversation = async (conversationId: string): Promise<Message[]> => {
  if (!conversationId) return [];
  
  // Fetch messages for this specific conversation - limit to 100 for performance
  const { data, error } = await supabase
    .from('messages')
    .select('*, conversations(recipient_phone)')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) throw error;
  return (data || []).map(m => transformMessage(m));
};

export const useMessages = (conversationId: string | null) => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => fetchMessagesForConversation(conversationId!),
    enabled: !!conversationId,
    staleTime: 30000, // 30 seconds
    gcTime: 300000, // 5 minutes
    refetchOnWindowFocus: false,
  });

  // Setup realtime subscription for this conversation's messages
  useEffect(() => {
    if (!conversationId) return;

    const channel = supabase
      .channel(`messages-${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newMessage = transformMessage(payload.new);
            queryClient.setQueryData<Message[]>(['messages', conversationId], (old) => {
              if (!old) return [newMessage];
              if (old.some(m => m.id === newMessage.id)) return old;
              return [...old, newMessage];
            });
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as any;
            queryClient.setQueryData<Message[]>(['messages', conversationId], (old) => {
              if (!old) return [];
              return old.map(m => {
                if (m.id !== updated.id) return m;
                return transformMessage(updated, m.recipientPhone);
              });
            });
          } else if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as any)?.id;
            if (!deletedId) return;
            queryClient.setQueryData<Message[]>(['messages', conversationId], (old) => {
              if (!old) return [];
              return old.filter(m => m.id !== deletedId);
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, queryClient]);

  // Load more messages (pagination)
  const loadMoreMessages = useCallback(async (offset: number = 100) => {
    if (!conversationId) return;
    
    const { data, error } = await supabase
      .from('messages')
      .select('*, conversations(recipient_phone)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .range(offset, offset + 99);

    if (error) {
      console.error('Error loading more messages:', error);
      return;
    }

    if (data && data.length > 0) {
      const newMessages = data.map(m => transformMessage(m));
      queryClient.setQueryData<Message[]>(['messages', conversationId], (old) => {
        if (!old) return newMessages;
        // Merge and deduplicate
        const existing = new Set(old.map(m => m.id));
        const unique = newMessages.filter(m => !existing.has(m.id));
        return [...old, ...unique].sort((a, b) => 
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
      });
    }
  }, [conversationId, queryClient]);

  return {
    messages: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
    loadMoreMessages,
  };
};
