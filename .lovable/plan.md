
# Fix Last Message Display to Show Direction

## Problem
The last message preview in the conversation sidebar shows only the recipient's message content, without indicating whether it was sent by you or received from them. This is inconsistent with SeatChat which correctly shows "You: " prefix for outgoing messages.

## Root Cause
The Conversations page uses `TelegramContext` which:
1. Does not fetch the `last_message_direction` column from the database
2. The `Conversation` type does not include a `lastMessageDirection` property
3. The UI does not display any direction indicator (unlike SeatChat)

## Solution
Add the `lastMessageDirection` field throughout the data flow and update the UI to show "You: " prefix for outgoing messages.

---

## Implementation Steps

### Step 1: Update Conversation Type
Add `lastMessageDirection` property to the `Conversation` interface.

**File:** `src/types/telegram.ts`
- Add `lastMessageDirection?: 'incoming' | 'outgoing';` to the Conversation interface

### Step 2: Update TelegramContext Data Fetching
Fetch and map the `last_message_direction` column from the database.

**File:** `src/context/TelegramContext.tsx`
- Add `last_message_direction` to the SELECT query for conversations
- Map the field to `lastMessageDirection` in the conversation transformer

### Step 3: Update Conversations Page Display
Add the "You: " prefix for outgoing messages in the conversation preview.

**File:** `src/pages/Conversations.tsx`
- Check if `conv.lastMessageDirection === 'outgoing'` and display "You: " prefix before the message preview

### Step 4: Update useConversations Hook
Also update the hook used elsewhere to include direction.

**File:** `src/hooks/useConversations.ts`
- Add `last_message_direction` to the SELECT query
- Map the field in the transformer

---

## Technical Details

### Database Structure (already exists)
The `conversations` table has these columns that are updated by a trigger on message inserts:
- `last_message_content` - text content of the last message
- `last_message_direction` - 'incoming' or 'outgoing'

### UI Display Pattern (matching SeatChat)
```tsx
{conv.lastMessageDirection === 'outgoing' && (
  <span className="text-muted-foreground/50">You: </span>
)}
{messagePreview}
```

## Files to Modify
1. `src/types/telegram.ts` - Add type property
2. `src/context/TelegramContext.tsx` - Fetch and map direction field
3. `src/pages/Conversations.tsx` - Display direction prefix
4. `src/hooks/useConversations.ts` - Include direction in query

## Expected Result
The conversation sidebar will show:
- "You: Hello!" - for messages you sent
- "Hello!" - for messages received from the contact

This matches the behavior already implemented in SeatChat.
