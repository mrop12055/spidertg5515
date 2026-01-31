
Problem diagnosis (why the same reply toast shows 2–3 times)
- This is not “duplicate code” in the UI; it’s multiple realtime events for the same incoming message.
- In Seat Chat (`src/pages/SeatChat.tsx`) notifications are triggered from `conversations` UPDATE events (not from `messages` INSERT). A single incoming message can cause multiple UPDATEs on the same conversation row (e.g., one update sets last_message_* fields, later update adjusts unread_count/has_reply/updated_at).  
- Your current dedupe in Seat Chat uses `last_message_at` as a raw string. If UPDATE #2 carries the same time with slightly different formatting OR if last_message_at is recomputed/updated again (even by milliseconds), the “new vs old” check fails and it notifies again (often 1–2 seconds later, matching what you’re seeing).
- I also checked the database for your example content (`asdfasd`) and there was only one message row inserted, so the duplicates are not coming from multiple DB rows.

Goal
- Show exactly 1 toast per incoming reply (both in Seat Chat and Admin /conversations), even if realtime sends multiple events.

Implementation plan

A) Fix Seat Chat notification dedupe (primary culprit)
File: `src/pages/SeatChat.tsx`

1) Notify ONLY when the incoming “last message” actually changed
- In the seat conversations realtime handler (currently around the block that checks `c.last_message_direction === 'incoming'`), use `payload.old` to detect whether this UPDATE represents a new incoming message.
- New condition:
  - `newC.last_message_direction === 'incoming'`
  - AND `newC.last_message_at` is present
  - AND at least one of these changed compared to `oldC`:
    - `oldC.last_message_at !== newC.last_message_at`
    - OR `oldC.last_message_content !== newC.last_message_content`
    - OR `oldC.last_message_direction !== newC.last_message_direction`
- If only `unread_count`/`has_reply`/`updated_at` changes while last_message_* stays the same, we do NOT notify.

2) Normalize timestamps for dedupe (avoid string-format differences)
- Replace the current map `lastNotifiedByConversationRef: Map<string, string>` with a map that stores a number (milliseconds):
  - `const lastNotifiedByConversationRef = useRef<Map<string, number>>(new Map());`
- Convert `newC.last_message_at` into a stable number:
  - `const msgTimeMs = new Date(newC.last_message_at).getTime();`
- Compare numbers instead of strings.

3) Use a stable toast “id” derived from normalized time (and optionally content)
- Update the `toast.info` id so Sonner can collapse/replace duplicates:
  - `id: reply-${newC.id}-${msgTimeMs}`
- If you still see edge cases where msgTimeMs changes slightly across updates for the same message, add content into the key:
  - `id: reply-${newC.id}-${msgTimeMs}-${(newC.last_message_content ?? '').slice(0, 20)}`
  (Keeps it stable for “same message”, still unique across different messages.)

4) Add a short safety cooldown per conversation (belt-and-suspenders)
- Add a second check: if we already notified the same conversation within the last ~2 seconds for the same content, skip.  
This prevents “triple toast” even if timestamps jitter.
- Implementation approach:
  - Store `{ lastTimeMs, lastContent }` per conversation in a ref map and skip if:
    - `now - lastNotifyWallClock < 2000` AND `content same`.

5) Keep everything else the same
- Conversation list sorting updates stay unchanged (we already made it time-based).
- Stats refetch stays debounced as-is.

B) Harden Admin (/conversations) notifications against duplicate deliveries (secondary hardening)
File: `src/context/TelegramContext.tsx`

Even though it already has dedupe, we’ll make it “bulletproof”:

1) Deduplicate by message row id (best unique identifier)
- Use a `useRef<Set<string>>` (or module-level Set) for processed message IDs:
  - Key: `m.id` (DB primary key)
- If `processedMessageIds.has(m.id)` return early; else add it and show toast.
- Keep your existing “campaign conversation only” rule.

2) Keep Sonner toast id stable
- Set toast id to use the message row id:
  - `id: reply-${m.id}`
This guarantees identical incoming message cannot create multiple separate toast entries.

3) Optional: prune the Set to avoid memory growth
- Keep only last N ids (e.g., 2000) or prune after 10 minutes.

C) Verification steps (what you should test after I implement)
1) Seat Chat
- Open `/seat/:token`.
- Receive 1 new reply on a conversation that’s not selected.
- Confirm:
  - Only 1 toast appears.
  - Wait 3–5 seconds: no second “same reply” toast appears.
2) Admin Conversations
- Open `/conversations`.
- Receive 1 new reply.
- Confirm only 1 toast appears.

Notes / edge cases handled
- If browser Notification permission is denied/default, toast still shows once.
- If realtime sends UPDATE events that only modify unread_count/has_reply, no toast.
- If last_message_at string formatting changes across events, normalization prevents duplicates.

Files that will be changed
- `src/pages/SeatChat.tsx` (main fix)
- `src/context/TelegramContext.tsx` (hardening; ensures /conversations never duplicates)

If, after this, you still see duplicates, the next step will be to temporarily add console logs for the realtime payload (old/new last_message fields + computed key) to confirm exactly which field is changing between the repeated events and tighten the filter further.
