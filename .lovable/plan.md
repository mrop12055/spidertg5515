
# Performance Overload Investigation and Fix Plan

## Problem Summary
The admin dashboard is crashing under heavy load, showing all stats as 0 and database functions timing out. The SQL query I just ran returned a "Connection terminated due to connection timeout" error, confirming the database connection pool is exhausted.

## Root Causes Identified

### 1. Excessive Parallel Database Requests on App Load
When the app loads, multiple components fire simultaneous database queries:

| Component/Hook | Queries | Frequency |
|---------------|---------|-----------|
| `TelegramContext` | 3 queries (campaigns, conversations, messages) + conversations pagination (up to 10 pages) | On mount + realtime |
| `useDashboardStats` | 6 parallel queries | Every 30s + on mount |
| `useAccounts` | Sequential paginated queries | On mount + realtime |
| `useProxies` | Up to 99 parallel queries | On mount + realtime |
| `useUniqueConversations` | Up to 50 parallel queries | On mount |
| `TaskQueueCard` | 8 parallel queries | Every 3s debounce + realtime |
| `RecentErrorsCard` | 8 parallel queries | Every 5s debounce + realtime |
| `useRunnerStatus` | 1 query | Every 15s + realtime |

**Total on page load: 50-150+ simultaneous queries**

### 2. Duplicate Data Fetching
- `TelegramContext` fetches conversations (up to 10K) globally
- `useConversations` hook also fetches the same data
- Both pages `Conversations.tsx` and `SeatChat.tsx` have their own fetch logic
- Campaigns are fetched in both `TelegramContext` and `useCampaigns` hook

### 3. Aggressive Realtime Subscriptions
Multiple components subscribe to the same tables with overlapping listeners:

```text
messages table: TelegramContext, TaskQueueCard, RecentErrorsCard, Conversations page
conversations table: TelegramContext, useConversations, TaskQueueCard, SeatChat page
campaigns table: TelegramContext, useCampaigns hook
telegram_accounts table: TelegramContext, useAccounts hook
```

Each subscription triggers re-fetches and can cascade into many more queries.

### 4. Unbounded Parallel Pagination
`useProxies` launches up to 99 parallel queries immediately:
```typescript
for (let page = 1; page < MAX_PAGES; page++) { // MAX_PAGES = 100
  pagePromises.push(...);
}
await Promise.all(pagePromises); // 99 parallel requests!
```

### 5. Edge Function Overhead
The `runner-tasks` edge function runs expensive operations on every `/get` request:
- Queries all running campaigns
- For each campaign, runs a separate count query
- Recovers stale messages (update + select)
- Recovers stale recipients (update + select)
- Loads all accounts with proxy joins

---

## Solution: Multi-Layer Performance Optimization

### Phase 1: Reduce Initial Load Queries (Critical)

**1.1 Add Query Concurrency Limiter**
Create a shared utility to limit concurrent Supabase queries:
```typescript
// src/lib/query-limiter.ts
const MAX_CONCURRENT = 5;
```

**1.2 Fix useProxies Unbounded Parallelism**
Change from parallel to sequential with early exit:
- Remove Promise.all for 99 queries
- Stop when page returns less than PAGE_SIZE

**1.3 Fix useUniqueConversations**
- Add concurrency limit (max 5 parallel pages)
- Consider moving this to a database view or function

**1.4 Consolidate TelegramContext**
- Remove duplicate conversation fetching (already handled by useConversations)
- Remove duplicate campaign fetching (already handled by useCampaigns)
- Only keep what's truly needed globally (messages for notifications)

### Phase 2: Deduplicate Realtime Subscriptions

**2.1 Create Centralized Subscription Manager**
- Single subscription per table at the app level
- Components subscribe to events via context/callbacks
- Prevents N+1 subscriptions to same table

**2.2 Remove Duplicate Subscriptions**
- TaskQueueCard: Remove polling fallback since realtime is primary
- RecentErrorsCard: Increase debounce from 5s to 10s
- Consolidate account/campaign realtime to single source

### Phase 3: Add Circuit Breaker Pattern

**3.1 Detect Overload Condition**
```typescript
// Track failed requests
let consecutiveFailures = 0;
const CIRCUIT_BREAKER_THRESHOLD = 3;

if (error.message.includes('timeout')) {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    // Pause all non-critical requests for 30s
  }
}
```

**3.2 Graceful Degradation**
- Show cached data when database is unreachable
- Display "Connection issues - showing cached data" banner
- Disable non-critical features (errors card, task queue) until recovery

### Phase 4: Edge Function Optimization

**4.1 Batch Campaign Completion Check**
Instead of N queries for N campaigns:
```sql
-- Single query to find completable campaigns
SELECT c.id FROM campaigns c
WHERE c.status = 'running'
AND NOT EXISTS (
  SELECT 1 FROM campaign_recipients cr
  WHERE cr.campaign_id = c.id
  AND cr.status IN ('pending', 'sending', 'queued')
);
```

**4.2 Add Request Coalescing**
- Cache account list for 10 seconds
- Cache settings for 30 seconds (already done)
- Skip expensive operations if last run was <10s ago

### Phase 5: Dashboard-Specific Optimizations

**5.1 Lazy Load Non-Critical Cards**
- TaskQueueCard: Load only when visible (Intersection Observer)
- RecentErrorsCard: Same lazy loading
- Reduce initial queries from 50+ to ~10

**5.2 Add Loading States with Stale Data**
- Show previous cached data immediately
- Update in background
- Prevents "0" flash during load

---

## Technical Implementation Details

### Files to Modify

| File | Changes |
|------|---------|
| `src/lib/query-limiter.ts` | NEW - Concurrency limiter utility |
| `src/hooks/useProxies.ts` | Sequential pagination with limit |
| `src/hooks/useUniqueConversations.ts` | Add concurrency limit |
| `src/context/TelegramContext.tsx` | Remove duplicate fetches, slim down |
| `src/components/dashboard/TaskQueueCard.tsx` | Lazy load + reduce query frequency |
| `src/components/dashboard/RecentErrorsCard.tsx` | Lazy load + reduce query frequency |
| `src/pages/Dashboard.tsx` | Add error boundary + graceful degradation |
| `supabase/functions/runner-tasks/index.ts` | Batch operations, add caching |

### Priority Order
1. **Immediate**: Fix useProxies parallelism (biggest offender)
2. **Immediate**: Add circuit breaker to prevent cascade failures
3. **High**: Consolidate TelegramContext
4. **High**: Optimize runner-tasks edge function
5. **Medium**: Lazy load dashboard cards
6. **Medium**: Centralize realtime subscriptions

---

## Expected Outcomes

- Initial page load: 50-150 queries reduced to 10-15 queries
- Database connection usage: 80% reduction
- Recovery time from overload: 30 seconds (circuit breaker)
- User experience: Cached data shown during issues instead of "0"
