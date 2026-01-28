

# Dead Code Cleanup Plan

## Executive Summary

After deep investigation of the entire codebase, I found **confirmed dead code** that has zero references and can be safely removed. This includes 1 edge function, 1 unused hook file, and several edge functions that are not called from anywhere in the codebase.

---

## Phase 1: Confirmed Dead Code (Zero References)

### 1.1 Dead Edge Function: `telegram-api` (254 lines)

**Location:** `supabase/functions/telegram-api/index.ts`

**Evidence:**
- Zero search results for "telegram-api" in the `src/` directory
- Not called from any Python runners in SetupGuide.tsx
- Not called from any frontend components
- Not referenced in any other edge functions
- Provides duplicate CRUD functionality that the frontend already does directly via Supabase client

**What it does:** A REST API wrapper for basic CRUD operations on accounts, proxies, conversations, messages, and campaigns.

**Why dead:** The frontend uses direct Supabase client calls (e.g., `supabase.from('telegram_accounts').select()`) instead of this edge function.

**Action:** Delete the entire folder `supabase/functions/telegram-api/`

---

### 1.2 Dead Hook File: `useDatabase.ts` (447 lines)

**Location:** `src/hooks/useDatabase.ts`

**Evidence:**
- Zero imports of `useDatabase` anywhere in the codebase
- Zero usage of its exported interfaces (`DbTelegramAccount`, `DbProxy`, `DbConversation`, `DbMessage`, `DbCampaign`)
- The application uses dedicated hooks instead: `useAccounts`, `useProxies`, `useCampaigns`, `useConversations`, `useMessages`

**What it does:** A monolithic hook that fetches all data types and provides CRUD operations.

**Why dead:** The codebase has evolved to use specialized hooks (performance optimization) instead of this all-in-one approach.

**Action:** Delete `src/hooks/useDatabase.ts`

---

## Phase 2: Edge Functions with Zero Frontend References (Require Careful Verification)

These edge functions have **no frontend references** but may be:
- Called by cron jobs (scheduled)
- Called by external systems
- Called internally by other edge functions

### 2.1 `enforce-proxy-mapping` - NEEDS VERIFICATION

**Evidence:**
- Zero references in `src/` directory
- Only references are in its own file (log messages)

**Purpose:** Redistributes proxies across accounts for 1:1 mapping.

**Status:** May be triggered by a cron job or admin script. Verify before removal.

### 2.2 `get-antibot-stats` - NEEDS VERIFICATION

**Evidence:**
- Zero references in `src/` directory
- Only references are in its own file

**Purpose:** Returns anti-ban system statistics.

**Status:** May be called by external monitoring. Verify before removal.

### 2.3 `regenerate-fingerprints` - NEEDS VERIFICATION

**Evidence:**
- Zero references in `src/` directory

**Purpose:** Regenerates device fingerprints for accounts.

**Status:** May be triggered by admin scripts. Verify before removal.

### 2.4 `schedule-warmup-tasks` - NEEDS VERIFICATION

**Evidence:**
- Zero references in `src/` directory

**Purpose:** Schedules 14-day warmup tasks for accounts.

**Status:** Likely triggered by cron job. **DO NOT DELETE** - critical for warmup system.

### 2.5 `detect-proxy-country` - NEEDS VERIFICATION

**Evidence:**
- Zero references in `src/` directory

**Purpose:** Detects proxy geographic location via IP lookup.

**Status:** May be called by `test-proxies`. Verify before removal.

### 2.6 `switch-account-proxy` - LIKELY DEAD

**Evidence:**
- Zero references in `src/` directory
- Zero references in Python runners (SetupGuide.tsx)
- The code documents "NO auto-switching - admin must fix in dashboard"

**Purpose:** Originally for automatic proxy switching, now just marks proxies as error.

**Status:** Appears unused. The Python runners handle proxy errors locally and report via `report-session-check` or `report-task-result` instead.

### 2.7 `validate-first-message` - LIKELY DEAD

**Evidence:**
- Zero references in `src/` directory
- Zero references in Python runners (SetupGuide.tsx)

**Purpose:** Validates first messages for spam patterns.

**Status:** Appears unused. Message validation may have been moved elsewhere or deprecated.

---

## Phase 3: Empty Database Tables (Zero Rows)

These tables have **zero data** and minimal code references:

| Table | Row Count | References | Status |
|-------|-----------|------------|--------|
| `vps_connections` | 0 | Only in types.ts | Legacy - VPS management |
| `vps_commands` | 0 | Only in types.ts | Legacy - VPS commands |
| `scheduled_interactions` | 0 | Delete operations in Accounts.tsx | Legacy warmup system |
| `maturation_tasks` | 0 | Delete operations in Accounts.tsx, Logs.tsx | Legacy warmup system |
| `interaction_scheduler` | 0 | Delete operations in Accounts.tsx, used by schedule-warmup-tasks | Part of warmup system |

**Recommendation:** Keep these tables for now. They may be used by the warmup system or future features. The deletion references in Accounts.tsx are for cleanup during account deletion.

---

## Implementation Plan

### Step 1: Delete Confirmed Dead Code

1. **Delete `supabase/functions/telegram-api/`** - 254 lines of dead edge function code
2. **Delete `src/hooks/useDatabase.ts`** - 447 lines of unused hook code

**Total: ~701 lines of dead code removed**

### Step 2: Flag for Manual Verification (Do NOT delete yet)

These need admin verification before deletion:
- `switch-account-proxy` - Check if called by external systems
- `validate-first-message` - Check if called by external systems
- `enforce-proxy-mapping` - Check if used by cron jobs
- `get-antibot-stats` - Check if used by monitoring
- `regenerate-fingerprints` - Check if used by admin scripts

---

## Technical Details

### Files to Delete

```text
supabase/functions/telegram-api/           # Dead edge function
  └── index.ts                             # 254 lines

src/hooks/useDatabase.ts                   # Dead hook (447 lines)
```

### Risk Assessment

| Item | Risk | Reason |
|------|------|--------|
| Delete `telegram-api` | Zero | No references anywhere |
| Delete `useDatabase.ts` | Zero | No imports anywhere |
| Delete other edge functions | Medium | May have external callers |
| Delete empty tables | Low | Part of schema, may break migrations |

---

## Summary

**Confirmed Safe to Delete:**
- `supabase/functions/telegram-api/index.ts` (254 lines)
- `src/hooks/useDatabase.ts` (447 lines)

**Total Dead Code Removed:** ~701 lines

**Requires Verification:**
- 6 edge functions with zero frontend references (may be cron/admin triggered)
- 5 empty database tables (may be needed for schema integrity)

