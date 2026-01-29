
# LiveChat Runner - Fix Offline Timestamp Sync

## Build Version: 2026-01-29-sync-timestamp-fix

---

## Problem Analysis

The LiveChat runner shows:
```
[SYNC] No offline timestamp found, using 24h fallback
```

**Root Cause:**
1. The `last_offline_at` column is NULL in the database because:
   - Shutdown handler only runs on graceful exit (Ctrl+C)
   - Crashes/force kills skip the shutdown handler
   - The timestamp is never saved on abnormal termination

2. The current code **only** checks `last_offline_at` and falls back to 24h if NULL

**Current Database State:**
```sql
runner_name: livechat
last_seen: 2026-01-29 08:46:41.497+00  -- This is updated every heartbeat
last_offline_at: NULL                   -- This is never set (problem!)
```

---

## Solution

**Use `last_seen` as a fallback when `last_offline_at` is NULL:**

The heartbeat system already tracks `last_seen` on every poll (every 5-15 seconds). This means:
- When the runner crashes, `last_seen` is the last known active time
- On restart, we can use `last_seen` as the sync cutoff if `last_offline_at` is NULL
- This gives us a maximum missed window of ~15 seconds instead of 24 hours

---

## Technical Changes

### File: `src/pages/SetupGuide.tsx`

### Change 1: Fetch BOTH `last_offline_at` and `last_seen` (Lines 3717-3741)

**Current Code:**
```python
resp = await http.get(
    f"{SUPABASE_URL}/rest/v1/runner_heartbeats",
    params={
        "runner_name": "eq.livechat",
        "select": "last_offline_at"
    },
    ...
)
if resp.status_code == 200 and resp.json():
    data = resp.json()[0]
    if data.get("last_offline_at"):
        last_offline_at = datetime.fromisoformat(...)
        print(f"  [SYNC] Will fetch messages since last offline: {last_offline_at}")

if not last_offline_at:
    print("  [SYNC] No offline timestamp found, using 24h fallback")
```

**New Code:**
```python
resp = await http.get(
    f"{SUPABASE_URL}/rest/v1/runner_heartbeats",
    params={
        "runner_name": "eq.livechat",
        "select": "last_offline_at,last_seen"  # Fetch both
    },
    ...
)
if resp.status_code == 200 and resp.json():
    data = resp.json()[0]
    from datetime import datetime
    
    # Priority 1: Use last_offline_at if available (graceful shutdown)
    if data.get("last_offline_at"):
        last_offline_at = datetime.fromisoformat(
            data["last_offline_at"].replace("Z", "+00:00")
        )
        print(f"  [SYNC] Using last_offline_at: {last_offline_at}")
    
    # Priority 2: Use last_seen as fallback (crash recovery)
    elif data.get("last_seen"):
        last_offline_at = datetime.fromisoformat(
            data["last_seen"].replace("Z", "+00:00")
        )
        print(f"  [SYNC] Using last_seen (crash recovery): {last_offline_at}")

if not last_offline_at:
    print("  [SYNC] No timestamps found, using 24h fallback")
```

### Change 2: Also Update Shutdown Handler to Clear `last_offline_at` After Successful Fetch (Optional Enhancement)

To prevent stale `last_offline_at` values from accumulating, we can clear it after a successful startup sync. This ensures each restart uses the most recent timestamp.

**Add after successful sync (optional, lines ~3850):**
```python
# Clear last_offline_at after successful fetch to prevent stale data
if last_offline_at:
    try:
        await http.patch(
            f"{SUPABASE_URL}/rest/v1/runner_heartbeats",
            params={"runner_name": "eq.livechat"},
            json={"last_offline_at": None},
            headers={...},
            timeout=5
        )
    except:
        pass  # Non-critical
```

---

## Flow After Fix

```text
Runner Startup:
    1. Query runner_heartbeats for last_offline_at AND last_seen
    
    If last_offline_at exists (graceful shutdown):
        → Use it as sync cutoff
    
    Else if last_seen exists (crash/force kill):
        → Use it as sync cutoff (max ~15 seconds missed)
    
    Else (first run ever):
        → Use 24h fallback
    
    2. Sync messages since cutoff
    3. Clear last_offline_at to prevent reuse

Runner Shutdown (graceful):
    1. Save last_offline_at = now()
    2. Save sessions

Runner Crash:
    1. last_seen already contains last heartbeat time
    2. Next startup uses last_seen as fallback
```

---

## Why This Works

| Scenario | Before (Bug) | After (Fixed) |
|----------|--------------|---------------|
| Graceful shutdown (Ctrl+C) | Uses `last_offline_at` ✓ | Uses `last_offline_at` ✓ |
| Crash/force kill | Falls back to 24h ✗ | Uses `last_seen` ✓ |
| First run ever | Falls back to 24h ✓ | Falls back to 24h ✓ |

**Maximum missed message window: ~15 seconds** (heartbeat interval) instead of 24 hours.

---

## Summary of Changes

| File | Location | Change |
|------|----------|--------|
| SetupGuide.tsx | Lines 3717-3741 | Fetch `last_seen` in addition to `last_offline_at` and use as fallback |

---

## Safety Guarantees

1. **No data loss**: If both timestamps are NULL, still falls back to 24h
2. **Backward compatible**: Works with existing database (no schema changes)
3. **Minimal overhead**: Single query already exists, just adding one more field
