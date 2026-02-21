

## Problem: Uploaded Numbers Not Showing in Seat Chat

### Root Cause
The Seat Chat page **only fetches conversations where `has_reply = true`** (server-side filter). This is by design for performance (see memory note about "Replies Only" default view), but it means:

- **156 conversations** for the Bhatti seat have been messaged but have no reply yet -- these are completely invisible
- **112 conversations** have replies and DO show up
- The "All" tab is misleading -- it shows "all replied conversations," not truly all conversations

### Current Data for Bhatti Seat
- Total conversations (last 5 days): **268**
- With reply (visible): **112**
- Sent but no reply (hidden): **156**
- Not yet sent: **0**

### Solution: Add an "All Chats" Toggle to SeatChat

Add a view switcher that lets the user choose between "Replies Only" (current default, performant) and "All Chats" (includes sent-but-no-reply conversations).

### Changes

**File: `src/pages/SeatChat.tsx`**

1. Add a state variable `showAllChats` (default: `false` to preserve current performance behavior)
2. Add a toggle button/switch near the search bar or tab area labeled "Show All" vs "Replies Only"
3. Modify the `fetchConversations` function (around line 407-450):
   - When `showAllChats = false`: keep current filter `.eq('has_reply', true)` (replies only)
   - When `showAllChats = true`: remove the `has_reply` filter, fetch all conversations with `last_message_at IS NOT NULL`
4. Update the realtime subscription handler to also add new conversations (not just replied ones) when in "All Chats" mode
5. Add a visual indicator (e.g., a small badge) on conversations that haven't received a reply yet, so the user can distinguish them from replied ones

### Technical Details

```text
Current query (replies only):
  .eq('seat_id', seat.id)
  .eq('has_reply', true)
  .gte('last_message_at', fiveDaysAgo)

New query when "All Chats" enabled:
  .eq('seat_id', seat.id)
  .not('last_message_at', 'is', null)
  .gte('last_message_at', fiveDaysAgo)
```

The toggle will re-trigger the fetch when changed. A small "No reply" badge will appear on conversations where `has_reply = false` to help distinguish them visually.

### Performance Note
When "All Chats" is enabled, more conversations will load (268 vs 112 for Bhatti seat currently). This is manageable but the default remains "Replies Only" to keep things fast on lower-end devices.
