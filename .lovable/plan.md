

## Optimize Seats & SeatChat Pages: Parallel Fetching, Realtime-Only Updates, Replies-Only Rendering

### Current Problems

1. **Seats page (`Seats.tsx`)**: 
   - Fetches seats, stats, pending recipients, and unread replies **sequentially** (one after another)
   - Has a 60-second auto-refresh interval that refetches everything
   - No realtime subscriptions for stats/conversations changes

2. **SeatChat page (`SeatChat.tsx`)**:
   - Has a 30-second auto-refresh interval (line 788-796) that refetches all conversations + stats
   - Already has realtime subscriptions for conversations and messages, making the polling redundant
   - Fetches ALL conversations (including those without replies) from the database, then filters client-side
   - The `fetchConversations` query fetches conversations where `first_message_sent OR has_reply`, but we only want `has_reply = true`

### Changes

#### 1. Seats.tsx - Parallel Fetching + Realtime

**Parallel fetching**: Convert the sequential `fetchSeats` function to run all 4 queries (seats, seat_stats, campaign_recipients pending, conversations unread) using `Promise.all` instead of awaiting each one sequentially.

**Replace auto-refresh with realtime**: 
- Remove the 60-second `setInterval` polling
- Add realtime subscriptions for `conversations` and `campaign_recipients` tables (in addition to the existing `seats` subscription)
- On conversation changes: incrementally update `unreadReplies` state
- On campaign_recipients changes: incrementally update `pendingReplies` state  
- Debounce stats refetch on realtime events (since `seat_stats` is a view, we still need to query it, but only when data changes)

#### 2. SeatChat.tsx - Remove Polling + Server-Side Replies-Only Filter

**Remove auto-refresh polling**:
- Delete the 30-second interval (lines 788-796) entirely
- The existing realtime subscriptions already handle conversation updates, message inserts, and stats refresh via debounced callbacks

**Server-side replies-only filter**:
- Change `fetchConversations` to add `.eq('has_reply', true)` to the database query instead of fetching all conversations and filtering client-side
- Remove the client-side filter `allData.filter(conv => conv.first_message_sent || conv.has_reply)`
- This reduces data transfer by 70-90% since most campaign conversations never get a reply
- Update the realtime INSERT handler: when a new conversation gets `has_reply = true`, it will be picked up by the realtime UPDATE handler which already checks `has_reply`

**Update filtering logic**:
- In `timeFilteredConversations` memo, remove the `first_message_sent` check since we only fetch replied conversations now
- Simplify the `showRepliedOnly` toggle -- since all fetched conversations have replies, this filter becomes the default behavior

### Technical Details

```text
Seats.tsx fetchSeats() -- Before:
  await seats query
  await stats query
  await pending query
  await unread query
  Total: ~4 round trips sequential

Seats.tsx fetchSeats() -- After:
  Promise.all([seats, stats, pending, unread])
  Total: ~1 round trip (parallel)
```

```text
SeatChat.tsx fetchConversations() -- Before:
  Query: seat_id = X AND last_message_at >= 5d ago
  Client filter: first_message_sent OR has_reply
  + 30s polling interval

SeatChat.tsx fetchConversations() -- After:
  Query: seat_id = X AND has_reply = true AND last_message_at >= 5d ago
  No client filter needed
  No polling (realtime only)
```

### Files Modified
- `src/pages/Seats.tsx` -- parallel fetching + realtime subscriptions, remove polling
- `src/pages/SeatChat.tsx` -- server-side has_reply filter, remove 30s polling interval

