
## Goal ✅ COMPLETED
Make LiveChat work reliably: accounts must stay connected to receive messages, and incoming messages must be saved into the backend so they appear in the Conversations/SeatChat UI.

## Changes Made

### A) Backend: Added incoming message support ✅
**File:** `supabase/functions/runner-tasks/index.ts`

1. Extended `handleReportResults()` to handle `task_type: "incoming"` or `"incoming_message"`
2. Added `processIncomingMessage()` function that:
   - Finds existing conversation by `(account_id, recipient_telegram_id)` or `(account_id, recipient_phone)`
   - Creates new conversation if not found
   - Deduplicates messages by `telegram_message_id` to prevent duplicates on reconnects
   - Inserts message with `direction: 'incoming'`, `status: 'delivered'`
   - Updates conversation: `last_message_at`, `last_message_content`, `last_message_direction`, `has_reply`, `unread_count`

3. Added database function `increment_unread_count(conv_id)` for atomic counter updates

### B) Runner template: Fixed account connectivity ✅
**File:** `src/pages/SetupGuide.tsx`

1. Removed direct REST `fetch_accounts()` call that was failing
2. Runner now uses `/runner-tasks/get` which already returns accounts array
3. Updated `connect_all_from_response()` to use accounts from task response
4. Main loop now:
   - Fetches tasks AND accounts from single endpoint
   - Connects accounts on startup
   - Refreshes account connections every 60s or when new accounts appear
   - Prints "N clients listening" instead of "0 clients"

## How to Test

1. Download the new runner from Setup page
2. Run on VPS - should now show:
   ```
   Fetching accounts from backend...
   CONNECTING ACCOUNTS
   Found 2 accounts...
   ✓ [1496] Connected
   ✓ [9866] Connected
   Connected: 2/2
   
   PROCESSING TASKS + LISTENING FOR MESSAGES
   [WAIT] No tasks (2 clients listening)
   ```

3. Send a Telegram message to one of the connected accounts
4. Should see: `📩 [1496] ← SenderName: Hello...`
5. Check Conversations page - new message should appear

## Expected Log Output After Fix
```
Fetching accounts from backend...
==================================================
  CONNECTING ACCOUNTS
==================================================
  Found 2 accounts...

  ✓ [1496] Connected
  ✓ [9866] Connected

  Connected: 2/2

==================================================
  PROCESSING TASKS + LISTENING FOR MESSAGES
==================================================

  [WAIT] No tasks (2 clients listening)
  📩 [1496] ← John: Hello, is this available?
  [WAIT] No tasks (2 clients listening)
```
