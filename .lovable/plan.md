
# LiveChat Runner Complete Analysis and Enhancement Plan

## Current Architecture Summary

The LiveChat runner in `SetupGuide.tsx` (lines 2800-4003) is a Python script that runs continuously with the following flow:

### Connection Flow (Already Implemented)
```text
FOR EACH ACCOUNT:
    1. CHECK PROXY (MANDATORY) → Skip if missing
    2. CHECK FINGERPRINT (MANDATORY) → Skip if missing  
    3. GET API CREDENTIALS (round-robin from pool, lowest usage first)
    4. CONNECT with proxy + fingerprint + API
    5. ON FAILURE → Instant disconnect via force_disconnect_session()
    6. Add to retry queue (3 attempts, 1-min intervals)
    7. After 3 failures → Mark account inactive (auto_disabled=true)
```

### Message Handling (Already Implemented)
- **Incoming**: Event handler `@client.on(events.NewMessage)` with contacts-only filter
- **Outgoing**: Batch parallel sending via `asyncio.gather()` across all accounts
- **Photos/URLs**: Full support for upload/download with Supabase storage

---

## Requirements Verification

| Your Requirement | Status | Evidence |
|------------------|--------|----------|
| Connect all accounts with fingerprint + proxy | WORKING | Lines 700-722: Both are MANDATORY checks |
| Round-robin API (least used first, never repeat) | WORKING | Lines 417-438: `order: usage_count.asc,last_used_at.asc.nullsfirst` |
| Instant disconnect on proxy failure | WORKING | Lines 793-816: `force_disconnect_session()` called immediately |
| 1-minute retry delay | WORKING | Line 138: `PROXY_RETRY_DELAY = 60` |
| 3 attempts before marking inactive | WORKING | Lines 326-335: Reports `proxy_max_retries_exceeded` |
| Auto-connect new accounts when proxy assigned | WORKING | Each `get-next-task` poll returns ALL valid accounts |
| Never connect without fingerprint/proxy | WORKING | Lines 700-722: Skip with error message |
| Check unread from contacts only | WORKING | Lines 2871-2875: `is_contact` filter |
| Check from last offline time (NOT 24h) | NEEDS FIX | Lines 2893: Uses fixed `timedelta(hours=24)` |
| Keep receiving messages live | WORKING | `keep_clients_alive()` background task |
| Bulk batch sending (parallel) | WORKING | Lines 3764-3876: `asyncio.gather()` |
| Send/receive pictures and URLs | WORKING | Lines 2920-2959: Photo download/upload |
| Prevent double session (session lock) | WORKING | Lines 87-97: Per-account `asyncio.Lock` |
| Report all errors to admin dashboard | WORKING | `log_error()` + `report_result()` → vps_logs |
| Show runner status TIME in dashboard | NEEDS FIX | Line 71: Shows only "LIVE" or "Offline" |

---

## Issues to Fix

### Issue 1: Message Sync Uses Fixed 24-Hour Window

**Current Code (Lines 2892-2905):**
```python
twenty_four_hours_ago = datetime.now(timezone.utc) - timedelta(hours=24)
if msg.date and msg.date < twenty_four_hours_ago:
    skipped_count += 1
    continue
```

**Problem:** 
- If runner offline for 1 hour → Still scans all 24 hours (wasteful)
- If runner offline for 48 hours → Misses first 24 hours of messages

**Solution:** Store `last_offline_at` timestamp when runner shuts down, use it on startup.

---

### Issue 2: Dashboard Shows Only "LIVE" or "Offline"

**Current Code (RunnerStatus.tsx Line 71):**
```tsx
{runner.isOnline ? 'LIVE' : 'Offline'}
```

**Problem:** No indication of how long the runner has been offline.

**Solution:** Show relative time like "Offline 2h 30min ago".

---

## Implementation Plan

### Step 1: Database Migration

Add `last_offline_at` column to `runner_heartbeats` table:

```sql
ALTER TABLE runner_heartbeats 
ADD COLUMN IF NOT EXISTS last_offline_at TIMESTAMPTZ;
```

---

### Step 2: Update LiveChat Runner Python Code

**2.1 Add import for datetime at top of main_loop:**
```python
from datetime import datetime, timezone, timedelta
```

**2.2 Fetch last_offline_at on startup (at start of main_loop):**
```python
# Fetch last offline timestamp for accurate message sync window
last_offline_at = None
try:
    http = get_http_client()
    resp = await http.get(
        f"{SUPABASE_URL}/rest/v1/runner_heartbeats",
        params={
            "runner_name": "eq.livechat",
            "select": "last_offline_at"
        },
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}"
        },
        timeout=10
    )
    if resp.status_code == 200 and resp.json():
        data = resp.json()[0]
        if data.get("last_offline_at"):
            last_offline_at = datetime.fromisoformat(
                data["last_offline_at"].replace("Z", "+00:00")
            )
            print(f"  [SYNC] Will fetch messages since last offline: {last_offline_at}")
except Exception as e:
    print(f"  [WARN] Could not fetch last_offline_at: {e}")
```

**2.3 Pass last_offline_at to sync_missed_messages function:**

Update the function signature and logic in `sync_missed_messages()`:
```python
async def sync_missed_messages(client, account_id: str, phone: str, 
                               last_synced_msg_ids: dict = None,
                               last_offline_at: datetime = None) -> tuple:
    # ...
    # Calculate sync cutoff based on last_offline_at or fallback to 24h
    if last_offline_at:
        sync_cutoff = last_offline_at
        print(f"  [{phone}] Syncing from last offline: {sync_cutoff}")
    else:
        sync_cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        print(f"  [{phone}] No offline timestamp, using 24h fallback")
    
    # Replace twenty_four_hours_ago with sync_cutoff
    if msg.date and msg.date < sync_cutoff:
        skipped_count += 1
        continue
```

**2.4 Store last_offline_at on shutdown:**

Add to the `save_all_sessions_sync()` function:
```python
def save_all_sessions_sync():
    # ... existing session save code ...
    
    # Store last offline time for accurate message sync on next startup
    try:
        import requests
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/runner_heartbeats",
            params={"runner_name": "eq.livechat"},
            json={"last_offline_at": datetime.utcnow().isoformat()},
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            timeout=5
        )
        print("  [SHUTDOWN] Saved last_offline_at timestamp")
    except Exception as e:
        print(f"  [WARN] Could not save offline timestamp: {e}")
```

---

### Step 3: Update Dashboard RunnerStatus Component

**3.1 Add formatDistanceToNow import:**
```tsx
import { formatDistanceToNow } from 'date-fns';
```

**3.2 Update the status display (line 67-72):**
```tsx
<p className={cn(
  "text-[10px]",
  runner.isOnline ? "text-green-600" : "text-destructive"
)}>
  {runner.isOnline 
    ? 'LIVE' 
    : runner.lastSeen 
      ? `Offline ${formatDistanceToNow(runner.lastSeen, { addSuffix: false })}`
      : 'Offline'
  }
</p>
```

---

## Files to Modify

| File | Changes |
|------|---------|
| Database migration | Add `last_offline_at` column to `runner_heartbeats` |
| `src/pages/SetupGuide.tsx` | Update `livechatRunnerPy` Python code |
| `src/components/dashboard/RunnerStatus.tsx` | Show relative time for offline runners |

---

## Existing Features Summary (No Changes Needed)

### Round-Robin API Rotation
- `selectNextApiCredential()` fetches from pool ordered by `usage_count.asc`
- Each API is used once per rotation cycle before repeating
- Usage incremented ONLY on successful send via `increment_api_usage` RPC

### Instant Disconnect on Proxy Failure
- `force_disconnect_session()` cancels ALL internal Telethon tasks
- Removes from `active_clients` immediately
- Adds to retry queue with 1-minute delay

### 3-Attempt Retry with Inactive Marking
- `add_to_proxy_retry_queue()` tracks attempts
- After 3 failures, reports `proxy_max_retries_exceeded`
- Backend sets `auto_disabled: true`

### Session Lock Prevention
- Per-account `asyncio.Lock` prevents concurrent connections
- `connection_retries=0, auto_reconnect=False` in Telethon client
- SQLite retry logic for "database is locked" errors

### Parallel Batch Sending
- `asyncio.gather()` processes all account batches simultaneously
- Stagger delay between messages on same account (configurable 1-2s)
- `_processing_batch` flag pauses health checks during sends

### Error Reporting
- All Telegram errors reported via `report_result()` 
- Python runner errors logged via `log_error()` to `vps_logs`
- Visible in Recent Errors dashboard card

---

## Risk Assessment

| Change | Risk | Reason |
|--------|------|--------|
| Add `last_offline_at` column | Zero | New column, no existing data impact |
| Store timestamp on shutdown | Low | Non-blocking, uses try/catch, sync fallback |
| Fetch timestamp on startup | Low | Falls back to 24h if fetch fails |
| Update RunnerStatus UI | Zero | Display-only change |

---

## Technical Details

### Estimated Changes
- **Database**: 1 ALTER TABLE statement
- **Python code**: ~40 new lines in SetupGuide.tsx livechatRunnerPy
- **TypeScript**: ~5 lines in RunnerStatus.tsx
