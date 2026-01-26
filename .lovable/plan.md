
# Plan: Improved Least-Used-First Account Assignment

## Current Behavior

The `get-batch-tasks` edge function currently:
1. Sorts accounts by `batchAccountUsage` (usage within current batch only)
2. Assigns accounts in round-robin within the batch
3. Does NOT prioritize accounts with 0 `messages_sent_today` globally

**Problem**: If batch size is 50 and you have 100 accounts where 50 have 0 messages today and 50 have 5 messages today, the current logic might mix them instead of using all zero-message accounts first.

---

## Proposed Changes

### File: `supabase/functions/get-batch-tasks/index.ts`

**Location**: Lines 936-951 (account selection logic)

**Current Code**:
```typescript
const sortedAccounts = [...campaignUsableAccounts].sort((a: any, b: any) => {
  // Sort by batch usage (least used in this batch first)
  const batchUsageA = batchAccountUsage.get(a.id) || 0;
  const batchUsageB = batchAccountUsage.get(b.id) || 0;
  return batchUsageA - batchUsageB;
});
```

**New Code** - Two-level sorting:
```typescript
const sortedAccounts = [...campaignUsableAccounts].sort((a: any, b: any) => {
  // PRIMARY: Sort by total messages sent today (0 messages first)
  const sentTodayA = accountCampaignSentToday.get(a.id) || 0;
  const sentTodayB = accountCampaignSentToday.get(b.id) || 0;
  
  if (sentTodayA !== sentTodayB) {
    return sentTodayA - sentTodayB; // Accounts with 0 messages first
  }
  
  // SECONDARY: For accounts with same messages today, sort by batch usage
  const batchUsageA = batchAccountUsage.get(a.id) || 0;
  const batchUsageB = batchAccountUsage.get(b.id) || 0;
  return batchUsageA - batchUsageB;
});
```

---

## How It Works

### Example: 100 Accounts, Batch Size 50

**Account Pool**:
- 50 accounts with 0 messages today
- 30 accounts with 1 message today
- 20 accounts with 2 messages today

**Assignment Order**:

1. **First 50 recipients**: Use all 50 accounts with `messages_sent_today = 0` (one message each)
2. **Next 30 recipients**: Use accounts with `messages_sent_today = 1` (now they have 2)
3. **Next 20 recipients**: Use accounts with `messages_sent_today = 2` (now they have 3)
4. **Continue**: Cycle back to least-used accounts

**Result**: Maximum distribution across accounts, minimizing risk of triggering spam detection.

---

## Visual Flow

```text
Account Selection Priority:

   100 Available Accounts
           |
           v
   ┌───────────────────────────────┐
   │ STEP 1: Sort by messages_sent_today │
   │ (accounts with 0 messages FIRST)    │
   └───────────────────────────────┘
           |
           v
   ┌───────────────────────────────┐
   │ STEP 2: For same count, sort by     │
   │ batch usage (least used in batch)   │
   └───────────────────────────────┘
           |
           v
   ┌───────────────────────────────┐
   │ STEP 3: Pick first eligible account │
   │ (not failed, has remaining quota)   │
   └───────────────────────────────┘
           |
           v
   Assign to Recipient
```

---

## Batch Size Behavior

| Batch Size | Available Accounts | Behavior |
|------------|-------------------|----------|
| 50 | 100 | Use 50 different accounts (1 msg each) |
| 50 | 30 | Use 30 accounts (some get 2 msgs) |
| 100 | 100 | Use all 100 accounts (1 msg each) |
| 0 (unlimited) | 100 | Use all available accounts |

---

## Additional Enhancement: Add Logging

Add logging to show the distribution:

```typescript
console.log(`[get-batch-tasks] Account distribution - 0 msgs: ${
  campaignUsableAccounts.filter(a => (accountCampaignSentToday.get(a.id) || 0) === 0).length
}, 1+ msgs: ${
  campaignUsableAccounts.filter(a => (accountCampaignSentToday.get(a.id) || 0) >= 1).length
}`);
```

---

## Summary

| Change | File | Description |
|--------|------|-------------|
| Sorting logic | `get-batch-tasks/index.ts` | Add two-level sort: messages_sent_today first, then batch_usage |
| Logging | `get-batch-tasks/index.ts` | Add account distribution logging |

This ensures:
1. Accounts with 0 messages today are always used first
2. Load is evenly distributed across ALL accounts
3. Batch size of 50 = 50 different accounts (not 10 accounts with 5 messages each)
4. Step-by-step increase in message count per account
