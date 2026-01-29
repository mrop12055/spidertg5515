
# Simplified Python Runner Architecture

## Current State Analysis

After reviewing the codebase, the current `unified_runner.py` (1200+ lines) has:
- Separate handlers for campaign, livechat, warmup, and account tasks
- Complex task routing with duplicate send logic
- Multiple task type handlers that all fundamentally do the same thing (send or receive messages)

## Core Insight

All operations reduce to just **3 core actions**:

| Operation | Source | Core Action |
|-----------|--------|-------------|
| Campaign | Send first message to recipient | **SEND MESSAGE** |
| LiveChat Reply | Reply to ongoing conversation | **SEND MESSAGE** |
| Warmup Chat | Accounts message each other | **SEND MESSAGE** |
| Incoming Messages | Real-time listener | **RECEIVE MESSAGE** |
| Spambot Check / Name Change | Account management | **ACCOUNT ACTION** |

## Proposed Simplified Architecture

```text
PHASE 1: CONNECT ALL ACCOUNTS (parallel)
    └── Connect 2000+ accounts with proxy + fingerprint validation
    └── Store in memory pool: active_clients[account_id] = TelegramClient
    
PHASE 2: SETUP HANDLERS
    └── Register incoming message handler on ALL connected clients
    
PHASE 3: UNIFIED TASK LOOP (continuous)
    └── Poll server for tasks (batch of 50-100)
    └── For each task, determine core action:
        ├── SEND: Campaign, LiveChat, Warmup → send_message()
        ├── RECEIVE: Handled by event handlers (automatic)
        └── ACCOUNT: Spambot check, name change, photo change
    └── Process tasks in PARALLEL for maximum throughput
```

## Technical Changes

### 1. Consolidate to 3 Core Functions

**Current State** (complex routing):
```python
async def process_campaign_task(task)
async def process_livechat_task(task)
async def process_warmup_task(task)
async def process_account_task(task)
```

**New State** (unified):
```python
async def send_message(client, recipient, content, media_url=None) -> (success, error, meta)
async def receive_message(event, account_id)  # Event handler
async def account_action(client, action_type, params)  # Spambot, name change, etc.
```

### 2. Simplified Task Processor

```python
async def process_task(task):
    """Route ALL tasks to 3 core functions."""
    task_type = task.get("task_type", "unknown")
    account_id = task.get("account", {}).get("id")
    client = active_clients.get(account_id)
    
    # ========== SEND OPERATIONS ==========
    if task_type in ("send", "campaign_send", "livechat_reply", "warmup_chat"):
        recipient = extract_recipient(task)
        content = extract_content(task)
        media_url = extract_media(task)
        
        success, error, meta = await send_message(client, recipient, content, media_url)
        await report_result(task_type, task, success, error, meta)
        
    # ========== ACCOUNT OPERATIONS ==========
    elif task_type in ("spambot_check", "change_name", "change_photo"):
        await account_action(client, task_type, task)
```

### 3. Parallel Batch Processing for Scale

For 2000 accounts processing many operations at once:

```python
async def main_loop():
    while RUNNING:
        batch = await get_batch_tasks(batch_size=100)
        tasks = batch.get("tasks", [])
        
        # Process ALL tasks in parallel (not sequential)
        await asyncio.gather(*[process_task(t) for t in tasks], return_exceptions=True)
```

### 4. Helper Functions for Task Data Extraction

```python
def extract_recipient(task):
    """Get recipient from ANY task type."""
    # Campaign/LiveChat
    if "recipient" in task:
        return task["recipient"]
    # Warmup
    if "task_data" in task:
        return task["task_data"].get("recipient_phone") or task["task_data"].get("recipient_telegram_id")
    # Message object
    msg = task.get("message", {})
    return msg.get("recipient") or msg.get("recipient_phone")

def extract_content(task):
    """Get message content from ANY task type."""
    if "content" in task:
        return task["content"]
    if "task_data" in task:
        return task["task_data"].get("message", "")
    return task.get("message", {}).get("content", "")
```

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | Replace `unified_runner.py` with simplified version |

## Benefits

1. **Simpler Code**: ~600 lines instead of ~1200 lines
2. **Single Send Function**: One tested, reliable `send_message()` for ALL sending operations
3. **Parallel Processing**: All tasks processed concurrently for maximum throughput
4. **Easy to Debug**: Fewer code paths = fewer bugs
5. **Scale Ready**: Handles 2000+ accounts with parallel task processing

## Edge Function Changes

No edge function changes needed - the task format from `get-batch-tasks` and `get-next-task` remains compatible. The Python runner just processes them more simply.

## Task Type Mapping (for clarity)

| Server Task Type | Python Core Action | Report Type |
|------------------|-------------------|-------------|
| `send` | send_message() | `send` |
| `campaign_send` | send_message() | `send` |
| `livechat_reply` | send_message() | `send` |
| `warmup_chat` | send_message() | `warmup_chat` |
| `warmup_add_contact` | add_contact() | `warmup_add_contact` |
| `spambot_check` | account_action() | `spambot_check` |
| `change_name` | account_action() | `change_name` |
| `change_photo` | account_action() | `change_photo` |
| (incoming) | receive_message() | `incoming_message` |
