
# Plan: Remove Legacy API Generator System

## Overview
Clean up the codebase by removing all references to the old random API generator system. The round-robin rotation system using real API credentials from `telegram_api_credentials` table is already implemented - this cleanup removes legacy code, comments, and files.

## Current State
- **Database**: Contains 10 valid API credentials with round-robin columns (usage_count, last_used_at)
- **Edge Functions**: Already using `getNextApiCredential()` from `api-helper.ts`
- **Legacy file exists**: `supabase/functions/_shared/api-generator.ts` (should be deleted)
- **Outdated comments**: Multiple files still describe "random generation" system

---

## Files to Modify

### 1. DELETE: `supabase/functions/_shared/api-generator.ts`
This file generates random fake API credentials and is no longer used. Delete entirely.

---

### 2. UPDATE: `supabase/functions/get-antibot-stats/index.ts`
Update the API system description to reflect round-robin rotation.

**Lines 22-30** - Change from:
```typescript
const dynamicApiStatus = {
  system: "Dynamic Per-Request API",
  description: "Each task gets unique api_id (8-digit) + api_hash (32-char hex)",
  capacity: "90M+ unique combinations",
  rate_limits: "None (no API reuse)",
};
```

To:
```typescript
const dynamicApiStatus = {
  system: "Round-Robin API Rotation",
  status: "active",
  description: "Tasks use real APIs from credential pool with even distribution",
  capacity: "Based on configured API count",
  rate_limits: "Even load across all APIs",
};
```

---

### 3. UPDATE: `supabase/functions/get-next-task/index.ts`
Update outdated comments about "dynamic API generation".

**Lines 572-577** - Update comment block to describe round-robin:
```typescript
// ========== ROUND-ROBIN API SYSTEM: Real APIs rotated evenly across tasks ==========
// APIs are selected from telegram_api_credentials table with lowest usage_count
// This ensures: even distribution, no overloading single API, usage tracking
const accounts = accountsUnderDailyCampaignLimit;

console.log(`[get-next-task] Using round-robin API rotation from credential pool`);
```

---

### 4. UPDATE: `supabase/functions/get-batch-tasks/index.ts`
Update outdated comments.

**Lines 523-526** - Update comment block:
```typescript
// ========== ROUND-ROBIN API SYSTEM ==========
// Each task gets an API from the credential pool using round-robin rotation
// APIs are selected by lowest usage_count for even distribution
console.log(`[get-batch-tasks] ROUND-ROBIN API: Even distribution across credential pool`);
```

---

### 5. UPDATE: `supabase/functions/process-account-upload/index.ts`
Update outdated comments.

**Lines 552-554** - Update comment:
```typescript
// Round-Robin API System: API credentials are assigned per-task from the pool
// No need to assign APIs to accounts - backend handles rotation during task dispatch
console.log(`[process-account-upload] Using round-robin API rotation (credentials from pool)`);
```

---

### 6. UPDATE: `src/pages/SetupGuide.tsx` (Python Templates)
Update comments in Python code templates to reflect round-robin system.

**config.py section (Lines 15-22)** - Update docstring:
```python
"""
TelegramCRM - Configuration

ROUND-ROBIN API SYSTEM: Each request receives API credentials from the pool.
The backend rotates through all APIs evenly (lowest usage_count first).
API credentials come in the task payload from get-next-task / get-batch-tasks.
"""
```

**client_manager.py section (Lines 30-40)** - Update docstring:
```python
"""
TelegramCRM - Client Manager (ROUND-ROBIN API SYSTEM)

BUILD: 2026-01-25-round-robin-v1

ROUND-ROBIN API CREDENTIALS:
- Each task gets API credentials from the backend pool
- APIs are rotated evenly (lowest usage first)
- API credentials come in task payload (api_id, api_hash)
- All configured APIs get equal usage distribution
```

**Lines 608-618** - Update comments in get_or_create_client:
```python
# ROUND-ROBIN API: Credentials come from backend pool (rotated evenly)
# Backend assigns API with lowest usage_count from telegram_api_credentials table
api_id = account.get("api_id")
api_hash = account.get("api_hash")

# API credentials come from task payload via round-robin selection
if not api_id or not api_hash:
    print(f"  [SKIP] {phone} - NO API CREDENTIALS IN TASK PAYLOAD")
    print(f"          -> Check API credentials exist in Settings -> API Keys")
    return None

print(f"  [API] Using pool credentials: {api_id[:4]}...{api_id[-2:]}")
```

---

## Summary of Changes

| File | Action | Description |
|------|--------|-------------|
| `_shared/api-generator.ts` | DELETE | Remove legacy random generator |
| `get-antibot-stats/index.ts` | UPDATE | Change API system description |
| `get-next-task/index.ts` | UPDATE | Fix comments (lines 572-577) |
| `get-batch-tasks/index.ts` | UPDATE | Fix comments (lines 523-526) |
| `process-account-upload/index.ts` | UPDATE | Fix comments (lines 552-554) |
| `SetupGuide.tsx` | UPDATE | Fix Python template comments |

---

## Technical Notes

- No database changes needed - the 10 real API credentials are already in place
- No functional code changes - only removing dead code and updating comments
- Edge functions will be redeployed after changes
- Python runner template changes require users to re-download the runner
