

# Fix Seat Chat Performance: Default to Replied-Only Mode

## Problem

On lower-end PCs (8GB RAM or less), the Seat Chat page is laggy with 1-2 second delays when switching between conversations. This happens because the page loads and renders all campaign-initiated conversations, even those where the recipient hasn't replied yet.

## Solution

Change the default filter to only show conversations where the recipient has replied. This dramatically reduces the number of conversations that need to be rendered, making the page much faster on all devices.

## What Will Change

### 1. SeatChat.tsx - Change Default Filter
Currently:
```javascript
const [showRepliedOnly, setShowRepliedOnly] = useState(false);
```

Change to:
```javascript
const [showRepliedOnly, setShowRepliedOnly] = useState(true);
```

### 2. Update Toggle Button Label
The button text will be adjusted so it makes sense with the new default:
- When ON (default): "Replies Only" 
- When OFF: "Show All Chats"

This is a single-line change that will:
- Reduce rendered conversations by potentially 70-90% (depending on reply rates)
- Make chat switching instant on low-end devices
- Keep the option to view all conversations by clicking the toggle

## Technical Notes

The `has_reply` field is already indexed in the database (from earlier migrations) and is maintained by a trigger on the messages table, so filtering by this field is fast.

Users who want to see all campaign conversations (including those without replies) can still toggle the filter off.

