

## Fix: Re-uploading Pending Data Shows "Campaign Cancelled"

### What's Happening

When you try to re-upload pending recipient data (e.g., for "AP Mix Data"), the system checks all phone numbers across ALL campaigns and conversations. Since those numbers already exist (they were pending/sent in a previous campaign), every single one is flagged as a duplicate. This results in 0 new recipients being inserted.

The campaign creation flow has a safety check: if no recipients are inserted, it deletes the just-created campaign and shows **"Failed to upload recipients - campaign cancelled"**. This is working as designed for brand-new campaigns (you don't want empty campaigns), but it's confusing when you're trying to re-use data.

### Why This Happens

The deduplication is **global** -- it prevents sending to anyone who has ever been contacted in ANY campaign. So re-uploading the same phone numbers will always result in 0 inserts, even if those recipients were never successfully contacted (still pending/queued).

### Proposed Fix

**1. Improve the error message** (in `src/pages/Campaigns.tsx`)
- Instead of the vague "campaign cancelled" message, show exactly how many duplicates were found and why
- Example: "All 500 recipients were already contacted or pending in other campaigns. Campaign was not created."

**2. Exclude failed recipients from deduplication** (in `src/context/TelegramContext.tsx`)
- Currently, `pending`, `sending`, `queued`, and `sent` statuses are all treated as "already messaged"
- Change this so that **failed** recipients from previous campaigns can be re-targeted in new campaigns
- This way, re-uploading pending data that previously failed will actually insert those numbers

**3. Add a "retry failed" option for existing campaigns**
- When re-uploading to an existing campaign (not creating new), skip the deletion logic entirely
- Show a clear summary: "X inserted, Y already exist in this campaign, Z already contacted elsewhere"

### Technical Details

**File: `src/context/TelegramContext.tsx`** (uploadRecipients function, ~line 1351)
- The query fetches recipients with status `sent`, `pending`, `sending`, `queued` -- this is correct for preventing double-sends
- No code change needed here unless you want failed recipients to be re-targetable

**File: `src/pages/Campaigns.tsx`** (lines 688-709, 704-708)
- The campaign deletion on `inserted === 0` only happens during the CREATE flow, not the upload-to-existing flow
- Improve the toast message to explain WHY no recipients were inserted (all duplicates)
- Add a count of duplicates to the error message so users understand what happened

**File: `src/pages/Campaigns.tsx`** (handleUploadRecipients, ~line 776)
- The existing-campaign upload path already handles this correctly (no deletion)
- Add better feedback showing duplicate count vs inserted count

