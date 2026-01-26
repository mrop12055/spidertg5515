
# Fix Slow Loading Across All Pages - Deep Performance Optimization

## Executive Summary

After analyzing the codebase, I identified **7 root causes** of slow loading across all pages. This plan fixes them through caching, lazy loading, parallel fetching, and optimizing the data architecture.

---

## Root Causes Identified

| # | Issue | Impact | Pages Affected |
|---|-------|--------|----------------|
| 1 | **TelegramContext loads ALL data on mount** | Every route triggers massive parallel data fetch | All pages |
| 2 | **Duplicate data fetching** | Same data fetched by both TelegramContext AND individual page hooks | Dashboard, Accounts, Proxies |
| 3 | **No lazy loading** | All components load immediately even if not visible | All pages |
| 4 | **Large table fetches without pagination** | Messages, conversations fetch 10K+ rows | Conversations, Dashboard |
| 5 | **Multiple realtime subscriptions per page** | Each page creates 3-5 realtime channels | All pages |
| 6 | **Repeated count queries** | Stats recalculated on every render | Dashboard, Accounts, Seats |
| 7 | **Synchronous serial data fetching** | Some pages fetch data sequentially instead of parallel | Logs, Material, Warmup |

---

## Solution Architecture

```text
                     ┌─────────────────────────────────────────┐
                     │           React Query Cache             │
                     │  (30s stale, 5min cache, background)    │
                     └─────────────────────────────────────────┘
                                        │
        ┌───────────────┬───────────────┼───────────────┬───────────────┐
        │               │               │               │               │
   useAccounts     useProxies    useCampaigns    useConversations  useDashboardStats
   (cached)        (cached)      (cached)        (NEW - cached)    (cached - counts)
        │               │               │               │               │
        └───────────────┴───────────────┴───────────────┴───────────────┘
                                        │
                                TelegramContext
                         (SIMPLIFIED - only actions + realtime)
```

---

## Implementation Plan

### Phase 1: Create Missing Cached Hooks (HIGH IMPACT)

**1.1 Create `useConversations` hook**
- New file: `src/hooks/useConversations.ts`
- Move conversation fetching from TelegramContext to dedicated hook
- Use React Query with 30s staleTime
- Fetch only conversations with `first_message_sent=true` (reduces data by ~70%)
- Include optimistic realtime updates

**1.2 Create `useMessages` hook for on-demand message loading**
- New file: `src/hooks/useMessages.ts`
- Fetch messages ONLY when a conversation is selected (not on app load)
- Limit to 100 messages per conversation initially with pagination

**1.3 Create `useCampaigns` hook** (IF NOT EXISTS)
- Verify and update `src/hooks/useCampaigns.ts`
- Ensure it uses React Query caching pattern like useAccounts

---

### Phase 2: Simplify TelegramContext (HIGH IMPACT)

**2.1 Remove redundant data fetching from TelegramContext**

Current `refreshData()` fetches ALL:
- accounts (100K rows)
- proxies (100K rows)  
- campaigns
- conversations (100K rows)
- messages (10K rows limited)

**Change to:**
- Remove accounts/proxies/campaigns fetching (use hooks instead)
- Keep only: actions (sendMessage, createCampaign, etc.)
- Keep realtime subscription setup only

**2.2 Update pages to use cached hooks**

| Page | Current | New |
|------|---------|-----|
| Accounts | useAccounts + useTelegram | useAccounts only |
| Proxies | useTelegram.proxies | useProxies only |
| Conversations | useTelegram.conversations | useConversations |
| Campaigns | useTelegram.campaigns | useCampaigns |
| Dashboard | useDashboardStats + useCampaigns | No change (already optimized) |

---

### Phase 3: Optimize Dashboard Components

**3.1 TaskQueueCard optimization**
- Current: Fetches 8 parallel queries + full table data
- Fix: Use count-only queries for badges (head: true)
- Fix: Reduce LIMIT from 100 to 50 for lists
- Fix: Debounce realtime refresh to 3 seconds (currently 2s)

**3.2 RecentErrorsCard optimization**
- Current: Fetches 7 tables with 100 rows each on every change
- Fix: Limit to 50 per table
- Fix: Add 5 second debounce for realtime updates
- Fix: Cache errors for 30 seconds

**3.3 RunnerStatus optimization**
- Verify it uses count-only queries
- Increase polling interval from 3s to 10s

---

### Phase 4: Fix Individual Page Issues

**4.1 Accounts page**
- Already uses useAccounts (optimized)
- Remove redundant `refreshData()` calls
- Reduce proxy error fetch frequency

**4.2 Proxies page**
- Uses useTelegram.proxies which triggers full data load
- Change to use useProxies hook directly

**4.3 Conversations page**
- Critical fix: Fetch messages on-demand per conversation
- Remove preloading of all messages
- Already has per-conversation realtime subscription (good)

**4.4 Campaigns page**
- Reduce polling frequency for running campaigns (1s to 3s)
- Use count-only queries for stats
- Lazy load detailed reports only when dialog opens

**4.5 Warmup page**
- Already has debounced realtime (2s)
- Increase debounce to 3s
- Reduce polling interval from 10s to 15s

**4.6 Seats page**
- Uses fetchSeats which runs 4 queries
- Add React Query caching
- Reduce auto-refresh from 30s to 60s

**4.7 Material page**
- Already limits to 10K items
- Add loading skeleton for better perceived performance

**4.8 Logs page**
- Fetches 8 tables on mount
- Add pagination (load first 100, then load more on scroll)
- Cache with React Query

**4.9 Settings page**
- Already light (uses useAppSettings)
- No changes needed

---

### Phase 5: Add Skeleton Loading States

Add skeleton loading for better perceived performance:

- Accounts page: Show skeleton cards while loading
- Proxies page: Show skeleton table rows
- Conversations: Show skeleton chat list
- Dashboard: Already has some, verify complete

---

## Technical Changes Summary

### Files to Create

| File | Purpose |
|------|---------|
| `src/hooks/useConversations.ts` | Cached conversations with React Query |
| `src/hooks/useMessages.ts` | On-demand message fetching per conversation |

### Files to Modify

| File | Changes |
|------|---------|
| `src/context/TelegramContext.tsx` | Remove bulk data fetching, keep actions only |
| `src/pages/Proxies.tsx` | Use useProxies instead of useTelegram |
| `src/pages/Conversations.tsx` | Use useConversations hook, on-demand messages |
| `src/pages/Campaigns.tsx` | Reduce polling to 3s, use count-only queries |
| `src/pages/Warmup.tsx` | Increase debounce to 3s, polling to 15s |
| `src/pages/Seats.tsx` | Add React Query caching, reduce refresh to 60s |
| `src/pages/Logs.tsx` | Add pagination, reduce initial fetch to 100 per table |
| `src/components/dashboard/TaskQueueCard.tsx` | Reduce limits, increase debounce to 3s |
| `src/components/dashboard/RecentErrorsCard.tsx` | Reduce limits, increase debounce to 5s |

---

## Expected Performance Improvements

| Metric | Current | After Optimization |
|--------|---------|-------------------|
| Initial page load | 3-5 seconds | Less than 1 second |
| Navigation between pages | 2-3 seconds (refetch) | Instant (cached) |
| Dashboard stats refresh | Every 2 seconds | Every 30 seconds |
| Memory usage | High (all data in memory) | Low (on-demand loading) |
| Network requests on mount | 10+ parallel | 2-3 count queries |
| Realtime subscription lag | 2 second debounce | 3-5 second debounce |

---

## Implementation Order

1. **Create cached hooks** (useConversations, useMessages) - Highest impact
2. **Simplify TelegramContext** - Removes duplicate fetching
3. **Update Proxies/Conversations pages** - Use new hooks
4. **Optimize dashboard components** - Reduce polling/debounce
5. **Fix individual pages** - Warmup, Seats, Logs, Campaigns
6. **Add skeleton states** - Better perceived performance

This approach ensures each change is independently testable and progressively improves performance.
