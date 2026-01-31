
# Fix Pinned Conversation Sorting Behavior

## Current Problem
Pinned conversations are always sorted to the top of the conversation list, even when viewing the "All" tab. The user expects pinned conversations to only appear at the top when explicitly viewing the "Pinned" tab.

## Solution

### SeatChat.tsx Changes
Remove the "pinned first" sorting logic from the main `filteredConversations` memo and the realtime UPDATE handler. Pinned conversations should:
- Sort by time like all other conversations in the "All" tab
- Only appear grouped at top when `chatTab === 'pinned'` (which already filters to show ONLY pinned conversations)

**File: `src/pages/SeatChat.tsx`**

**Change 1 - Remove pinned sorting from filteredConversations (lines 298-305):**
```javascript
// Current (sorting pinned first):
return deduplicateConversations(filtered).sort((a, b) => {
  if (a.is_pinned && !b.is_pinned) return -1;
  if (!a.is_pinned && b.is_pinned) return 1;
  const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
  const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
  return timeB - timeA;
});

// New (only sort by time):
return deduplicateConversations(filtered).sort((a, b) => {
  const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
  const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
  return timeB - timeA;
});
```

**Change 2 - Add sorting to realtime UPDATE handler (lines 607-619):**
Also add proper time-based sorting after updates so conversations reorder correctly when new messages arrive:
```javascript
setConversations(prev => 
  prev.map(conv => 
    conv.id === c.id ? { ...conv, /* updates */ } : conv
  ).sort((a, b) => {
    const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return timeB - timeA;
  })
);
```

### Admin Conversations Page
The admin Conversations page (`src/pages/Conversations.tsx`) already sorts by time only without pinned priority, so no changes needed there.

The TelegramContext realtime handler also already sorts by time correctly.

## Summary of Changes

| File | Change |
|------|--------|
| `src/pages/SeatChat.tsx` | Remove pinned-first sorting from filteredConversations useMemo |
| `src/pages/SeatChat.tsx` | Add time-based sorting to realtime UPDATE handler |

## Expected Outcome
- **All tab**: Conversations sort purely by last message time (newest first)
- **Pinned tab**: Shows only pinned conversations, sorted by last message time
- **Hidden tab**: Shows only hidden conversations, sorted by last message time
- Latest recipient always appears at top regardless of pinned status
