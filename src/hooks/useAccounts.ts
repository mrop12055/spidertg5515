import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { TelegramAccount } from '@/types/telegram';
import { useEffect } from 'react';

// Transform DB row to TelegramAccount type
const transformAccount = (acc: any): TelegramAccount => ({
  id: acc.id,
  phoneNumber: acc.phone_number,
  username: acc.username || undefined,
  firstName: acc.first_name || undefined,
  lastName: acc.last_name || undefined,
  status: acc.status,
  proxyId: acc.proxy_id || undefined,
  sessionFile: undefined,
  createdAt: new Date(acc.created_at),
  lastActive: acc.last_active ? new Date(acc.last_active) : undefined,
  messagesSentToday: acc.messages_sent_today || 0,
  dailyLimit: acc.daily_limit || 25,
  maturityScore: acc.maturity_score || 0,
  maturityDays: acc.maturity_days || 0,
  restrictedUntil: acc.restricted_until ? new Date(acc.restricted_until) : undefined,
  banReason: acc.ban_reason || undefined,
  avatar: acc.avatar_url || undefined,
  deviceModel: acc.device_model || undefined,
  systemVersion: acc.system_version || undefined,
  appVersion: acc.app_version || undefined,
  langCode: acc.lang_code || undefined,
  systemLangCode: acc.system_lang_code || undefined,
  warmupPhase: acc.warmup_phase ?? 0,
  warmupStartedAt: acc.warmup_started_at ? new Date(acc.warmup_started_at) : undefined,
  spambotStatus: acc.spambot_status || 'unknown',
  phoneCountry: acc.phone_country || undefined,
  geoMismatch: acc.geo_mismatch || false,
  telegramId: acc.telegram_id || undefined,
  tags: acc.tags || [],
  successCount: acc.success_count ?? 0,
  failureCount: acc.failure_count ?? 0,
  successRate: acc.success_rate ?? 100,
  autoDisabled: acc.auto_disabled ?? false,
  disabledReason: acc.disabled_reason || undefined,
});

// Parallel paginated fetcher for large datasets
const fetchAccountsPaged = async (): Promise<TelegramAccount[]> => {
  const PAGE_SIZE = 1000;
  const MAX_RECORDS = 50000;
  
  const selectColumns = 'id, phone_number, username, first_name, last_name, status, proxy_id, created_at, last_active, messages_sent_today, daily_limit, maturity_score, maturity_days, restricted_until, ban_reason, avatar_url, device_model, system_version, app_version, lang_code, system_lang_code, warmup_phase, warmup_started_at, spambot_status, phone_country, geo_mismatch, telegram_id, last_spambot_check, tags, success_count, failure_count, success_rate, auto_disabled, disabled_reason';

  // Step 1: Get total count first
  const { count, error: countError } = await supabase
    .from('telegram_accounts')
    .select('id', { count: 'exact', head: true });

  if (countError) throw countError;
  
  const totalRecords = Math.min(count || 0, MAX_RECORDS);
  if (totalRecords === 0) return [];

  // Step 2: Calculate pages needed
  const totalPages = Math.ceil(totalRecords / PAGE_SIZE);

  // Step 3: Fetch all pages in parallel
  const pagePromises = Array.from({ length: totalPages }, (_, page) => {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    
    return supabase
      .from('telegram_accounts')
      .select(selectColumns)
      .order('created_at', { ascending: false })
      .range(from, to);
  });

  const results = await Promise.all(pagePromises);

  // Step 4: Merge results in order
  const all: any[] = [];
  for (const result of results) {
    if (result.error) throw result.error;
    if (result.data) all.push(...result.data);
  }

  return all.map(transformAccount);
};

export const useAccounts = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccountsPaged,
    staleTime: 30000, // Data stays fresh for 30 seconds
    gcTime: 300000, // Cache persists for 5 minutes (formerly cacheTime)
    refetchOnWindowFocus: false, // Don't refetch on tab focus
  });

  // Setup realtime subscription for optimistic updates
  useEffect(() => {
    const channel = supabase
      .channel('accounts-cache-sync')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telegram_accounts' },
        (payload) => {
          const newAccount = transformAccount(payload.new);
          queryClient.setQueryData<TelegramAccount[]>(['accounts'], (old) => {
            if (!old) return [newAccount];
            // Avoid duplicates
            if (old.some(a => a.id === newAccount.id)) return old;
            return [newAccount, ...old];
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'telegram_accounts' },
        (payload) => {
          const updated = transformAccount(payload.new);
          queryClient.setQueryData<TelegramAccount[]>(['accounts'], (old) => {
            if (!old) return [updated];
            return old.map(acc => acc.id === updated.id ? updated : acc);
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'telegram_accounts' },
        (payload) => {
          const deletedId = (payload.old as any)?.id;
          if (!deletedId) return;
          queryClient.setQueryData<TelegramAccount[]>(['accounts'], (old) => {
            if (!old) return [];
            return old.filter(acc => acc.id !== deletedId);
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    accounts: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching, // Background refresh indicator
    refetch: query.refetch,
    isStale: query.isStale,
  };
};
