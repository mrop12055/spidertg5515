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
    { count: messagesLifetime },
    { count: repliesLifetime },
  ] = await Promise.all([
    supabase.from('telegram_accounts').select('id', { count: 'exact', head: true }).not('device_model', 'is', null),
    supabase.from('telegram_accounts').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('proxies').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('messages').select('id', { count: 'exact', head: true })
      .eq('direction', 'outgoing')
      .gte('created_at', today.toISOString()),
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'outgoing'),
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'incoming'),
  ]);

  return {
    totalAccounts: totalAccounts || 0,
    activeAccounts: activeAccounts || 0,
    activeProxies: activeProxies || 0,
    messagesToday: messagesToday || 0,
    messagesLifetime: messagesLifetime || 0,
    repliesLifetime: repliesLifetime || 0,
  };
};

export const useDashboardStats = () => {
  const query = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: fetchDashboardStats,
    staleTime: 30000, // Stats stay fresh for 30 seconds
    gcTime: 300000, // Cache for 5 minutes
    refetchInterval: 30000, // Auto-refresh every 30 seconds
    refetchOnWindowFocus: false,
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
