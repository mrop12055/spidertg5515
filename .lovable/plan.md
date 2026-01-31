
# Fix Missing Notifications on Seat Chat Pages

## Problem Summary

The Seat Chat page (`/seat/:token`) does not play notification sounds or show browser notifications when new incoming messages arrive. Workers using these pages miss important replies from recipients.

## Root Cause

1. The `useNotifications` hook exists in `src/hooks/useNotifications.ts` but is **never imported or used anywhere** in the application

2. The `TelegramContext.tsx` has inline notification logic (lines 329-387), but the SeatChat page:
   - Is a public route that doesn't rely on TelegramContext for its data
   - Has its own realtime subscriptions that update the UI but don't trigger notifications

3. The SeatChat realtime handler (lines 536-611) only:
   - Updates the messages list in the UI
   - Updates conversation metadata
   - Does NOT play sounds or show browser notifications

## Solution

Add notification support directly to the SeatChat page by:
1. Detecting new incoming messages in the existing realtime subscription
2. Playing the notification sound when a new incoming message arrives
3. Showing browser notifications (with permission request)

## Implementation Plan

### Step 1: Import the notification sound function

Import `playNotificationSound` from the existing `useNotifications.ts` hook into `SeatChat.tsx`. We don't need the full hook since SeatChat has its own realtime subscription - we just need the sound function.

### Step 2: Add notification permission request

On component mount, request browser notification permission if not already granted or denied.

### Step 3: Modify the realtime message handler

Update the existing realtime subscription in SeatChat (around line 544-568) to:
- Detect when a new **incoming** message arrives
- Play the notification sound
- Show a browser notification with the message preview
- Only notify if the conversation belongs to this seat

### Step 4: Add visual unread indicator animation

When a new reply arrives for a conversation that isn't currently selected:
- Briefly highlight/animate that conversation in the sidebar
- The unread badge already updates via realtime

---

## Technical Details

### Files to Modify

**`src/pages/SeatChat.tsx`**

1. Import the notification sound:
```typescript
import { playNotificationSound } from '@/hooks/useNotifications';
```

2. Add notification permission request in a useEffect:
```typescript
useEffect(() => {
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}, []);
```

3. Update the realtime handler (around line 544) to include notification logic:
```typescript
if (payload.eventType === 'INSERT') {
  const m = payload.new as any;
  
  // Check if this is an incoming message for this seat's conversation
  if (m.direction === 'incoming') {
    // Find if this conversation belongs to this seat
    const targetConv = conversations.find(c => c.id === m.conversation_id);
    
    if (targetConv) {
      // Play notification sound
      playNotificationSound();
      
      // Show browser notification
      if (Notification.permission === 'granted') {
        new Notification('New Reply', {
          body: m.content?.substring(0, 100) || 'You received a new message',
          icon: '/favicon.ico',
          tag: m.id
        });
      }
      
      // Also show a toast for in-app notification
      toast.info('New reply received!', {
        description: m.content?.substring(0, 50) || 'You have a new message',
      });
    }
  }
  
  // Existing logic for updating selected conversation messages...
}
```

### Notification Behavior

| Scenario | Sound | Browser Notification | Toast |
|----------|-------|---------------------|-------|
| New incoming message for this seat | Yes | Yes (if permitted) | Yes |
| New outgoing message | No | No | No |
| Message for different seat | No | No | No |
| Currently viewing the conversation | Yes | Yes | Yes |

### Edge Cases Handled

1. **Duplicate notifications**: Use message ID to prevent re-notifying for the same message
2. **Permission denied**: Gracefully skip browser notifications, still play sound
3. **Audio context blocked**: Catch errors and continue without crashing
4. **Tab not focused**: Browser notifications will still appear (that's their purpose)

---

## Testing Steps

1. Open a Seat Chat page in one browser tab
2. Simulate an incoming message (or have someone actually reply)
3. Verify:
   - Notification sound plays
   - Browser notification appears (if permission granted)
   - Toast notification shows in-app
   - Conversation list updates with unread badge
   - Message appears in chat if that conversation is selected
