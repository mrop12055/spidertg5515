

# Remove Database Page and Move Task Queue/Recent Errors to Dashboard

## Overview

This plan removes the Database Health page entirely and moves two key components to the Dashboard bottom:
1. **Recent Errors** - Live feed showing errors from all sources (campaigns, messages, tasks, warmup, accounts)
2. **Task Queue Management** - Tabs for managing pending Account, Import, Recipients, and Messages tasks

---

## Changes Summary

### 1. Remove Database Page and Route

| File | Action |
|------|--------|
| `src/pages/DatabaseHealth.tsx` | Delete entire file |
| `src/App.tsx` | Remove `/database` route and import |
| `src/components/layout/Sidebar.tsx` | Remove Database nav item from navigation |

### 2. Create Dashboard Components

Extract the Task Queue and Recent Errors sections into reusable components for the Dashboard:

| New Component | Purpose |
|---------------|---------|
| `src/components/dashboard/TaskQueueCard.tsx` | Task Queue Management with Account/Import/Recipients/Messages tabs |
| `src/components/dashboard/RecentErrorsCard.tsx` | Recent Errors live feed panel |

### 3. Update Dashboard

| File | Changes |
|------|---------|
| `src/pages/Dashboard.tsx` | Import and add the two new components at the bottom of the page |

---

## Technical Implementation

### Step 1: Remove Database Route (App.tsx)

```text
Remove:
- Line 14: import DatabaseHealth
- Line 53: <Route path="/database" ...> 
```

### Step 2: Remove Database Nav Item (Sidebar.tsx)

```text
Remove from navItems array (line 44):
- { icon: Database, label: 'Database', path: '/database' }
Also remove Database import from lucide-react
```

### Step 3: Create TaskQueueCard Component

New file: `src/components/dashboard/TaskQueueCard.tsx`

This component extracts lines 653-989 from DatabaseHealth.tsx including:
- All state for pending/completed tasks
- Tab structure: Account | Import | Recipients | Messages
- Table views with delete functionality
- Real-time subscription for live updates
- Clear pending tasks buttons

### Step 4: Create RecentErrorsCard Component

New file: `src/components/dashboard/RecentErrorsCard.tsx`

This component extracts lines 992-1066 from DatabaseHealth.tsx including:
- Recent errors state and fetch logic
- ScrollArea with error list
- Color-coded badges by source (Account, Campaign, Warmup, etc.)
- Live feed badge indicator

### Step 5: Update Dashboard

Add after the Running Campaigns section:

```text
{/* Task Queue & Errors Section */}
<div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
  <TaskQueueCard />
  <RecentErrorsCard />
</div>
```

### Step 6: Delete DatabaseHealth.tsx

Remove the entire file since all functionality is now in the dashboard components.

---

## Data Flow

Both new components will:
- Fetch their own data using the same queries from DatabaseHealth.tsx
- Set up their own real-time subscriptions
- Handle their own loading/refresh states

---

## UI Layout on Dashboard

```text
+------------------------------------------+
| Dashboard Header                          |
+------------------------------------------+
| Account Stats (3 cards)                   |
+------------------------------------------+
| Message Stats (3 cards)                   |
+------------------------------------------+
| Runner Status Card                        |
+------------------------------------------+
| Running Campaigns (if any)                |
+------------------------------------------+
| Task Queue Card    | Recent Errors Card   |
| (Account, Import,  | (Live error feed     |
|  Recipients, Msgs) |  from all sources)   |
+------------------------------------------+
```

---

## Files to Create

1. `src/components/dashboard/TaskQueueCard.tsx` - Task queue management panel
2. `src/components/dashboard/RecentErrorsCard.tsx` - Recent errors panel

## Files to Modify

1. `src/App.tsx` - Remove database route
2. `src/components/layout/Sidebar.tsx` - Remove Database nav item
3. `src/pages/Dashboard.tsx` - Add new components

## Files to Delete

1. `src/pages/DatabaseHealth.tsx` - No longer needed

