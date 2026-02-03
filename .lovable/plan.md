
# Performance Optimization Plan for Accounts Page

## Summary
Optimize the Accounts page to handle 500+ accounts smoothly by implementing list virtualization, parallel data fetching, and memoized filtering - without removing any existing features.

---

## Changes Overview

### 1. Add List Virtualization with react-window
**File:** `src/pages/Accounts.tsx`

Install `react-window` (already lightweight) and wrap the account list in a virtualized container that only renders visible items.

**What changes:**
- Import `FixedSizeList` from react-window
- Replace `{accountsByStatus[status].map(renderAccountCard)}` with a virtualized list
- Only 10-15 account cards render at once instead of 500+
- Maintain all existing card functionality

### 2. Convert useAccounts to Parallel Fetching
**File:** `src/hooks/useAccounts.ts`

Change from sequential loop to parallel pagination (matching the pattern already used in useConversations).

**Current (slow):**
```text
Page 1 → wait → Page 2 → wait → Page 3 → ...
```

**New (fast):**
```text
Count query → calculate pages → fetch all pages simultaneously
```

### 3. Create Proxy Lookup Map
**File:** `src/pages/Accounts.tsx`

Add a memoized Map for O(1) proxy lookups instead of repeated .find() calls.

**What changes:**
- Add `const proxyMap = useMemo(() => new Map(proxies.map(p => [p.id, p])), [proxies]);`
- Update `getProxyLabel`, `getProxyStatus`, `getProxyCountry` to use the Map

### 4. Memoize Filtered Results
**File:** `src/pages/Accounts.tsx`

Wrap the heavy filtering logic in `useMemo` to prevent recalculation on unrelated state changes.

**What changes:**
- Wrap `filteredAccounts` in useMemo with proper dependencies
- Wrap `accountsByStatus` categorization in useMemo
- Wrap `stats` calculation in useMemo

### 5. Debounce Search Input
**File:** `src/pages/Accounts.tsx`

Add a debounced search state to prevent filtering on every keystroke.

**What changes:**
- Add `debouncedSearchQuery` state with 300ms delay
- Use debounced value in filter logic
- Immediate visual feedback in input, delayed filtering

---

## Technical Implementation Details

### Virtualization Setup
```text
┌─────────────────────────────────────┐
│  Viewport (visible area)            │
│  ┌─────────────────────────────────┐│
│  │ Account Card 1 (rendered)       ││
│  │ Account Card 2 (rendered)       ││
│  │ Account Card 3 (rendered)       ││
│  │ ...10-15 visible cards...       ││
│  └─────────────────────────────────┘│
│                                     │
│  ... 485 cards NOT in DOM ...       │
│                                     │
└─────────────────────────────────────┘
```

### Parallel Fetch Flow
```text
1. Query total count (head: true, count: exact)
2. Calculate required pages: ceil(count / 1000)
3. Launch all page queries via Promise.all()
4. Merge results in order
```

### Lookup Map Performance
```text
Before: getProxyLabel called 500 times × .find() on 500 proxies = 250,000 operations
After:  getProxyLabel called 500 times × Map.get() = 500 operations
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Accounts.tsx` | Add virtualization, proxy Map, memoization, debounced search |
| `src/hooks/useAccounts.ts` | Convert to parallel pagination pattern |
| `package.json` | Add react-window dependency |

---

## Expected Performance Improvements

| Metric | Before | After |
|--------|--------|-------|
| Initial render time | 800-1500ms | 150-300ms |
| DOM nodes | 5000+ | ~200 |
| Scroll performance | Laggy/janky | Smooth 60fps |
| Account fetch time | 2-4s (sequential) | 500ms-1s (parallel) |
| Filter recalculation | Every render | Only when dependencies change |

---

## Notes
- All existing features preserved: filters, bulk actions, dialogs, tooltips
- Virtualized list maintains selection state and click handlers
- Compatible with existing realtime subscriptions
- No changes to database or backend required
