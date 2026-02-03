

# Performance Optimization Plan for SeatChat Page

## Summary
Optimize the SeatChat page to handle 5,000+ conversations smoothly by implementing list virtualization, memoized filtering, debounced search, and optimized data lookups - without removing any existing features.

---

## Current Performance Bottlenecks Identified

### 1. Conversation List Renders All Items (Lines 1404-1494)
**Problem:** The conversation list renders ALL filtered conversations into the DOM:
```javascript
{filteredConversations.map((conv) => (
  <div key={conv.id} className="...">
    // ~100+ DOM nodes per conversation card
  </div>
))}
```
With 3,000-5,000 conversations per seat, this creates 300,000-500,000 DOM nodes.

### 2. No Search Debouncing (Line 1372)
**Problem:** Search input triggers filtering on every keystroke:
```javascript
onChange={(e) => setSearchQuery(e.target.value)}
```
This causes expensive filter recalculations during typing.

### 3. Expensive Filter Recalculations
**Problem:** `filteredConversations` useMemo (lines 289-338) recalculates on every render dependency change, running multiple `.filter()` operations on 5,000+ items.

### 4. Sender Account Lookups Are Not Optimized
**Problem:** `senderAccounts` is already a Map (good!), but we can ensure `getAvatarColor` and helper functions are memoized with useCallback.

---

## Changes Overview

### 1. Add List Virtualization with react-window
**File:** `src/pages/SeatChat.tsx`

Install `react-window` (already installed from Accounts optimization) and virtualize the conversation list.

**What changes:**
- Import `List` from react-window (already in project)
- Replace the `.map()` loop with a virtualized `<List>` component
- Only 10-15 conversation cards render at once instead of 5,000+
- Maintain all existing card functionality (click, hover, dropdown menu)

**Implementation:**
```javascript
// Only virtualize when list is large (50+ conversations)
const VIRTUALIZATION_THRESHOLD = 50;
const CONVERSATION_ITEM_HEIGHT = 88; // Height of each conversation card

// Inside render:
{filteredConversations.length > VIRTUALIZATION_THRESHOLD ? (
  <List
    height={containerHeight}
    itemCount={filteredConversations.length}
    itemSize={CONVERSATION_ITEM_HEIGHT}
    width="100%"
  >
    {({ index, style }) => renderConversationItem(filteredConversations[index], style)}
  </List>
) : (
  // Regular map for small lists
  filteredConversations.map(renderConversationItem)
)}
```

### 2. Debounce Search Input
**File:** `src/pages/SeatChat.tsx`

Add a custom `useDebounce` hook with 300ms delay for search filtering.

**What changes:**
- Add `useDebounce` hook (same pattern as Accounts page)
- Add `debouncedSearchQuery` state
- Use debounced value in `filteredConversations` useMemo
- Immediate visual feedback in input, delayed filtering

**Implementation:**
```javascript
// Custom debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

// Usage
const debouncedSearchQuery = useDebounce(searchQuery, 300);
```

### 3. Memoize Helper Functions
**File:** `src/pages/SeatChat.tsx`

Wrap helper functions in `useCallback` to prevent recreation on every render.

**What changes:**
- Wrap `getAvatarColor` usage in useCallback
- Wrap `getDisplayName`, `getAvatarInitial`, `formatConversationTime` in useCallback
- Ensure `renderConversationItem` is memoized for virtualization

### 4. Optimize Tab Counts
**File:** `src/pages/SeatChat.tsx`

Memoize tab count calculations (lines 341-348) which currently run on every render.

**What changes:**
```javascript
// Current (runs every render):
const allCount = timeFilteredConversations.filter(c => !c.is_hidden).length;
const pinnedCount = timeFilteredConversations.filter(c => c.is_pinned).length;

// New (memoized):
const { allCount, pinnedCount, hiddenCount, repliesCount, unreadRepliesCount } = useMemo(() => ({
  allCount: timeFilteredConversations.filter(c => !c.is_hidden).length,
  pinnedCount: timeFilteredConversations.filter(c => c.is_pinned).length,
  hiddenCount: conversations.filter(c => c.is_hidden && (c.first_message_sent || c.has_reply)).length,
  repliesCount: timeFilteredConversations.filter(c => c.has_reply && !c.is_hidden).length,
  unreadRepliesCount: timeFilteredConversations.filter(c => c.has_reply && c.unread_count > 0 && !c.is_hidden).length,
}), [timeFilteredConversations, conversations]);
```

---

## Technical Implementation Details

### Virtualization Setup
```text
┌─────────────────────────────────────┐
│  Conversation Sidebar (364px)       │
│  ┌─────────────────────────────────┐│
│  │ Conversation 1 (rendered)       ││
│  │ Conversation 2 (rendered)       ││
│  │ Conversation 3 (rendered)       ││
│  │ ...10-15 visible cards...       ││
│  └─────────────────────────────────┘│
│                                     │
│  ... 4985 cards NOT in DOM ...      │
│                                     │
└─────────────────────────────────────┘
```

### Debounce Flow
```text
User types "john"
  → j (input updates, filter unchanged)
  → jo (input updates, filter unchanged)
  → joh (input updates, filter unchanged)
  → john (input updates, filter unchanged)
  → [300ms wait]
  → Filter runs with "john" (single calculation)
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/SeatChat.tsx` | Add virtualization, debounced search, memoized helpers, memoized tab counts |

---

## Expected Performance Improvements

| Metric | Before | After |
|--------|--------|-------|
| Initial render time | 1500-3000ms | 200-400ms |
| DOM nodes (conversation list) | 500,000+ | ~1,500 |
| Scroll performance | Laggy/janky | Smooth 60fps |
| Search typing lag | Noticeable | None |
| Filter recalculation | Every keystroke | Every 300ms max |

---

## Notes
- All existing features preserved: tabs, filters, pin/hide, dropdowns, realtime updates
- Virtualized list maintains selection state and click handlers
- Compatible with existing realtime subscriptions
- `react-window` already installed from Accounts optimization
- Scroll position preserved when switching tabs
- No changes to database or backend required

