

# Unified Messaging & Account Actions Architecture Plan

## Understanding Your Workflow

Based on your description, your main workflow is:

1. **Send/Receive Messages** (Chat & Seats pages) - reply to existing conversations
2. **Send Bulk Messages** (Campaigns page) - outreach to new recipients
3. **Account Actions** (Accounts page) - change name, profile picture, session check, privacy update, profile sync, 2FA change
4. **Warmup** - also sends/receives messages (should reuse same logic)

## Current Architecture Analysis

### What Exists Today

```text
MESSAGING (3 separate task sources):
├── Campaign Messages → campaign_recipients table → runner-tasks/get → Python send_message()
├── Livechat Messages → messages table → runner-tasks/get → Python send_message()  
└── Warmup Messages → warmup_messages table → runner-tasks/get → Python send_message()

ACCOUNT ACTIONS (gap found):
├── UI creates tasks → account_check_tasks table (insert)
└── Python runner ← NO ROUTE EXISTS to fetch these tasks!

RESULT: Account actions are queued but never picked up for processing
```

### Critical Gap Found

The `account_check_tasks` table stores queued actions like:
- `change_name`, `change_photo`, `spambot_check`, `session_check`
- `privacy_settings`, `change_password`, `sync_profile`, `logout_sessions`

But the `runner-tasks/get` endpoint doesn't fetch these tasks, so they sit in the database unprocessed.

## Proposed Solution

### Core Principle

**All messaging is the same operation** - whether from Campaign, Conversation, or Warmup:
- Python: `send_message(client, recipient, content, media)` 

**All account actions are the same operation**:
- Python: `account_action(client, action_type, params)`

### Architecture Changes

```text
BEFORE (current):
├── runner-tasks/get fetches:
│   ├── campaign_recipients (send tasks)
│   ├── messages (livechat tasks)  
│   └── warmup_messages (warmup tasks)
│   └── [MISSING: account_check_tasks]

AFTER (proposed):
├── runner-tasks/get fetches:
│   ├── campaign_recipients (send tasks)
│   ├── messages (livechat tasks)
│   ├── warmup_messages (warmup send tasks)
│   └── account_check_tasks (ALL account actions)
│
└── runner-tasks/report handles:
    ├── send results → update messages/campaign_recipients/warmup_messages
    └── account_action results → update account_check_tasks + telegram_accounts
```

## Implementation Plan

### Phase 1: Add Account Actions to runner-tasks/get

**File: `supabase/functions/runner-tasks/index.ts`**

Add a new section after WARMUP TASKS that fetches pending account actions:

```typescript
// ===== ACCOUNT ACTION TASKS =====
if (runner === "unified" || runner === "account_actions") {
  const { data: actionTasks } = await supabase
    .from("account_check_tasks")
    .select(`*, account:telegram_accounts!inner(*, proxies!fk_proxy(*))`)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(batch_size);

  if (actionTasks?.length > 0) {
    for (const task of actionTasks) {
      const account = task.account;
      if (!account?.session_data || !account?.proxies?.status === 'active') continue;
      
      const creds = await getApiCredentialsForAccount(supabase, account);
      if (!creds) continue;
      
      // Parse result field for task-specific data
      let taskData = {};
      try { taskData = JSON.parse(task.result || '{}'); } catch {}

      tasks.push({
        task_type: task.task_type,  // change_name, change_photo, spambot_check, etc.
        task_id: task.id,
        account: {
          id: account.id,
          phone_number: account.phone_number,
          session_data: account.session_data,
          // ...all fingerprint fields
          api_id: creds.api_id,
          api_hash: creds.api_hash,
        },
        proxy: account.proxies,
        task_data: taskData,  // Contains first_name, last_name, photo_url, etc.
      });

      // Mark as in_progress
      await supabase.from("account_check_tasks")
        .update({ status: "in_progress", updated_at: nowIso })
        .eq("id", task.id);
    }
  }
}
```

### Phase 2: Add Account Action Result Handling

**File: `supabase/functions/runner-tasks/index.ts`**

Add handling in `handleReportResults` for account actions:

```typescript
// Handle account action results
const accountActionTypes = [
  "change_name", "change_photo", "change_bio", "change_username",
  "spambot_check", "session_check", "sync_profile",
  "privacy_settings", "change_password", "logout_sessions",
  "add_contact", "block_contact", "join_channel"
];

if (accountActionTypes.includes(taskType)) {
  if (r.success) {
    await supabase.from("account_check_tasks")
      .update({ 
        status: "completed", 
        completed_at: now,
        result: JSON.stringify(r.data || r)
      })
      .eq("id", r.task_id);
    
    // Update account fields based on action type
    if (taskType === "change_name" && r.first_name) {
      await supabase.from("telegram_accounts")
        .update({ first_name: r.first_name, last_name: r.last_name })
        .eq("id", r.account_id);
    }
    else if (taskType === "sync_profile") {
      await supabase.from("telegram_accounts")
        .update({ 
          first_name: r.first_name,
          last_name: r.last_name,
          username: r.username,
          telegram_id: r.telegram_id
        })
        .eq("id", r.account_id);
    }
    else if (taskType === "spambot_check") {
      await supabase.from("telegram_accounts")
        .update({ spambot_status: r.status, last_spambot_check: now })
        .eq("id", r.account_id);
    }
    // ... handle other action types
  } else {
    await supabase.from("account_check_tasks")
      .update({ status: "failed", result: r.error, completed_at: now })
      .eq("id", r.task_id);
  }
}
```

### Phase 3: Simplify Warmup to Use Same Send Logic

Currently warmup has a separate `warmup_messages` table. This is fine, but the Python runner already uses the same `send_message()` function for everything. The architecture is:

```text
warmup_messages table → runner-tasks/get returns task_type: "warmup_chat"
                      → Python calls send_message() (same function)
                      → runner-tasks/report handles warmup_chat result
```

This is already unified at the Python level. No changes needed.

### Phase 4: Update Python Runner to Handle Account Actions

The Python runner in `SetupGuide.tsx` already has the `account_action()` function that handles all these task types. We just need to ensure the task format matches.

The Python runner's `process()` function already routes to `account_action()` for:
- `change_name`, `change_photo`, `change_bio`, `change_username`
- `add_contact`, `delete_contact`, `block_contact`, `unblock_contact`
- `join_channel`, `leave_channel`, `react`, `view_channel`
- `spambot_check`, `session_check`, `get_me`
- `get_dialogs`, `read_messages`, `delete_chat`

No Python changes needed - just need the edge function to serve these tasks.

## Summary of Changes

| Component | Change | Impact |
|-----------|--------|--------|
| `runner-tasks/index.ts` | Add account_check_tasks fetch in handleGetTasks | Account actions will be delivered to Python |
| `runner-tasks/index.ts` | Add account action handling in handleReportResults | Results will update DB properly |
| No Python changes | Already handles all action types | Ready to process |
| No frontend changes | Already creates tasks correctly | Works as-is |

## Task Flow After Implementation

```text
USER ACTION (Accounts page):
1. User selects accounts, clicks "Change Name"
2. Frontend inserts tasks into account_check_tasks (status: pending)
3. Toast shows "Queued name change for X accounts"

PYTHON RUNNER:
4. Calls runner-tasks/get 
5. Gets tasks with task_type: "change_name"
6. account_action(client, "change_name", task) executes
7. Reports result to runner-tasks/report

RESULT PROCESSING:
8. Edge function updates account_check_tasks (status: completed)
9. Edge function updates telegram_accounts (first_name, last_name)
10. Logs page shows completion
```

## Files to Modify

1. **`supabase/functions/runner-tasks/index.ts`**
   - Add account action task fetching in `handleGetTasks()`
   - Add account action result handling in `handleReportResults()`

2. **`.lovable/plan.md`**
   - Update to reflect new consolidated architecture

## Benefits

1. **Account actions will actually work** - Currently queued but never processed
2. **Unified architecture** - All tasks flow through same endpoint
3. **No new edge functions** - Uses existing `runner-tasks` 
4. **No Python changes** - Already handles all action types
5. **Warmup already unified** - Uses same `send_message()` as campaigns/livechat

