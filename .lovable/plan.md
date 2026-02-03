
# Increase All Query Limits from 10k to 50k

## Summary
Several files across the codebase have query limits set to 10,000 or lower that need to be increased to 50,000 to handle larger datasets consistently.

---

## Files to Update

### 1. `src/context/TelegramContext.tsx`
**Current:** `MAX_CONVERSATIONS = 10000`
**Change:** Update to `50000`
- Line 164: Change `MAX_CONVERSATIONS` constant
- Also update the sequential loop to use parallel fetching for better performance

### 2. `src/pages/SeatChat.tsx`
**Current:** `MAX_CONVERSATIONS = 10000`  
**Change:** Update to `50000`
- Line 407: Change `MAX_CONVERSATIONS` constant
- Already uses parallel fetching, so just the limit needs updating

### 3. `src/hooks/useUniqueConversations.ts`
**Current:** `MAX_RECORDS = 50000`
**Status:** Already at 50k - No change needed

### 4. `src/hooks/useAccounts.ts`
**Current:** `MAX_PAGES = 100` (100 pages × 1000 = 100k max)
**Status:** Already supports 100k - No change needed

### 5. `src/hooks/useProxies.ts`
**Current:** `MAX_PAGES = 100` (100 pages × 1000 = 100k max)
**Status:** Already supports 100k - No change needed

### 6. `src/hooks/useConversations.ts`
**Current:** `MAX_CONVERSATIONS = 50000`
**Status:** Already updated to 50k - No change needed

### 7. `src/hooks/useDatabase.ts`
**Current:** Conversations query has no pagination (will hit 1000 limit)
**Change:** Add paginated fetching for conversations (up to 50k)
- Line 104: Add pagination logic similar to other hooks

---

## Technical Details

### Changes Required

| File | Location | Current Value | New Value |
|------|----------|---------------|-----------|
| `TelegramContext.tsx` | Line 164 | `MAX_CONVERSATIONS = 10000` | `MAX_CONVERSATIONS = 50000` |
| `SeatChat.tsx` | Line 407 | `MAX_CONVERSATIONS = 10000` | `MAX_CONVERSATIONS = 50000` |
| `useDatabase.ts` | Line 104 | No pagination | Add 50k paginated fetch |

### Performance Optimization
For `TelegramContext.tsx`, I will also convert the sequential loop (lines 176-193) to parallel fetching like we did for `useConversations.ts` to improve load times when dealing with 50k records.

---

## No Changes Needed (Already OK)

These files already support sufficient limits:
- `useUniqueConversations.ts` - 50k limit
- `useAccounts.ts` - 100k limit  
- `useProxies.ts` - 100k limit
- `useConversations.ts` - 50k limit (just updated)
