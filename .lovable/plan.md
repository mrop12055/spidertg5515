

# Fix Account Data Not Showing in Campaign Reports

## Problem Summary

The "Accounts" tab in campaign reports shows "No Account Data" because the `sent_by_account_id` field in the `campaign_recipients` table is never being populated when messages are sent.

## Root Cause

In the `runner-tasks` edge function, when a campaign recipient is processed:

**Success case (line 691-693):**
```typescript
await supabase.from("campaign_recipients")
  .update({ status: "sent", sent_at: now, api_credential_id: r.api_credential_id })
  .eq("id", r.campaign_recipient_id);
```

**Failure case (line 941-943):**
```typescript
await supabase.from("campaign_recipients")
  .update({ status: "failed", failed_reason: r.error })
  .eq("id", r.campaign_recipient_id);
```

Both cases are **missing** `sent_by_account_id: r.account_id`.

---

## Solution

### Step 1: Update the Edge Function

Modify `supabase/functions/runner-tasks/index.ts` to include `sent_by_account_id` when updating campaign recipients.

**Success case (around line 691):**
```typescript
await supabase.from("campaign_recipients")
  .update({ 
    status: "sent", 
    sent_at: now, 
    sent_by_account_id: r.account_id,  // ADD THIS
    api_credential_id: r.api_credential_id 
  })
  .eq("id", r.campaign_recipient_id);
```

**Failure case (around line 941):**
```typescript
await supabase.from("campaign_recipients")
  .update({ 
    status: "failed", 
    sent_by_account_id: r.account_id,  // ADD THIS
    failed_reason: r.error 
  })
  .eq("id", r.campaign_recipient_id);
```

### Step 2: Backfill Existing Data (Optional)

For campaigns that have already run, we can attempt to backfill the `sent_by_account_id` by matching the `campaign_recipient_id` in the messages table:

```sql
UPDATE campaign_recipients cr
SET sent_by_account_id = m.account_id
FROM messages m
WHERE m.campaign_recipient_id = cr.id
  AND cr.sent_by_account_id IS NULL
  AND m.direction = 'outgoing';
```

---

## Files to Modify

| File | Change |
|------|--------|
| `supabase/functions/runner-tasks/index.ts` | Add `sent_by_account_id: r.account_id` to both success and failure update queries |

## Expected Result

After this fix:
- New campaign messages will properly track which account sent/attempted to send each message
- The "Accounts" tab in campaign reports will show per-account statistics
- Existing data can be backfilled using the messages table

