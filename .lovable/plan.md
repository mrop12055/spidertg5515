

# Ultra-Simplified Edge Functions Architecture

## Current State Analysis

After reviewing all edge functions and database, I found **23 separate edge functions** that can be consolidated. Just like we simplified the Python runner from complex handlers to 3 core functions, the edge functions follow the same pattern:

### Current Edge Functions (23 total)

| Function | Lines | Core Purpose |
|----------|-------|--------------|
| `get-batch-tasks` | 1534 | Get tasks for runner |
| `get-next-task` | 2346 | Get single task for runner |
| `report-task-result` | 2559 | Report task completion |
| `report-batch-results` | 839 | Report batch completion |
| `send-bulk-messages` | 315 | Campaign management |
| `start-warmup-chat` | 667 | Start warmup session |
| `stop-warmup-chat` | ~100 | Stop warmup session |
| `schedule-warmup-tasks` | 264 | Schedule warmup tasks |
| `telegram-api` | 254 | CRUD operations |
| `report-session-check` | 200 | Session check result |
| `verify-sessions` | 165 | Verify session files |
| `auto-spambot-check` | 136 | Schedule spambot checks |
| `switch-account-proxy` | ~90 | Report proxy errors |
| `validate-first-message` | ~120 | Validate message content |
| `pause-campaign` | ~80 | Pause campaign |
| `process-account-upload` | ~200 | Process account uploads |
| `test-proxies` | ~150 | Test proxy connections |
| `detect-proxy-country` | ~100 | Detect proxy country |
| `enforce-proxy-mapping` | ~100 | Enforce proxy rules |
| `cleanup-old-chats` | ~100 | Cleanup old data |
| `system-maintenance` | ~150 | System maintenance |
| `get-antibot-stats` | ~80 | Get antibot statistics |
| `_shared/api-helper.ts` | ~200 | Shared helpers |

**Total: ~10,000+ lines across 23 functions**

## Core Insight

All these functions reduce to **4 core operations**:

| Core Operation | Functions to Merge |
|----------------|-------------------|
| **GET_TASKS** | `get-batch-tasks`, `get-next-task` |
| **REPORT_RESULT** | `report-task-result`, `report-batch-results`, `report-session-check` |
| **MANAGE_DATA** | `telegram-api`, `send-bulk-messages`, `verify-sessions`, `process-account-upload` |
| **WARMUP** | `start-warmup-chat`, `stop-warmup-chat`, `schedule-warmup-tasks` |

## Proposed Simplified Architecture

### Phase 1: Merge Task Functions

**Before:** 2 functions (3880 lines total)
- `get-batch-tasks` (1534 lines)
- `get-next-task` (2346 lines)

**After:** 1 function (800 lines)
- `runner-tasks` with routes:
  - `POST /runner-tasks/get` - Get batch of tasks
  - `POST /runner-tasks/report` - Report results
  - `POST /runner-tasks/heartbeat` - Runner heartbeat

The logic is the same whether getting 1 task or 100 - the Python runner now uses batch mode anyway.

### Phase 2: Merge Result Reporting

**Before:** 3 functions (3598 lines total)
- `report-task-result` (2559 lines)
- `report-batch-results` (839 lines)
- `report-session-check` (200 lines)

**After:** Merged into `runner-tasks/report`

All result types (send, warmup, session check, account action) flow through one handler with a `result_type` field.

### Phase 3: Consolidate Warmup

**Before:** 3 functions (1031 lines total)
- `start-warmup-chat` (667 lines)
- `stop-warmup-chat` (~100 lines)
- `schedule-warmup-tasks` (264 lines)

**After:** 1 function (400 lines)
- `warmup` with routes:
  - `POST /warmup/start` - Start warmup session
  - `POST /warmup/stop` - Stop warmup session
  - `POST /warmup/schedule` - Schedule tasks

### Phase 4: Consolidate Management APIs

**Before:** Multiple scattered functions
- `telegram-api` (254 lines)
- `send-bulk-messages` (315 lines)
- `verify-sessions` (165 lines)
- `process-account-upload` (~200 lines)

**After:** 1 function (600 lines)
- `admin-api` with routes:
  - `GET/POST/PATCH/DELETE /admin-api/accounts`
  - `GET/POST/DELETE /admin-api/proxies`
  - `GET/POST /admin-api/campaigns`
  - `POST /admin-api/campaigns/start`
  - `POST /admin-api/campaigns/upload-recipients`
  - `POST /admin-api/verify-sessions`

## New Architecture Summary

```text
BEFORE (23 functions, ~10,000 lines):
├── get-batch-tasks (1534 lines)
├── get-next-task (2346 lines)
├── report-task-result (2559 lines)
├── report-batch-results (839 lines)
├── report-session-check (200 lines)
├── send-bulk-messages (315 lines)
├── start-warmup-chat (667 lines)
├── stop-warmup-chat (~100 lines)
├── schedule-warmup-tasks (264 lines)
├── telegram-api (254 lines)
├── verify-sessions (165 lines)
├── ... and 12 more functions

AFTER (4 functions, ~2,500 lines):
├── runner-tasks/     (800 lines)
│   ├── POST /get     - Get tasks (batch or single)
│   ├── POST /report  - Report ALL result types
│   └── POST /heartbeat
│
├── warmup/           (400 lines)
│   ├── POST /start
│   ├── POST /stop
│   └── POST /schedule
│
├── admin-api/        (800 lines)
│   ├── /accounts (CRUD)
│   ├── /proxies (CRUD)
│   ├── /campaigns (CRUD + start + upload)
│   └── /verify-sessions
│
└── utilities/        (500 lines)
    ├── /test-proxies
    ├── /detect-country
    ├── /cleanup
    └── /maintenance
```

## Unified Task & Result Format

### Task Request (Python Runner to Edge)
```typescript
POST /runner-tasks/get
{
  "runner": "unified",      // Single runner type now
  "batch_size": 100,        // How many tasks to fetch
  "account_ids": ["..."]    // Optional: filter by accounts
}
```

### Task Response (Edge to Python Runner)
```typescript
{
  "tasks": [
    {
      "task_type": "send",           // send, warmup_chat, add_contact, spambot_check, etc.
      "task_id": "uuid",
      "account": { id, session_data, proxy, fingerprint... },
      "recipient": { phone, telegram_id, username },
      "content": "message text",
      "media_url": null
    }
  ],
  "accounts": [...],                 // All accounts for incoming message listeners
  "delay_after": 3
}
```

### Result Report (Python Runner to Edge)
```typescript
POST /runner-tasks/report
{
  "results": [
    {
      "task_type": "send",           // Same types as tasks
      "task_id": "uuid",
      "account_id": "uuid",
      "success": true,
      "error": null,
      "recipient_telegram_id": 123456789,  // Resolved ID
      "content": "actual sent content"
    }
  ]
}
```

## Database Simplification

The database is already well-structured, but we can add a unified task queue:

### New Table: `task_queue`
| Column | Type | Purpose |
|--------|------|---------|
| id | uuid | Primary key |
| task_type | text | send, warmup, spambot_check, etc. |
| account_id | uuid | Account to perform task |
| status | text | pending, sending, sent, failed |
| payload | jsonb | Task-specific data |
| result | jsonb | Result data |
| created_at | timestamp | When created |
| claimed_at | timestamp | When runner claimed |
| completed_at | timestamp | When completed |

This replaces the need for separate:
- `messages` table's pending outgoing messages
- `campaign_recipients` table's pending sends
- `warmup_messages` table's pending warmup
- `account_check_tasks` table

### Migration Path

1. Keep existing tables working (backward compatible)
2. New unified queue handles new tasks
3. Gradually migrate features to use unified queue

## Implementation Order

1. **Create `runner-tasks` function** - Merge get-batch-tasks + get-next-task + report-task-result + report-batch-results
2. **Create `warmup` function** - Merge warmup functions
3. **Create `admin-api` function** - Merge management APIs
4. **Create `utilities` function** - Merge utility functions
5. **Update Python runner** - Point to new endpoints
6. **Delete old functions** - After testing

## Files to Create/Modify

| Action | File |
|--------|------|
| Create | `supabase/functions/runner-tasks/index.ts` |
| Create | `supabase/functions/warmup/index.ts` |
| Create | `supabase/functions/admin-api/index.ts` |
| Create | `supabase/functions/utilities/index.ts` |
| Update | `supabase/config.toml` - Add new function configs |
| Update | `src/pages/SetupGuide.tsx` - Update Python runner endpoints |
| Delete | 19 old edge functions (after migration complete) |

## Benefits

1. **75% Less Code**: ~2,500 lines instead of ~10,000 lines
2. **4 Functions Instead of 23**: Easier to maintain and debug
3. **Unified Task Format**: Same structure for all task types
4. **Single Report Endpoint**: All results flow through one handler
5. **Consistent Patterns**: Same routing pattern across all functions
6. **Easier Scaling**: One place to optimize task distribution

## Python Runner Integration

The simplified Python runner we already created works perfectly with this:

```python
# Current (works with new endpoints)
async def main_loop():
    while RUNNING:
        # GET tasks from unified endpoint
        response = await fetch(f"{SUPABASE_URL}/functions/v1/runner-tasks/get", {
            "runner": "unified",
            "batch_size": 100
        })
        
        tasks = response["tasks"]
        results = []
        
        # Process all tasks with unified handlers
        for task in tasks:
            result = await process(task)  # send_message() or account_action()
            results.append(result)
        
        # REPORT all results to unified endpoint
        await fetch(f"{SUPABASE_URL}/functions/v1/runner-tasks/report", {
            "results": results
        })
```

