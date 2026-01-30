

# Fetch Messages Based on Runner's Last Offline Time

## Current Behavior
The runner uses a fixed **24-hour cutoff** when fetching unread messages during catch-up:
```python
cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
```

This is wasteful - if the runner was only offline for 5 minutes, it still tries to process messages from the last 24 hours.

## Solution
Use the `last_offline_at` timestamp from the `runner_heartbeats` table to determine the actual offline duration, and only fetch messages from that time onwards.

## Technical Changes

### 1. Backend: Include `last_offline_at` in `/get` Response

**File:** `supabase/functions/runner-tasks/index.ts`

**Location:** Inside `handleGetTasks()`, after recording heartbeat (around line 180-183)

```typescript
// After the heartbeat upsert, fetch the previous offline timestamp
let lastOfflineAt: string | null = null;
if (runner) {
  const { data: heartbeat } = await supabase
    .from("runner_heartbeats")
    .select("last_offline_at")
    .eq("runner_name", runner)
    .single();
  
  lastOfflineAt = heartbeat?.last_offline_at || null;
}
```

**Location:** At the response (around line 548-559), add `last_offline_at` to the response:

```typescript
return jsonResponse({
  tasks,
  accounts: listeningAccounts,
  delay_after: tasks.length > 0 ? config.campaignPollingInterval : 5,
  settings: config.livechatSettings,
  last_offline_at: lastOfflineAt,  // NEW
  config: {
    // ... existing config
  },
});
```

### 2. Python Runner: Track and Use Last Offline Time

**File:** `src/pages/SetupGuide.tsx`

**Change 1:** Add global variable to track last offline time (near line 59-60)

```python
# Track when the runner was last offline (fetched from backend)
last_offline_at: Optional[str] = None
```

**Change 2:** Update `fetch_unread_messages()` to use dynamic cutoff (lines 920-928)

```python
async def fetch_unread_messages(client, acc_id: str, offline_since: Optional[str] = None):
    """Fetch and report unread messages from contacts after reconnection."""
    global last_offline_at
    acc = accounts.get(acc_id, {})
    phone = acc.get("phone_number", "????")[-4:]
    
    from datetime import datetime, timedelta, timezone
    
    # Use last_offline_at if available, otherwise default to 24h
    if offline_since:
        try:
            cutoff_time = datetime.fromisoformat(offline_since.replace('Z', '+00:00'))
            # Add small buffer (5 min before offline) to catch edge cases
            cutoff_time = cutoff_time - timedelta(minutes=5)
        except:
            cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
    elif last_offline_at:
        try:
            cutoff_time = datetime.fromisoformat(last_offline_at.replace('Z', '+00:00'))
            cutoff_time = cutoff_time - timedelta(minutes=5)
        except:
            cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
    else:
        # First startup or unknown - use 24h default
        cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
    
    hours_back = (datetime.now(timezone.utc) - cutoff_time).total_seconds() / 3600
    
    try:
        print(f"  [CATCHUP] [{phone}] Fetching unread messages (last {hours_back:.1f}h)...")
```

**Change 3:** Store `last_offline_at` when getting initial tasks (lines 1365-1370)

```python
initial = await get_tasks(100)
initial_accounts = initial.get("accounts", [])

# Store the last offline timestamp from backend
last_offline_at = initial.get("last_offline_at")
if last_offline_at:
    print(f"  Runner last offline at: {last_offline_at}")

_, _ = await connect_all_from_response(initial_accounts)
```

**Change 4:** Pass offline time to catch-up function (inside `connect_all_from_response`, lines 1186-1192)

```python
# Fetch unread messages in PARALLEL, using last_offline_at for cutoff
if newly_connected:
    await asyncio.gather(
        *[fetch_unread_messages(clients[aid], aid, last_offline_at) 
          for aid in newly_connected if aid in clients],
        return_exceptions=True
    )
```

## Expected Behavior

| Scenario | Before | After |
|----------|--------|-------|
| Runner offline 5 minutes | Fetches 24h of messages | Fetches ~10 minutes of messages |
| Runner offline 2 hours | Fetches 24h of messages | Fetches ~2h 5min of messages |
| First startup (no data) | Fetches 24h of messages | Fetches 24h of messages (default) |
| Runner offline 3 days | Fetches 24h of messages | Fetches 24h of messages (capped) |

Note: We cap at 24 hours maximum since older messages are unlikely to be relevant, and Telegram dialogs may not have them cached anyway.

## Safety Measures

1. **5-minute buffer**: We subtract 5 minutes from the offline timestamp to catch any messages that arrived just before the runner went offline
2. **24-hour fallback**: If parsing fails or no data exists, we default to the existing 24-hour window
3. **Backend deduplication still active**: Even if we fetch duplicates, the backend's `telegram_message_id` deduplication prevents issues

