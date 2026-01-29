# Unified Messaging & Account Actions Architecture

## Status: ✅ IMPLEMENTED

## Architecture Overview

```text
runner-tasks/get fetches:
├── campaign_recipients (send tasks)
├── messages (livechat tasks)
├── warmup_messages (warmup send tasks)
└── account_check_tasks (ALL account actions) ✅ ADDED

runner-tasks/report handles:
├── send results → update messages/campaign_recipients
├── warmup results → update warmup_messages/warmup_pairs
└── account_action results → update account_check_tasks + telegram_accounts ✅ ADDED
```

## Supported Account Action Types

The following task types are now fetched and processed:

| Task Type | Description | DB Updates on Success |
|-----------|-------------|----------------------|
| `change_name` | Update first/last name | `first_name`, `last_name` |
| `change_photo` | Update profile picture | `avatar_url` |
| `change_username` | Update username | `username` |
| `sync_profile` / `get_me` | Sync profile from Telegram | `first_name`, `last_name`, `username`, `telegram_id` |
| `spambot_check` | Check spambot status | `spambot_status`, `last_spambot_check` |
| `session_check` | Verify session is valid | `status: active` |
| `privacy_settings` | Update privacy settings | Task result only |
| `change_password` | Update 2FA password | Task result only |
| `add_contact` / `delete_contact` | Manage contacts | Task result only |
| `block_contact` / `unblock_contact` | Block management | Task result only |
| `join_channel` / `leave_channel` | Channel membership | Task result only |

## Task Flow

```text
USER ACTION (Accounts page):
1. User selects accounts, clicks action (e.g., "Change Name")
2. Frontend inserts tasks into account_check_tasks (status: pending)
   - result field contains JSON with task params: {"first_name": "John", "last_name": "Doe"}
3. Toast shows "Queued action for X accounts"

PYTHON RUNNER:
4. Calls runner-tasks/get 
5. Gets tasks with task_type and task_data parsed from result field
6. Python account_action() executes the action
7. Reports result to runner-tasks/report

RESULT PROCESSING:
8. Edge function updates account_check_tasks (status: completed/failed)
9. Edge function updates telegram_accounts with relevant fields
10. Logs page shows completion
```

## Files Modified

- `supabase/functions/runner-tasks/index.ts`
  - Added `ACCOUNT_ACTION_TYPES` constant with 22 supported types
  - Added `isAccountActionType()` helper function
  - Added account_check_tasks fetching in `handleGetTasks()`
  - Added account action result handling in `handleReportResults()`
  - Added failure handling for account actions with status updates

## Consolidation Summary

| Before | After |
|--------|-------|
| 23 edge functions | 4 core functions |
| Account actions never processed | Full account action support |
| Scattered logic | Unified task/report flow |
