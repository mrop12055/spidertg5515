
## Plan: Simplify Runner Heartbeat to Show Single "Unified Runner" Card

### Problem
The Python runner currently sends a single heartbeat as `"unified"`, but the UI displays 4 separate runner cards (Campaign, LiveChat, Account, Warmup). Since `"unified"` doesn't match any of these keys, the status display is broken.

### Solution
Since you're using a single unified runner that handles ALL functions (campaigns, livechat, accounts, warmup), we should:

1. **Update UI to show a single "Unified Runner" card** instead of 4 separate runners
2. **Map `unified` runner heartbeat to display properly**

---

## Changes

### 1. Update Runner Status Hook
**File:** `src/hooks/useRunnerStatus.ts`

- Change `runnerNames` to only have one entry: `unified: 'Unified Runner'`
- Update `normalizeRunnerKey()` to map all legacy names to `unified`
- This will show a single card that tracks the unified runner's heartbeat

### 2. Update Runner Status Card UI
**File:** `src/components/dashboard/RunnerStatus.tsx`

- Update `runnerIcons` to show a single "Unified" runner with a combined icon
- Update the grid to show just 1 card (or keep the current responsive layout)
- Add a subtitle showing what the unified runner handles: "Campaigns, LiveChat, Accounts, Warmup"

### 3. Clean Up Database (Optional)
- Remove old/legacy heartbeat entries like `livechat` since they're no longer used
- Only keep the `unified` heartbeat entry

---

## Expected Result

| Before | After |
|--------|-------|
| 4 separate runner cards (all offline) | 1 "Unified Runner" card |
| 0/4 Online displayed | 1/1 Online when runner is active |
| Confusing status | Clear status |

---

## Technical Details

**useRunnerStatus.ts changes:**
- Replace 4-runner map with single unified runner
- Simplify normalizeRunnerKey to always return `unified`

**RunnerStatus.tsx changes:**
- Single card with combined functionality list
- Icon: Activity or Server icon
- Color: Primary/blue
- Functions: "Campaigns, LiveChat, Accounts, Warmup"
