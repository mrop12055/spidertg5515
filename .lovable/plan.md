
## Why it doesn’t update live (root cause)

On the Seat Chat page you already have “realtime” subscriptions, but the backend currently **is not broadcasting changes** for the tables you care about:

- `public.messages` is **NOT enabled for realtime broadcasting**
- `public.conversations` is **NOT enabled for realtime broadcasting**

I confirmed this by checking the backend publication list: it currently contains only `public.campaigns`.

Because of that, when you stay inside one seat chat, **no push events arrive**, so the UI only updates when you do an action that triggers a manual fetch (switching chats, refresh, periodic polling).

Important: the recent `selectedConversationRef` fix is correct for avoiding “stale state”, but it cannot help if the realtime events never arrive in the first place.

---

## What we will do to fix it (high level)

1) **Backend fix (required):** enable realtime broadcasting for:
- `public.messages`
- `public.conversations`

2) **Frontend fix (recommended for performance + correctness):** once those tables are enabled, the Seat Chat page’s current subscription to `messages` has **no filter**, which would start receiving *all messages in the whole system* (bad performance).  
So we will refactor SeatChat realtime into:
- A **seat-filtered conversations subscription** (for list updates + notifications)
- A **selected-conversation messages subscription** (so the open chat updates live)

This gives true live updates without flooding the seat page with unrelated messages.

---

## Step-by-step implementation plan

### Step 1 — Backend migration: enable realtime broadcasting for messages + conversations
Create a new backend migration that conditionally adds tables to the realtime publication (idempotent; won’t error if already added):

- If `public.messages` is not in publication → add it
- If `public.conversations` is not in publication → add it

Technical approach (conceptual SQL):
```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.messages';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'conversations'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations';
  END IF;
END $$;
```

Validation after migration:
- Re-run publication query and confirm `messages` + `conversations` appear.

---

### Step 2 — SeatChat refactor: split subscriptions (prevents “subscribe to all messages”)
Modify `src/pages/SeatChat.tsx` to avoid the current “listen to ALL messages” design.

#### 2A) Conversations subscription (seat-only)
Keep a channel like:
- `seat-${seat.id}-conversations`

Subscribe to:
- `public.conversations` with filter: `seat_id=eq.${seat.id}`

Handler responsibilities:
- Update conversation list state incrementally (what you already do).
- Trigger notifications based on conversation summary fields:
  - When `last_message_direction` becomes/equals `'incoming'`
  - And `last_message_at` changed since last notification for that conversation

To prevent duplicate notifications, store a ref like:
- `lastNotifiedByConversationRef: Map<conversationId, last_message_at>`

This way you can notify without needing an unfiltered messages feed.

#### 2B) Messages subscription (only for the currently open conversation)
Add a separate `useEffect` that depends on:
- `seat?.id`
- `selectedConversation?.id`

Subscribe to:
- `public.messages` with filter: `conversation_id=eq.${selectedConversation.id}`

Handler responsibilities:
- On `INSERT`: append message to `messages` state (dedupe by id)
- On `UPDATE`: update status in `messages` state

This is exactly the behavior you expect: when you are viewing a chat, new incoming messages appear instantly without switching chats.

---

### Step 3 — Reduce unnecessary refetching
Right now your `messages` subscription calls:
- `fetchConversations()` + `fetchStats()` even for messages that may not belong to this seat (once realtime is enabled, this would become very expensive).

After refactor:
- Call `fetchStats()` (debounced) mainly on **conversation updates**, because every message insert already updates the conversation summary via your trigger.
- Avoid calling `fetchConversations()` from message INSERT events (since the conversation subscription already handles it).

---

## Testing checklist (what you should verify)

1) Open a Seat link (`/seat/:token`)
2) Select a conversation and keep it open
3) Send a reply to that conversation from the other side
4) Confirm:
   - The message appears instantly (no refresh, no switching chats)
   - The unread badge / last message preview updates
   - Notifications fire for incoming replies (sound/toast/browser notification depending on permissions)
5) Also test:
   - Incoming message to a different conversation while you’re viewing another conversation (should notify and update list)

Note: if your workers are using the published site, after we implement fixes in preview you’ll need to publish so those workers get the update.

---

## Scope / files affected

- Backend: new migration to enable realtime on `messages` + `conversations`
- Frontend: `src/pages/SeatChat.tsx` refactor of realtime subscriptions

---

## Expected outcome

- Seat chats update truly live while staying in the same conversation
- Notifications work reliably
- Seat page won’t be flooded by unrelated messages (better speed and stability)
