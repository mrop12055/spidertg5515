import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Campaign } from '@/types/telegram';
import { useEffect } from 'react';

// Transform DB row to Campaign type
const transformCampaign = (c: any): Campaign => ({
  id: c.id,
  name: c.name,
  messageTemplate: c.message_template,
  status: c.status,
  scheduledAt: c.scheduled_at ? new Date(c.scheduled_at) : undefined,
  recipientCount: c.recipient_count || 0,
  sentCount: c.sent_count || 0,
  failedCount: c.failed_count || 0,
  replyCount: c.reply_count || 0,
  accountIds: c.campaign_accounts?.map((ca: any) => ca.account_id) || [],
  createdAt: new Date(c.created_at),
  updatedAt: new Date(c.updated_at),
  seatId: c.seat_id || undefined,
});

const fetchCampaigns = async (): Promise<Campaign[]> => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, campaign_accounts(account_id)')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(transformCampaign);
};

export const useCampaigns = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['campaigns'],
    queryFn: fetchCampaigns,
    staleTime: 30000, // Data stays fresh for 30 seconds
    gcTime: 300000, // Cache persists for 5 minutes
    refetchOnWindowFocus: false,
  });

  // Setup realtime subscription for optimistic updates
  useEffect(() => {
    const channel = supabase
      .channel('campaigns-cache-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaigns' },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            // For inserts, we need to fetch with campaign_accounts join
            const { data } = await supabase
              .from('campaigns')
              .select('*, campaign_accounts(account_id)')
              .eq('id', (payload.new as any).id)
              .single();
            
            if (data) {
              const newCampaign = transformCampaign(data);
              queryClient.setQueryData<Campaign[]>(['campaigns'], (old) => {
                if (!old) return [newCampaign];
                if (old.some(c => c.id === newCampaign.id)) return old;
                return [newCampaign, ...old];
              });
            }
          } else if (payload.eventType === 'UPDATE') {
            // For updates, merge with existing data
            const updated = payload.new as any;
            queryClient.setQueryData<Campaign[]>(['campaigns'], (old) => {
              if (!old) return [];
              return old.map(c => {
                if (c.id !== updated.id) return c;
                return {
                  ...c,
                  name: updated.name,
                  messageTemplate: updated.message_template,
                  status: updated.status,
                  scheduledAt: updated.scheduled_at ? new Date(updated.scheduled_at) : undefined,
                  recipientCount: updated.recipient_count || 0,
                  sentCount: updated.sent_count || 0,
                  failedCount: updated.failed_count || 0,
                  replyCount: updated.reply_count || 0,
                  updatedAt: new Date(updated.updated_at),
                };
              });
            });
          } else if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as any)?.id;
            if (!deletedId) return;
            queryClient.setQueryData<Campaign[]>(['campaigns'], (old) => {
              if (!old) return [];
              return old.filter(c => c.id !== deletedId);
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    campaigns: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
    isStale: query.isStale,
  };
};
