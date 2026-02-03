

# Reset 82 Stuck LiveChat Messages

## Current Situation

82 messages are stuck in `sending` status and need to be reset to `pending` so the runner can process them on next poll.

## Solution

Execute a simple UPDATE query to reset all stuck messages:

```sql
UPDATE messages 
SET status = 'pending'
WHERE status = 'sending' 
  AND direction = 'outgoing'
  AND created_at < NOW() - INTERVAL '3 minutes';
```

## Technical Details

**What this does:**
- Finds all outgoing messages stuck in `sending` for more than 3 minutes
- Resets their status to `pending`
- Runner will pick them up on next task poll

**File changes:** None needed - this is a data fix only

**Execution:** Will use the database migration tool to run this as a one-time data fix

