

# Plan: Allow Restricted Accounts for Existing Conversations

## Summary

Allow accounts with `restricted` or `cooldown` status to send messages in existing conversations (LiveChat/SeatChat), while keeping them blocked for new campaign outreach. The sender account will never be changed - messages will always use the original conversation owner.

## Current Situation

The system currently:
- Includes restricted/cooldown accounts in livechat task fetching (backend already handles this)
- Marks livechat messages as "failed" when the sender account is restricted
- Doesn't show any warning in the UI when a user tries to reply from a restricted account

## Proposed Changes

### 1. Add Visual Warning in SeatChat & Conversations Pages

**Goal**: Show a non-blocking warning badge when the sender account is restricted, but still allow sending

**Files to modify**:
- `src/pages/SeatChat.tsx`
- `src/pages/Conversations.tsx`

**Changes**:
- Fetch the sender account's current status when a conversation is selected
- Display a subtle warning badge/tooltip near the input area indicating the account is in cooldown
- Keep the send button enabled - let users attempt to send (it may work during brief windows)
- Show a more descriptive toast if the message fails due to restriction

### 2. Improve Failure Messaging

**Goal**: Give clearer feedback when messages fail due to account restrictions

**Files to modify**:
- `src/pages/SeatChat.tsx`
- `src/pages/Conversations.tsx`

**Changes**:
- When a message is marked as "failed" with reason containing "cooldown" or "PeerFlood", show a user-friendly message explaining the temporary restriction
- Add visual indicator on failed messages showing the restriction reason

### 3. Ensure Same Sender Account is Always Used

**Current State**: Already correctly implemented in both pages

**Verification**:
- `Conversations.tsx` (line 545): Uses `accounts.find(a => a.id === selectedConv.accountId)`
- `SeatChat.tsx` (line 886): Uses `account_id: selectedConversation.account_id`

No changes needed here - the system already enforces same sender.

### 4. Backend Behavior (Already Correct)

The `runner-tasks` edge function already:
- Includes `restricted`, `cooldown`, and `frozen` accounts for livechat tasks (line 251)
- Fetches account data regardless of status for livechat messages (line 526)
- Properly fails messages when account can't send (line 963-968)

No backend changes needed.

## Technical Details

### UI Warning Component

```text
+------------------------------------------+
|  [Warning Icon] Sender account is on     |
|  temporary cooldown. Messages may fail.  |
+------------------------------------------+
|  [Input field] [Send Button]             |
+------------------------------------------+
```

### Account Status Check Logic

```text
1. When conversation is selected
2. Look up account status from accounts list
3. If status is 'restricted' or 'cooldown':
   - Show warning banner
   - Check if restricted_until has passed
   - Allow sending regardless (user's choice)
4. If message fails with cooldown reason:
   - Show toast explaining the restriction
   - Keep message visible with failed indicator
```

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/SeatChat.tsx` | Add account status warning banner |
| `src/pages/Conversations.tsx` | Add account status warning banner |

## What Will NOT Change

- Sender account will never be swapped
- Campaign messages will still require `active` accounts
- Backend logic remains unchanged
- Restricted accounts can still receive incoming messages (already working)

