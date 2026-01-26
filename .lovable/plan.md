
# UI Cleanup: Remove Refresh Buttons and Simplify Various Sections

## Summary of Changes

This plan removes refresh buttons from multiple pages, simplifies the proxy filters, removes the health monitoring section, cleans up the database page, and removes the cleanup tab from settings.

---

## 1. Dashboard - Remove Refresh Button

**File:** `src/pages/Dashboard.tsx`

**Current:** Lines 48-65 contain a refresh button in the PageHeader action prop

**Change:** Remove the entire `action` prop from PageHeader (the refresh button and syncing indicator)

---

## 2. Accounts - Remove Refresh Button

**File:** `src/pages/Accounts.tsx`

**Current:** Lines 2548-2551 contain a refresh button in the PageHeader action prop

**Change:** Remove the refresh button from the action div (keep the Add Accounts dialog button if present)

---

## 3. Proxies - Simplify Error Display and Remove Health Monitoring

**File:** `src/pages/Proxies.tsx`

### 3a. Remove "With Errors" and "Slow" stat cards, keep only "Error" status filter

**Current:** There are 3 error-related stat cards:
- Line 1082-1098: "Error" status card (proxies with status='error')
- Line 1133-1148: "With Errors" card (proxies that had errors today)
- Line 1150-1166: "Slow" card (proxies with response time >300ms)

**Change:** Remove "With Errors" and "Slow" cards. Keep only the "Error" status card at line 1082-1098.

### 3b. Remove the "with_errors" option from usage filter dropdown

**Current:** Line 1004 has `<SelectItem value="with_errors">With Errors</SelectItem>`

**Change:** Remove this select item

### 3c. Remove Refresh button from filters

**Current:** Lines 1007-1010 contain a Refresh button

**Change:** Remove the refresh button

### 3d. Remove Health Monitoring Card

**Current:** Lines 1169-1216 contain the "Health Monitoring" card with auto health check toggle

**Change:** Remove the entire Health Monitoring card component

---

## 4. DatabaseHealth - Remove Multiple Items

**File:** `src/pages/DatabaseHealth.tsx`

### 4a. Remove Refresh Button from PageHeader

**Current:** Lines 638-642 contain refresh button in action prop

**Change:** Remove the entire `action` prop from PageHeader

### 4b. Remove System Overview Stats (Active Accounts, Restricted, Active Proxies, Conversations)

**Current:** Lines 653-682 contain 4 StatCards for Active Accounts, Restricted, Active Proxies, Conversations

**Change:** Remove the entire grid of StatCards

### 4c. Remove Pending Queue Section

**Current:** Lines 684-746 contain the "Pending Queue" section showing Account, Import, Recipients, and Stuck counts

**Change:** Remove the entire Pending Queue section

---

## 5. Settings - Remove Cleanup Tab

**File:** `src/pages/Settings.tsx`

### 5a. Remove Cleanup Tab Trigger

**Current:** Lines 135-138 contain the Cleanup tab trigger

**Change:** Remove the Cleanup tab trigger

### 5b. Remove Cleanup TabsContent

**Current:** Lines 230-289 contain the entire Cleanup TabsContent

**Change:** Remove the entire Cleanup tab content

### 5c. Update TabsList Grid

**Current:** Line 126 has `grid-cols-4`

**Change:** Change to `grid-cols-3` since we're removing one tab

### 5d. Remove Cleanup-Related State and Functions

**Current:** Lines 30, 60-62, and 77-91 contain cleanup-related state and functions

**Change:** Remove `isCleaningUp` state, `updateCleanupSettings` function, and `handleManualCleanup` function

---

## Technical Details

### Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Dashboard.tsx` | Remove refresh button from PageHeader action |
| `src/pages/Accounts.tsx` | Remove refresh button (keep Add Accounts) |
| `src/pages/Proxies.tsx` | Remove "With Errors" card, "Slow" card, refresh button, health monitoring section |
| `src/pages/DatabaseHealth.tsx` | Remove refresh button, system overview stats, pending queue section |
| `src/pages/Settings.tsx` | Remove cleanup tab and related state/functions |

### State/Variables to Clean Up

**Dashboard.tsx:**
- Remove `isRefreshing` state
- Remove `handleRefresh` function
- Remove unused imports: `RefreshCw`, `Loader2`

**Proxies.tsx:**
- Remove `slowFilter` state variable
- Remove `autoHealthCheck`, `healthCheckInterval`, `lastHealthCheck` state variables
- Remove health check localStorage effects
- Remove health check interval effect
- Remove unused imports related to health monitoring

**Settings.tsx:**
- Remove `isCleaningUp` state
- Remove `updateCleanupSettings` helper function
- Remove `handleManualCleanup` function
- Remove `Calendar` and `Trash2` from imports

---

## Impact

- Pages will still auto-refresh via React Query's background refetching and realtime subscriptions
- Reduces visual clutter and removes redundant controls
- Simplifies the proxy error display to show only the status-based "Error" count
- Settings page becomes more focused with 3 tabs instead of 4
