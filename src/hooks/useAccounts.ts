import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localClient as supabase } from '@/lib/localClient';
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
  warmupPhase: 0,
  warmupStartedAt: undefined,

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

// Parallel paged fetcher for large datasets
const fetchAccountsPaged = async (): Promise<TelegramAccount[]> => {
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 100; // Max 100K accounts
  
  const selectColumns = 'id, phone_number, username, first_name, last_name, status, proxy_id, created_at, last_active, messages_sent_today, daily_limit, maturity_score, maturity_days, restricted_until, ban_reason, avatar_url, device_model, system_version, app_version, lang_code, system_lang_code, spambot_status, phone_country, geo_mismatch, telegram_id, last_spambot_check, tags, success_count, failure_count, success_rate, auto_disabled, disabled_reason';

  // NOTE: Avoid firing MAX_PAGES requests in parallel.
  // The previous implementation launched up to 99 extra queries even when
  // the table had only a few thousand rows, which makes the Accounts page
  // feel extremely slow.
  const all: any[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabase
      .from('telegram_accounts')
      .select(selectColumns)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  return all.map(transformAccount);
};

export const useAccounts = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccountsPaged,
    staleTime: 300000, // 5 min — realtime handles updates
    gcTime: 600000,
    refetchOnWindowFocus: false,
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
