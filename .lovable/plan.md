
# UI Reorganization Plan: Accounts Page Actions

## Overview
This plan reorganizes the Accounts page toolbar to consolidate action buttons into a cleaner layout. The "Actions" dropdown will be moved next to the "Filters" button, and the standalone "Sync Profile", "Session Check", and "Export" buttons will be moved inside the Actions dropdown.

## Current Layout
```text
+--------------------------------------------------+
| Bulk Actions Bar (Card)                          |
| [X selected] | [Sync Profile] [Session Check]    |
|              [Export] [Actions ▼] ... [Clear]    |
+--------------------------------------------------+
| [Search...] [Groups ▼] [Filters ▼]               |
+--------------------------------------------------+
```

## New Layout
```text
+--------------------------------------------------+
| Bulk Actions Bar (Card)                          |
| [X selected] | [Select All Tab] [Clear]          |
+--------------------------------------------------+
| [Search...] [Groups ▼] [Filters ▼] [Actions ▼]   |
+--------------------------------------------------+
```

The Actions dropdown will now include:
- Sync Profile (moved from standalone button)
- Session Check (moved from standalone button)
- Export (moved from standalone button)
- (separator)
- Change Name
- Change Profile Picture
- Privacy Settings
- Change Password
- Logout Other Sessions
- SpamBot Check
- Change Status (submenu)
- (separator)
- Assign Tags
- Remove All Tags
- (separator)
- Assign Proxy
- Remove Proxy
- (separator)
- Delete Selected

## Technical Changes

### File: `src/pages/Accounts.tsx`

**Step 1: Remove standalone buttons from Bulk Actions Bar**
Remove these three buttons from inside the Card (lines ~2713-2728):
- `Sync Profile` button
- `Session Check` button  
- `Export` button

Also remove the current `Actions` dropdown from the Bulk Actions Bar.

**Step 2: Move Actions dropdown to the Search/Filters row**
Add the `Actions` dropdown button right after the `Filters` dropdown button (around line 3092), keeping it in the same row with Search and Filters.

**Step 3: Add buttons as dropdown menu items**
Add three new items at the top of the Actions dropdown menu:
- "Sync Profile" with RefreshCw icon
- "Session Check" with Shield icon
- "Export" with Download icon
- Then a separator before the existing items

**Step 4: Simplify the Bulk Actions Bar**
The bar will now only show:
- Selected count badge
- "Select All in Tab" button (optional, if exists)
- "Clear" button

This makes the top bar much simpler and moves all actions to a consistent location next to filters.

## Benefits
- Cleaner, less cluttered UI
- All actions consolidated in one dropdown
- Filters and Actions are logically grouped together
- Bulk Actions bar becomes minimal and focused on selection state only
