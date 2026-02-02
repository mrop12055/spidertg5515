import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

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
    // Fetch lifetime unique recipients messaged from persistent stats
    supabase.from('lifetime_stats').select('stat_value').eq('stat_key', 'lifetime_unique_recipients_messaged').single(),
    // Fetch lifetime unique recipients replied from persistent stats
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
  const query = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: fetchDashboardStats,
    staleTime: 60000, // Stats stay fresh for 60 seconds (was 30s)
    gcTime: 300000, // Cache for 5 minutes
    refetchInterval: 60000, // Auto-refresh every 60 seconds (was 30s)
    refetchOnWindowFocus: false,
    retry: 2, // Retry failed requests up to 2 times
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });

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
