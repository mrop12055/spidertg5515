

## Fix: Completely Remove Deduplication Check on Recipient Upload

### Problem
The deduplication logic is running in **three separate code paths**, but the `skipDedup` flag was only wired up to one of them. The "already messaged (skipped)" message keeps appearing because:

1. **Campaign creation (multi-seat)** at line 686 calls `uploadRecipients` without `skipDedup` -- always deduplicates
2. **Campaign creation (single-seat)** at line 704 calls `uploadRecipients` without `skipDedup` -- always deduplicates
3. **Upload dialog for existing campaign** at line 779 passes `skipDedup` correctly -- but the user still sees duplicates because the issue is in paths 1 and 2

### Solution
Remove the global cross-campaign deduplication logic entirely from the `uploadRecipients` function. The function will only filter duplicates **within the current upload batch** (to avoid inserting the same phone number twice in one go).

### Changes

**File: `src/context/TelegramContext.tsx`**

Replace the entire `uploadRecipients` function body. Remove:
- The `skipDedup` parameter (no longer needed)
- The `fetchAllSentRecipients` function that queries all campaign_recipients
- The `fetchAllConversations` function that queries conversations with first_message_sent
- The `alreadyMessaged` Set and its filtering logic

Keep only:
- Within-batch dedup (prevent inserting the same phone number twice in one upload)
- Chunked insert logic (batches of 1000)
- Toast notifications

**File: `src/pages/Campaigns.tsx`**

- Remove the `skipDedup` state variable
- Remove the checkbox UI for "Skip deduplication"
- Remove `skipDedup` from the `handleUploadRecipients` call
- The three `uploadRecipients` calls (lines 686, 704, 779) no longer need any dedup parameter

### Technical Details

The simplified `uploadRecipients` function will:
1. Accept `campaignId` and `recipients` (no `skipDedup` parameter)
2. Deduplicate within the batch only (using a `Set`)
3. Insert in chunks of 1000
4. Show a toast with the count of inserted recipients
5. Return `{ inserted, duplicates }` for the campaign-creation validation logic (which deletes campaigns if zero recipients were inserted)

