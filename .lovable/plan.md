

# Plan: Fix Daily Message Limit Enforcement for Campaigns

## Problem

Campaigns ignore the `messagesPerAccountPerDay` setting (e.g., set to 5 in your database) because the `messages_sent_today` counter is never incremented when messages are sent.

### Evidence

```sql
-- Your current settings
campaign_speed: { messagesPerAccountPerDay: 5 }

-- But all accounts show
messages_sent_today: 0  -- Never incremented!
```

### Root Cause

The edge function (`runner-tasks`) checks the limit:
```typescript
// Line 233-234 - This check exists
const limit = config.campaignMessagesPerAccountPerDay || ...;
if ((a.messages_sent_today ?? 0) >= limit) return false;
```

But **never increments** the counter when a message is successfully sent. The counter stays at 0 forever.

---

## Technical Changes

### 1. Increment Counter After Successful Campaign Send

**File**: `supabase/functions/runner-tasks/index.ts`

Add increment logic after a campaign message is successfully sent (inside the success handler, around line 648):

```typescript
// After incrementing campaign count (line 647-648)
if (!wasAlreadySent) {
  await supabase.rpc('increment_campaign_sent_count', { cid: r.campaign_id });
  
  // INCREMENT MESSAGES_SENT_TODAY for the account
  if (r.account_id) {
    await supabase.from("telegram_accounts")
      .update({ 
        messages_sent_today: supabase.sql`messages_sent_today + 1`,
        last_active: now 
      })
      .eq("id", r.account_id);
  }
}
```

Since Supabase JS doesn't support raw SQL in update, we need to use an RPC function instead.

### 2. Create Database Function to Increment Counter

**Migration**: Create an RPC function for atomic increment:

```sql
CREATE OR REPLACE FUNCTION public.increment_messages_sent_today(acc_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE telegram_accounts 
  SET messages_sent_today = COALESCE(messages_sent_today, 0) + 1,
      last_active = now()
  WHERE id = acc_id;
END;
$$;
```

### 3. Call the RPC After Successful Send

**File**: `supabase/functions/runner-tasks/index.ts`

Update the success handler:

```typescript
// After campaign sent_count increment
if (!wasAlreadySent) {
  await supabase.rpc('increment_campaign_sent_count', { cid: r.campaign_id });
  
  // Increment account's daily message counter
  if (r.account_id) {
    await supabase.rpc('increment_messages_sent_today', { acc_id: r.account_id });
  }
}
```

---

## Files to Change

| File | Change |
|------|--------|
| Database migration | Create `increment_messages_sent_today` RPC function |
| `supabase/functions/runner-tasks/index.ts` | Call `increment_messages_sent_today` after successful campaign send |

---

## Result After Fix

| Aspect | Before | After |
|--------|--------|-------|
| `messages_sent_today` | Always 0 | Increments with each send |
| Daily limit check | Always passes (0 < 5) | Enforced correctly |
| Account rotation | Doesn't respect limits | Skips accounts at limit |
| Your setting (5/day) | Ignored | Enforced |

---

## Testing

After implementing:
1. Start a campaign with 20 recipients and 4 accounts
2. Each account should send max 5 messages (if `messagesPerAccountPerDay: 5`)
3. Check `messages_sent_today` in database - should show actual counts
4. Accounts at limit should be skipped for remaining recipients

