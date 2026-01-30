
# Plan: Fix PeerFlood Error Handling ✅ COMPLETED

## The Problem

**PeerFlood** is an error about the **sender account** being rate-limited by Telegram, NOT about the recipient being unreachable.

**Previous behavior (wrong):**
- When PeerFlood occurred, the recipient was marked as "failed"
- The sender account continued as normal
- The recipient never got the message even though there was nothing wrong with them

**New behavior (fixed):**
- PeerFlood puts the **sender account** in cooldown status
- The recipient is reset to "pending" for retry by another account
- The failed account is tracked in `failed_account_ids` to prevent retrying with the same account

---

## Changes Made

### 1. Database: Added `cooldown_until` column
```sql
ALTER TABLE telegram_accounts ADD COLUMN cooldown_until TIMESTAMPTZ;
```

### 2. Edge Function: Account-Level Error Detection

Modified `supabase/functions/runner-tasks/index.ts` to:

| Error Type | Action on Recipient | Action on Account |
|------------|---------------------|-------------------|
| PeerFlood | Reset to "pending" | Set status="cooldown", set cooldown_until |
| FloodWait | Reset to "pending" | Set status="cooldown" (duration from error) |
| UserDeactivated | Reset to "pending" | Set status="cooldown" |
| AuthKeyUnregistered | Reset to "pending" | Set status="cooldown" |
| Privacy restricted | Mark failed | No action (recipient's choice) |
| User blocked | Mark failed | No action |
| Not on Telegram | Mark failed | No action |

### 3. Task Dispatcher: Skip Failed Accounts

- Added logic to skip accounts in the `failed_account_ids` array for each recipient
- Auto-restore accounts from cooldown when `cooldown_until` expires

---

## Expected Behavior After Fix

**Before (current):**
```
Campaign: 50 recipients
Account A: PeerFlood after 10 sends
Result: 10 sent, 40 failed (WRONG - all 40 marked failed)
```

**After (fixed):**
```
Campaign: 50 recipients  
Account A: PeerFlood after 10 sends → Account A goes to cooldown
Account B: Picks up remaining 40 recipients
Result: 10 sent by A, 40 sent by B (CORRECT)
```

---

## Technical Details

**FloodWait duration parsing:**
- If error contains `FloodWait:300`, cooldown = 300 seconds + 5 min buffer
- Default cooldown = 30 minutes

**Account tracking:**
- `failed_account_ids` array on `campaign_recipients` prevents retrying with the same account
- Account is restored to "active" automatically when `cooldown_until` expires
