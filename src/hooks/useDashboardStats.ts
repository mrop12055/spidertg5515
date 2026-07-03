import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useEffect } from 'react';

interface DashboardStats {
  totalAccounts: number;
  activeAccounts: number;
  activeProxies: number;
  messagesToday: number;
  messagesLifetime: number;
  repliesLifetime: number;
}

const fetchDashboardStats = async (): Promise<DashboardStats> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    { count: totalAccounts },
    { count: activeAccounts },
    { count: activeProxies },
    { count: messagesToday },
    lifetimeMessagesResult,
    lifetimeRepliesResult,
  ] = await Promise.all([
    supabase.from('telegram_accounts').select('id', { count: 'exact', head: true }).not('device_model', 'is', null),
    supabase.from('telegram_accounts').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('proxies').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('messages').select('id', { count: 'exact', head: true })
      .eq('direction', 'outgoing')
      .gte('created_at', today.toISOString()),
    supabase.from('lifetime_stats').select('stat_value').eq('stat_key', 'lifetime_unique_recipients_messaged').single(),
    supabase.from('lifetime_stats').select('stat_value').eq('stat_key', 'lifetime_unique_recipients_replied').single(),
  ]);

  return {
    totalAccounts: totalAccounts || 0,
    activeAccounts: activeAccounts || 0,
    activeProxies: activeProxies || 0,
    messagesToday: messagesToday || 0,
    messagesLifetime: lifetimeMessagesResult.data?.stat_value || 0,
    repliesLifetime: lifetimeRepliesResult.data?.stat_value || 0,
  };
};

export const useDashboardStats = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: fetchDashboardStats,
    staleTime: 300000, // 5 min — realtime handles updates
    gcTime: 600000,
    refetchOnWindowFocus: false,
    refetchOnMount: true, // will use cache if fresh
    placeholderData: {
      totalAccounts: 0,
      activeAccounts: 0,
      activeProxies: 0,
      messagesToday: 0,
      messagesLifetime: 0,
      repliesLifetime: 0,
    },
  });

  // Realtime subscriptions instead of polling
  useEffect(() => {
    let debounceTimer: NodeJS.Timeout | null = null;
    const debouncedRefetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      }, 5000);
    };

    const channel = supabase
      .channel('dashboard-stats-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_accounts' }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'proxies' }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lifetime_stats' }, debouncedRefetch)
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    stats: query.data ?? {
      totalAccounts: 0,
      activeAccounts: 0,
      activeProxies: 0,
      messagesToday: 0,
      messagesLifetime: 0,
      repliesLifetime: 0,
    },
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
};
