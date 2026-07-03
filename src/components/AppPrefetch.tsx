import React from 'react';
import { useAccounts } from '@/hooks/useAccounts';
import { useProxies } from '@/hooks/useProxies';
import { useCampaigns } from '@/hooks/useCampaigns';
import { useConversations } from '@/hooks/useConversations';
import { useDashboardStats } from '@/hooks/useDashboardStats';
import { useUniqueConversations } from '@/hooks/useUniqueConversations';
import { useProxyErrors } from '@/hooks/useProxyErrors';

/**
 * Mounted once at app root after login. It calls every primary data hook
 * so their queries + realtime subscriptions warm up ONCE on startup.
 * Individual pages then read the already-cached data instantly.
 *
 * Because the global QueryClient uses `staleTime: Infinity` and
 * `refetchOnMount: false`, mounting the same hook again inside a page
 * will NOT trigger another fetch — pages just read the cache.
 */
const AppPrefetch: React.FC = () => {
  useAccounts();
  useProxies();
  useCampaigns();
  useConversations();
  useDashboardStats();
  useUniqueConversations();
  useProxyErrors();
  return null;
};

export default AppPrefetch;
