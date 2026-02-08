

## Fix: New Conversations Not Appearing in Realtime

### Problem
When new conversations appear (e.g., someone replies to a campaign message), they don't show up in the chat list until you manually refresh. This happens because:

1. The initial fetch only loads conversations with `has_reply = true`
2. When a conversation gets its first reply, it arrives as an **UPDATE** event (changing `has_reply` from false to true)
3. The UPDATE handler only updates **existing** conversations in the list using `.map()` -- it never **adds** new ones
4. So conversations that transition to `has_reply = true` are silently ignored

### Solution

**File: `src/pages/SeatChat.tsx`** (lines 688-710)

Update the realtime UPDATE handler to detect when a conversation isn't already in the list and **add it** instead of just mapping:

```
Before (simplified):
  setConversations(prev => 
    prev.map(conv => conv.id === c.id ? { ...conv, ...updates } : conv)
  );

After:
  setConversations(prev => {
    const exists = prev.some(conv => conv.id === c.id);
    if (exists) {
      // Update existing conversation
      return prev.map(conv => conv.id === c.id ? { ...conv, ...updates } : conv);
    } else if (c.has_reply) {
      // New conversation with a reply -- add it to the list
      return [newConversationObject, ...prev];
    }
    return prev;
  });
```

The sorting logic (with frozen positions) stays the same. The new conversation will naturally appear at the top since it has the newest timestamp and isn't frozen.

This is a single change to the UPDATE branch of the realtime subscription handler -- no other files need modification.

