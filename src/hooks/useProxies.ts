import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Proxy } from '@/types/telegram';
import { useEffect } from 'react';

// Transform DB row to Proxy type
const transformProxy = (p: any): Proxy => ({
  id: p.id,
  host: p.host,
  port: p.port,
  username: p.username || undefined,
  password: p.password || undefined,
  type: p.proxy_type,
  status: p.status,
  assignedAccountId: p.assigned_account_id || undefined,
  lastChecked: p.last_checked ? new Date(p.last_checked) : undefined,
  responseTime: p.response_time || undefined,
  country: p.detected_country || p.country || undefined,
});

// Parallel paged fetcher for large datasets
const fetchProxiesPaged = async (): Promise<Proxy[]> => {
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 100; // Max 100K proxies
  
  const selectColumns = 'id, host, port, username, password, proxy_type, status, assigned_account_id, last_checked, response_time, detected_country, country';

  // Fetch first page
  const { data: firstPage, error: firstError } = await supabase
    .from('proxies')
    .select(selectColumns)
    .order('created_at', { ascending: false })
    .range(0, PAGE_SIZE - 1);

  if (firstError) throw firstError;
  if (!firstPage || firstPage.length === 0) return [];
  if (firstPage.length < PAGE_SIZE) return firstPage.map(transformProxy);

  // Need more pages - fetch remaining in parallel
  const pagePromises: Promise<{ data: any[] | null; error: any }>[] = [];
  for (let page = 1; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const promise = (async () => {
      return await supabase
        .from('proxies')
        .select(selectColumns)
        .order('created_at', { ascending: false })
        .range(from, to);
    })();
    pagePromises.push(promise);
  }

  const results = await Promise.all(pagePromises);
  const all = [...firstPage];

  for (const result of results) {
    if (result.data && result.data.length > 0) {
      all.push(...result.data);
    }
    if (!result.data || result.data.length < PAGE_SIZE) break;
  }

  return all.map(transformProxy);
};

export const useProxies = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['proxies'],
    queryFn: fetchProxiesPaged,
    staleTime: 30000, // Data stays fresh for 30 seconds
    gcTime: 300000, // Cache persists for 5 minutes
    refetchOnWindowFocus: false,
  });

  // Setup realtime subscription for optimistic updates
  useEffect(() => {
    const channel = supabase
      .channel('proxies-cache-sync')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'proxies' },
        (payload) => {
          const newProxy = transformProxy(payload.new);
          queryClient.setQueryData<Proxy[]>(['proxies'], (old) => {
            if (!old) return [newProxy];
            if (old.some(p => p.id === newProxy.id)) return old;
            return [newProxy, ...old];
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'proxies' },
        (payload) => {
          const updated = transformProxy(payload.new);
          queryClient.setQueryData<Proxy[]>(['proxies'], (old) => {
            if (!old) return [updated];
            return old.map(p => p.id === updated.id ? updated : p);
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'proxies' },
        (payload) => {
          const deletedId = (payload.old as any)?.id;
          if (!deletedId) return;
          queryClient.setQueryData<Proxy[]>(['proxies'], (old) => {
            if (!old) return [];
            return old.filter(p => p.id !== deletedId);
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    proxies: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
    isStale: query.isStale,
  };
};
