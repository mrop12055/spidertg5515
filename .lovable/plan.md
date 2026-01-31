
# Speed Up Accounts Page Loading

## Problem
When entering the Accounts tab, lifetime messages, proxy info, and profile pictures take 2-3 seconds to appear. This is caused by:

1. **Intentional delays** - Unique conversations fetch has a 500ms delay, proxy errors have a 1000ms delay
2. **No persistent cache** - Stats are stored in component state, causing re-fetches on every page visit
3. **Sequential pagination** - Conversations are fetched page-by-page instead of in parallel

## Solution
Move secondary data (unique conversations, proxy errors) into React Query hooks with proper caching, remove artificial delays, and add parallel fetching.

---

## Changes

### 1. Create `useUniqueConversations` Hook
Create a new cached hook similar to `useAccounts` that persists data across navigations.

**New file: `src/hooks/useUniqueConversations.ts`**
- Fetches conversation stats with parallel pagination (not sequential)
- Uses React Query with `staleTime: 60000` (1 minute cache)
- Returns a Map of account_id to conversation counts
- Eliminates the 500ms delay

### 2. Create `useProxyErrors` Hook  
Create a cached hook for proxy error data.

**New file: `src/hooks/useProxyErrors.ts`**
- Fetches proxy errors once and caches
- Uses React Query with `staleTime: 60000` (1 minute cache)
- Eliminates the 1000ms delay

### 3. Update Accounts Page
**File: `src/pages/Accounts.tsx`**
- Replace inline `fetchUniqueConversations` effect with `useUniqueConversations()` hook
- Replace inline `fetchProxyErrors` effect with `useProxyErrors()` hook
- Remove local state for these: `uniqueConversations`, `proxyErrors`
- Remove the ref-based fetching logic

---

## Technical Details

### Before (Current Flow)
```
Page loads → accounts (cached) → 500ms wait → fetch conversations (sequential) → 1000ms wait → fetch proxy errors
Total: ~2-3 seconds for full data
```

### After (Optimized Flow)
```
Page loads → accounts (cached) + conversations (cached) + proxy errors (cached) → All instant if within cache window
First load: parallel fetches with no artificial delays
```

### Caching Strategy
| Data | Cache Duration | Realtime Updates |
|------|----------------|------------------|
| Accounts | 30 seconds | Yes (already implemented) |
| Proxies | 30 seconds | Yes (already implemented) |
| Unique Conversations | 60 seconds | No (low update frequency) |
| Proxy Errors | 60 seconds | No (low update frequency) |

### Parallel Pagination
The new `useUniqueConversations` hook will fetch all pages in parallel using `Promise.all()`, reducing fetch time from ~2s to ~500ms for 3000+ records.

---

## Files to Create/Modify
1. **Create** `src/hooks/useUniqueConversations.ts` - New cached hook for conversation stats
2. **Create** `src/hooks/useProxyErrors.ts` - New cached hook for proxy errors  
3. **Modify** `src/pages/Accounts.tsx` - Use new hooks, remove inline fetching logic

## Expected Result
- Stats appear instantly on subsequent visits (within cache window)
- First load is ~1-2 seconds faster (no artificial delays)
- Parallel fetching reduces initial load time further
