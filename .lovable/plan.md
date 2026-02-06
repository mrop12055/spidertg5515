
# Plan: Move 17 Accounts to Inactive Tab

## Overview
Update the status of 17 specified accounts from `active` to `disconnected` so they appear in the "Inactive" tab on the Accounts page.

## Accounts to Update
All 17 phone numbers have been verified in the database:
- +916370498234, +917000311752, +917001494297, +917057633145
- +917310093074, +917671939028, +917799499396, +918106569928
- +918757437794, +918812817586, +919043020817, +919053305952  
- +919120796233, +919161106690, +919653299128, +919735504114
- +919767156342

## Implementation

### Step 1: Database Migration
Create a SQL migration to update the status of these accounts:

```sql
UPDATE telegram_accounts
SET 
  status = 'disconnected',
  auto_disabled = true,
  disabled_reason = 'Manually moved to inactive'
WHERE phone_number IN (
  '+916370498234', '+917000311752', '+917001494297', '+917057633145',
  '+917310093074', '+917671939028', '+917799499396', '+918106569928',
  '+918757437794', '+918812817586', '+919043020817', '+919053305952',
  '+919120796233', '+919161106690', '+919653299128', '+919735504114',
  '+919767156342'
);
```

This will:
- Set status to `disconnected` (which displays in the "Inactive" tab)
- Mark them as `auto_disabled = true` to prevent automatic re-activation
- Add a reason explaining why they were disabled

### Expected Result
After applying the migration:
- All 17 accounts will appear in the **Inactive** tab
- They will no longer be used for campaigns or LiveChat
- They can be reactivated later by selecting them and using "Set to Active" from the bulk actions menu

---

## Technical Notes
- The Accounts page filters `status = 'disconnected'` for the Inactive tab
- The existing `handleBulkStatusChange` function in Accounts.tsx already handles this flow for manual UI selection
- This migration achieves the same result via direct database update
