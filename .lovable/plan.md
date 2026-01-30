
# Plan: Fix PeerFlood Error Handling

## The Problem

You're absolutely right! **PeerFlood** is an error about the **sender account** being rate-limited by Telegram, NOT about the recipient being unreachable.

**Current behavior (wrong):**
- When PeerFlood occurs, the recipient is marked as "failed"
- The sender account continues as normal
- The recipient never gets the message even though there's nothing wrong with them

**Correct behavior:**
- PeerFlood should pause/cooldown the **sender account**
- The recipient should be reset to "pending" for retry by another account
- Error logs should indicate the account problem, not recipient failure

---

## Root Cause Analysis

**Python runner (line 290-291):**
```python
except PeerFloodError:
    return False, "PeerFlood", {"skip_account": True}
```

The runner correctly returns `skip_account: True`, but this flag is **never processed** by the edge function.

**Edge function (lines 700-704):**
```typescript
if (r.campaign_recipient_id) {
  await supabase.from("campaign_recipients")
    .update({ status: "failed", failed_reason: r.error })
    .eq("id", r.campaign_recipient_id);
}
```

It blindly marks the recipient as failed without checking if the error is account-related.

---

## Solution

### 1. Edge Function: Detect Account-Level Errors

Modify `supabase/functions/runner-tasks/index.ts` to:

| Error Type | Action on Recipient | Action on Account |
|------------|---------------------|-------------------|
| PeerFlood | Reset to "pending" | Set status="cooldown", set cooldown_until |
| FloodWait | Reset to "pending" | Set status="cooldown", set cooldown_until |
| Privacy restricted | Mark failed | No action (recipient's choice) |
| User blocked | Mark failed | No action |
| Not on Telegram | Mark failed | No action |

**Code changes:**
```typescript
// In handleReportResults failure processing
const accountErrors = ['peerflood', 'floodwait'];
const isAccountError = accountErrors.some(e => errorLower.includes(e));

if (isAccountError) {
  // Reset recipient to pending for retry
  await supabase.from("campaign_recipients")
    .update({ status: "pending", failed_reason: null, account_id: null })
    .eq("id", r.campaign_recipient_id);
  
  // Put account in cooldown
  const cooldownMinutes = extractFloodWait(r.error) || 30;
  await supabase.from("telegram_accounts")
    .update({ 
      status: "cooldown", 
      cooldown_until: new Date(Date.now() + cooldownMinutes * 60000).toISOString(),
      ban_reason: r.error 
    })
    .eq("id", r.account_id);
} else {
  // Recipient-level error - mark as failed
  await supabase.from("campaign_recipients")
    .update({ status: "failed", failed_reason: r.error })
    .eq("id", r.campaign_recipient_id);
}
```

### 2. Task Dispatcher: Skip Cooldown Accounts

Modify the account selection query to exclude accounts in cooldown:

```typescript
// In getCampaignTasks
.neq("status", "cooldown")
.or(`cooldown_until.is.null,cooldown_until.lt.${new Date().toISOString()}`)
```

### 3. Add cooldown_until Column (if not exists)

```sql
ALTER TABLE telegram_accounts 
ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
```

---

## Files to Change

| File | Changes |
|------|---------|
| `supabase/functions/runner-tasks/index.ts` | Detect PeerFlood/FloodWait as account errors, reset recipients to pending, put account in cooldown |
| Database migration | Add `cooldown_until` column to `telegram_accounts` |

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

## Technical Implementation Details

**Account-level errors to detect:**
- `PeerFlood` - Telegram thinks account is spamming
- `FloodWait:Xs` - Must wait X seconds before sending
- `UserDeactivated` - Account banned
- `AuthKeyUnregistered` - Session expired

**Recipient-level errors (these should mark recipient as failed):**
- `Privacy restricted` - User blocks strangers
- `User blocked` - User blocked your account
- `Not on Telegram` - Phone not registered
- `Recipient not found` - Username/phone invalid
