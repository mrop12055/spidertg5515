

# Plan: Fix Account Daily Message Counter Sync

## Problem

The account's `messages_sent_today` counter is stuck at 0 for all accounts, even though they have sent 64 messages today. This happens because:

1. **Root Cause**: The `increment_messages_sent_today` RPC was deployed AFTER today's messages were sent
2. **Result**: The counter was never incremented for existing messages
3. **Impact**: 
   - Reports page shows 0 messages sent per account
   - SeatChat stats show 0 sent today
   - Daily limits will work for NEW messages but existing counts are wrong

### Evidence from Database

| Account | Actual Messages Today | `messages_sent_today` Field |
|---------|----------------------|----------------------------|
| +916002921957 | 11 | 0 |
| +916001022410 | 5 | 0 |
| +916001023471 | 5 | 0 |
| ... (14 accounts) | 64 total | All show 0 |

---

## Solution

Create and run a **sync function** that recalculates `messages_sent_today` from actual message counts.

---

## Technical Changes

### 1. Create Sync Database Function

Add a new PostgreSQL function to sync the counts:

```sql
CREATE OR REPLACE FUNCTION public.sync_messages_sent_today()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Update messages_sent_today based on actual outgoing messages created today
  UPDATE telegram_accounts a
  SET messages_sent_today = COALESCE(sub.count, 0)
  FROM (
    SELECT 
      account_id, 
      COUNT(*) as count
    FROM messages 
    WHERE direction = 'outgoing' 
      AND created_at >= CURRENT_DATE
    GROUP BY account_id
  ) sub
  WHERE a.id = sub.account_id;
  
  -- Reset accounts with no messages today to 0
  UPDATE telegram_accounts
  SET messages_sent_today = 0
  WHERE id NOT IN (
    SELECT DISTINCT account_id 
    FROM messages 
    WHERE direction = 'outgoing' 
      AND created_at >= CURRENT_DATE
  );
END;
$$;
```

### 2. Call Sync in Utilities Edge Function

Update `supabase/functions/utilities/index.ts` to call this sync function as part of the daily maintenance:

```typescript
// Add after reset_daily_message_counts
// Sync messages_sent_today with actual counts
const { error: syncError } = await supabase.rpc('sync_messages_sent_today');
results.messages_sent_today_synced = !syncError;
```

### 3. Run Sync Manually Now

Execute the sync function once immediately to fix current counts. After running:
- Account +916002921957 should show `messages_sent_today = 11`
- All other accounts should show their actual counts

---

## Files to Change

| File | Change |
|------|--------|
| Database migration | Create `sync_messages_sent_today()` function |
| `supabase/functions/utilities/index.ts` | Call sync function during daily maintenance |

---

## How It Works Together

```text
Daily Cycle:
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Midnight (Utilities cron)                                  │
│  ├── reset_daily_message_counts() → Sets all to 0          │
│  └── sync_messages_sent_today() → Recalculates from msgs   │
│                                                             │
│  During Day (Runner tasks)                                  │
│  └── increment_messages_sent_today() → +1 per send         │
│                                                             │
│  Result: Accurate real-time counts                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Verification After Implementation

1. **Immediate**: Run sync function to fix current counts
2. **Check Reports page**: Should show accurate "Today: X / Y" per account
3. **Check SeatChat**: "Sent Today" stat should be accurate
4. **Future messages**: Will increment correctly via the RPC we already deployed

