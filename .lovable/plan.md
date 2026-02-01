
# Handle "Recipient Not Found" Error with Retry and Account Restriction

## Overview
When a sender account encounters a "Recipient not found" error, the system will:
1. Mark the sender account as **restricted for 12 hours** (treat it like PeerFlood)
2. Retry sending with a **different account**
3. If the second account also fails with the same error, **permanently mark the recipient as failed** and mark the contact as used

## Current Behavior
- "Recipient not found" errors immediately mark the recipient as `failed`
- The contact is marked as `is_used = true` in `contacts_data`
- No penalty to the sender account (this was added in the last change)

## New Behavior
- **First failure**: 
  - Mark sender account as `restricted` for 12 hours
  - Add account to `failed_account_ids` array
  - Reset recipient to `pending` status for retry
  - Increment `retry_count` to 1
- **Second failure (different account)**:
  - Mark sender account as `restricted` for 12 hours
  - Mark recipient as permanently `failed`
  - Mark contact as `is_used` in `contacts_data`

## Flow Diagram

```
Account A tries to send → "Recipient not found"
   ↓
Mark Account A as restricted (12 hours)
Add Account A to failed_account_ids
Set recipient status = "pending", retry_count = 1
   ↓
Task dispatcher picks up recipient again
Skips Account A (in failed_account_ids)
   ↓
Account B tries to send → "Recipient not found"  
   ↓
Mark Account B as restricted (12 hours)
Mark recipient as "failed" (permanent)
Mark contact as used in contacts_data
```

---

## Technical Details

### File to Modify
`supabase/functions/runner-tasks/index.ts`

### Changes to Error Handling (lines 957-984)

The current code immediately fails the recipient for "Recipient not found". We need to change this to:

1. **Treat "Recipient not found" like an account error** - restrict the sender for 12 hours
2. **Check retry_count** to determine if this is first attempt or retry
3. **First attempt**: Reset recipient to pending, increment retry_count, add account to failed_account_ids
4. **Retry attempt**: Permanently fail the recipient, mark contact as used

### Code Changes

```typescript
// Inside the error handling section, REPLACE the current "recipient not found" handling:

// Check if this is a "recipient not found" error
const isRecipientNotFound = errorLower.includes('recipient not found') || 
                             errorLower.includes('no user') || 
                             errorLower.includes('user not found') ||
                             errorLower.includes('phone not registered');

if (isRecipientNotFound && r.campaign_recipient_id) {
  // Get current recipient state including retry info
  const { data: recipientInfo } = await supabase
    .from("campaign_recipients")
    .select("campaign_id, phone_number, retry_count, failed_account_ids")
    .eq("id", r.campaign_recipient_id)
    .single();

  if (recipientInfo?.campaign_id) {
    affectedCampaignIds.add(recipientInfo.campaign_id);
  }

  const currentRetryCount = recipientInfo?.retry_count || 0;
  const currentFailedAccounts = recipientInfo?.failed_account_ids || [];

  // ALWAYS restrict the sender account for 12 hours
  if (r.account_id) {
    const cooldownUntil = new Date(Date.now() + 720 * 60 * 1000).toISOString(); // 12 hours
    console.log(`[runner-tasks/report] "Recipient not found" - restricting account ${r.account_id} for 12 hours`);
    
    await supabase.from("telegram_accounts")
      .update({ 
        status: "restricted", 
        cooldown_until: cooldownUntil,
        restricted_until: cooldownUntil,
        ban_reason: `Recipient not found: ${r.error}` 
      })
      .eq("id", r.account_id);
    
    await supabase.rpc('increment_account_failure', { acc_id: r.account_id });
  }

  if (currentRetryCount === 0) {
    // FIRST FAILURE: Retry with different account
    console.log(`[runner-tasks/report] First "recipient not found" for ${recipientInfo?.phone_number}, will retry with different account`);
    
    const updatedFailedAccounts = r.account_id && !currentFailedAccounts.includes(r.account_id) 
      ? [...currentFailedAccounts, r.account_id] 
      : currentFailedAccounts;

    await supabase.from("campaign_recipients")
      .update({ 
        status: "pending",
        retry_count: 1,
        failed_account_ids: updatedFailedAccounts,
        failed_reason: null,
        sent_by_account_id: null
      })
      .eq("id", r.campaign_recipient_id);
      
  } else {
    // SECOND+ FAILURE: Multiple accounts failed, permanent failure
    console.log(`[runner-tasks/report] Multiple accounts failed for ${recipientInfo?.phone_number}, marking as permanently failed`);
    
    const updatedFailedAccounts = r.account_id && !currentFailedAccounts.includes(r.account_id) 
      ? [...currentFailedAccounts, r.account_id] 
      : currentFailedAccounts;

    await supabase.from("campaign_recipients")
      .update({ 
        status: "failed", 
        sent_by_account_id: r.account_id, 
        failed_reason: "Recipient not found (confirmed by multiple accounts)",
        failed_account_ids: updatedFailedAccounts
      })
      .eq("id", r.campaign_recipient_id);

    // Mark contact as used
    if (recipientInfo?.phone_number) {
      await supabase.from("contacts_data")
        .update({ 
          is_used: true, 
          used_at: now, 
          notes: 'Auto-marked: Recipient not found (verified by multiple accounts)' 
        })
        .eq("phone_number", recipientInfo.phone_number);
    }
  }

} else {
  // Handle other recipient errors (non "recipient not found")
  // ... existing code for other errors ...
}
```

### Key Differences from Current Implementation

| Aspect | Current | New |
|--------|---------|-----|
| Sender Account | No penalty | Restricted 12 hours |
| First Failure | Recipient marked failed | Recipient reset to pending for retry |
| Retry Logic | No retry | Automatic retry with different account |
| Permanent Failure | After 1 attempt | After 2 different accounts fail |
| Account Failure Count | Not incremented | Incremented (account penalized) |

### Edge Cases Handled

1. **Single account campaign**: If only one account is available, after first failure the recipient stays pending. When the account comes back from restriction (12h later), it will retry. If it fails again, recipient is marked as permanently failed.

2. **All accounts fail quickly**: Each failing account gets restricted, ensuring the system doesn't spam the same error. Recipients stay pending until accounts recover or new accounts are added.

3. **Same account retries**: The `failed_account_ids` array prevents the same account from being assigned twice for the same recipient.
