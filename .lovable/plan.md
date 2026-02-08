
## Fix: Keep Conversation List Stable After Replying

### Problem
When you reply to a conversation at the bottom of the list and then go back (deselect it), the conversation immediately jumps to the top because its `last_message_at` was updated. You then have to scroll down again to find the next conversation to reply to. This makes bulk-replying very tedious.

### Root Cause
The `selectedConvPositionRef` freezes the sort position while a conversation is open, but clears it to `null` the moment you deselect. This triggers a re-sort using real timestamps, causing the just-replied conversation to jump to the top.

### Solution
Instead of clearing the frozen position on deselect, **keep it until a different conversation is selected**. This way:

1. You open a conversation at position #15 -- its position is frozen
2. You reply -- it stays at #15
3. You go back (deselect) -- it STILL stays at #15
4. You open conversation #16 -- NOW the old freeze clears and #15 re-sorts to the top naturally

### Technical Change

**File: `src/pages/SeatChat.tsx`**

Update the `useEffect` that manages `selectedConvPositionRef`:

- **Before**: When `selectedConversation` is null, immediately set ref to `null`
- **After**: When `selectedConversation` is null, do nothing (keep the previous freeze). Only clear/replace the freeze when a *new* conversation is selected (different ID)

The effect at lines 175-188 changes from:
```
if (!selectedConversation) {
  selectedConvPositionRef.current = null;  // clears freeze
  return;
}
```
To:
```
if (!selectedConversation) {
  return;  // keep previous freeze in place
}
```

This single change ensures the list stays stable while you work through conversations sequentially. The frozen position only gets replaced when you click on a different conversation.
