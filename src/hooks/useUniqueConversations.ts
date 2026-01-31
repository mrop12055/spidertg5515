import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Parallel paged fetcher for conversation stats
const fetchUniqueConversations = async (): Promise<Map<string, { total: number; withReplies: number }>> => {
  const PAGE_SIZE = 1000;
  const MAX_RECORDS = 50000;
  const counts = new Map<string, { total: number; withReplies: number }>();

  // Get total count first
  const { count: totalCount, error: countError } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('first_message_sent', true);

  if (countError) {
    console.error('Error getting conversation count:', countError);
    return counts;
  }

  const effectiveCount = Math.min(totalCount || 0, MAX_RECORDS);
  if (effectiveCount === 0) return counts;

  const totalPages = Math.ceil(effectiveCount / PAGE_SIZE);

  // Fetch all pages in PARALLEL for speed
  const pagePromises = Array.from({ length: totalPages }, (_, page) => {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    return supabase
      .from('conversations')
      .select('account_id, has_reply')
      .eq('first_message_sent', true)
      .range(from, to);
  });

  const results = await Promise.all(pagePromises);

  // Process all results
  for (const { data, error } of results) {
    if (error) {
      console.error('Error fetching conversations page:', error);
      continue;
    }
    if (!data) continue;

    data.forEach((conv: any) => {
      const existing = counts.get(conv.account_id) || { total: 0, withReplies: 0 };
      existing.total += 1;
      if (conv.has_reply) existing.withReplies += 1;
      counts.set(conv.account_id, existing);
    });
  }

  console.log(`Fetched unique conversations for ${counts.size} accounts from ${effectiveCount} records`);
  return counts;
};

export const useUniqueConversations = () => {
  const query = useQuery({
    queryKey: ['unique-conversations'],
    queryFn: fetchUniqueConversations,
    staleTime: 60000, // Data stays fresh for 1 minute
    gcTime: 300000, // Cache persists for 5 minutes
    refetchOnWindowFocus: false,
  });

  return {
    uniqueConversations: query.data ?? new Map<string, { total: number; withReplies: number }>(),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
};
