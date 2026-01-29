

# Database & Codebase Cleanup for Edge Function Consolidation

## Overview

After reviewing the codebase, I found several areas that need updating to fully align with the consolidated edge functions architecture.

## Current Status

### Edge Functions (23 → 19 currently, target: 4)

**Already Consolidated:**
- `get-batch-tasks`, `get-next-task`, `report-task-result`, `report-batch-results` → **`runner-tasks`** (DONE)

**Still Need Consolidation:**
- `start-warmup-chat` (667 lines) → should use **`warmup`**
- `stop-warmup-chat` (~100 lines) → should use **`warmup`**
- `schedule-warmup-tasks` (264 lines) → should use **`warmup`**
- `verify-sessions` (165 lines) → should merge into **`admin-api`**
- `process-account-upload` (~200 lines) → should merge into **`admin-api`**
- `send-bulk-messages` (315 lines) → should merge into **`admin-api`**
- `test-proxies` (~150 lines) → should merge into **`utilities`**
- `pause-campaign` (~80 lines) → should merge into **`admin-api`**

**Utility Functions to Consolidate:**
- `auto-spambot-check`, `detect-proxy-country`, `enforce-proxy-mapping`, `cleanup-old-chats`, `system-maintenance`, `get-antibot-stats`, `validate-first-message`, `switch-account-proxy`, `telegram-api`, `report-session-check`

## Database Changes Needed

### 1. Update Migration File Comment
The migration file `20260125193112_e439620f-5013-452c-baec-97877ba1b3aa.sql` has a comment referencing `report-batch-results` which should be updated.

### 2. Update Code Comments
Update references in edge functions to reflect new architecture.

## Frontend Updates Required

The UI currently calls these old function names that need updating:

| File | Current Call | Should Change To |
|------|-------------|-----------------|
| `src/pages/Warmup.tsx` | `start-warmup-chat` | `warmup` (POST /start) |
| `src/pages/Warmup.tsx` | `stop-warmup-chat` | `warmup` (POST /stop) |
| `src/pages/Accounts.tsx` | `verify-sessions` | `admin-api` (POST /verify-sessions) |
| `src/pages/Accounts.tsx` | `process-account-upload` | `admin-api` (POST /upload-accounts) |
| `src/pages/Proxies.tsx` | `test-proxies` | `utilities` (POST /test-proxies) |
| `src/pages/Campaigns.tsx` | `pause-campaign` | `admin-api` (POST /campaigns/pause) |

## Implementation Steps

### Phase 1: Update Frontend to Use New Endpoints
1. **Warmup.tsx** - Change `start-warmup-chat` → `warmup/start` and `stop-warmup-chat` → `warmup/stop`
2. **Accounts.tsx** - Change `verify-sessions` → `admin-api/verify-sessions` and `process-account-upload` → `admin-api/upload-accounts`
3. **Proxies.tsx** - Change `test-proxies` → `utilities/test-proxies`
4. **Campaigns.tsx** - Change `pause-campaign` → `admin-api/campaigns/pause`

### Phase 2: Enhance Consolidated Edge Functions
1. **`admin-api`** - Add missing routes:
   - `POST /verify-sessions` - Copy logic from `verify-sessions`
   - `POST /upload-accounts` - Copy logic from `process-account-upload`
   - `POST /upload-recipients` - Copy logic from `send-bulk-messages`
   - `POST /campaigns/start` - Copy logic from `send-bulk-messages`
   - `POST /campaigns/pause` - Copy logic from `pause-campaign`

2. **`utilities`** - Add missing routes:
   - `POST /test-proxies` - Copy logic from `test-proxies`
   - `POST /detect-country` - Copy logic from `detect-proxy-country`
   - `GET /antibot-stats` - Copy logic from `get-antibot-stats`

### Phase 3: Update send-bulk-messages Comment
Update the comment in `send-bulk-messages/index.ts` line 178 that references `get-next-task`.

### Phase 4: Delete Remaining Legacy Functions (After Testing)
After frontend is updated and consolidated functions are tested:
- Delete `start-warmup-chat/`
- Delete `stop-warmup-chat/`
- Delete `schedule-warmup-tasks/`
- Delete `verify-sessions/`
- Delete `process-account-upload/`
- Delete `send-bulk-messages/`
- Delete `test-proxies/`
- Delete `pause-campaign/`
- Delete `detect-proxy-country/`
- Delete `enforce-proxy-mapping/`
- Delete `cleanup-old-chats/`
- Delete `system-maintenance/`
- Delete `get-antibot-stats/`
- Delete `validate-first-message/`
- Delete `switch-account-proxy/`
- Delete `telegram-api/`
- Delete `report-session-check/`
- Delete `auto-spambot-check/`

## Summary of Changes

| Category | Action | Details |
|----------|--------|---------|
| Frontend | Update | 4 files need function call updates |
| Edge Functions | Enhance | Add routes to `admin-api` and `utilities` |
| Edge Functions | Delete | 18 legacy functions after consolidation |
| Comments | Update | 2 files have outdated comments |

## Benefits After Completion

1. **4 edge functions instead of 23** - Easier maintenance
2. **Consistent routing** - All use unified endpoint patterns
3. **Unified task format** - Same structure for all task types
4. **75% less code** - ~2,500 lines instead of ~10,000 lines

