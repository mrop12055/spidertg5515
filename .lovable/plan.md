

# Remove Batch Control from Python Runner

## Problem
Currently, the Python runner fetches `campaignBatchSize` from settings on startup and uses it to request tasks. This means:
1. Changing batch size in Admin UI requires runner restart
2. Runner is unnecessarily controlling batch size when backend already handles it

## Current Flow
```
Runner startup → Get campaignBatchSize (100) → Use for all get_tasks() calls
Admin changes batch to 500 → Runner still uses 100 (until restart)
```

## Solution
Remove batch_size control from Python runner entirely. The backend's `/get` endpoint already:
- Reads `campaignBatchSize` from `app_settings` on every request
- Applies it to the `.limit(batch_size)` in queries
- Returns only the appropriate number of tasks

The runner should just ask for tasks without specifying a limit, and process whatever it receives.

## Technical Changes

### File: `src/pages/SetupGuide.tsx`

**Change 1: Simplify `get_tasks()` function (lines 212-222)**

Remove the `batch_size` parameter - let backend decide:

```python
# Before:
async def get_tasks(batch_size: int = 100) -> dict:
    """Fetch tasks AND accounts from unified endpoint."""
    try:
        r = await get_http().post(
            f"{BACKEND_URL}/runner-tasks/get",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"runner": "unified", "batch_size": batch_size}, timeout=60
        )
        return r.json() if r.status_code == 200 else {"tasks": [], "accounts": []}
    except:
        return {"tasks": [], "accounts": []}

# After:
async def get_tasks() -> dict:
    """Fetch tasks AND accounts from unified endpoint."""
    try:
        r = await get_http().post(
            f"{BACKEND_URL}/runner-tasks/get",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
            json={"runner": "unified"}, timeout=60
        )
        return r.json() if r.status_code == 200 else {"tasks": [], "accounts": []}
    except:
        return {"tasks": [], "accounts": []}
```

**Change 2: Remove batch size fetching from initial setup (lines 1417-1419)**

Remove these lines that fetch and store the batch size:

```python
# Remove these lines:
    # Get configured batch size from settings (default 100)
    config_batch_size = initial.get("config", {}).get("campaignBatchSize", 100)
    print(f"  Using batch size: {config_batch_size} (from settings)")
```

**Change 3: Simplify main loop task fetching (lines 1430-1431)**

Update to call `get_tasks()` without parameter:

```python
# Before:
            batch = await get_tasks(config_batch_size)

# After:
            batch = await get_tasks()
```

### File: `supabase/functions/runner-tasks/index.ts`

**Change: Use settings-based batch size as default (line 173)**

Update to use the configured batch size from settings when runner doesn't specify one:

```typescript
// Before:
const { runner, batch_size = 100, account_ids } = body;

// After:
async function handleGetTasks(supabase: any, body: any) {
  const { runner, account_ids } = body;
  const nowIso = new Date().toISOString();
  
  // Get settings first (cached)
  const settingsData = await getCachedSettings(supabase);
  const config = parseSettings(settingsData);
  
  // Use configured batch size from settings, not from runner request
  const batch_size = config.campaignBatchSize;
  
  console.log(`[runner-tasks/get] Runner: ${runner}, batch_size: ${batch_size} (from settings)`);
  // ... rest of function
```

## Expected Behavior After Changes

| Scenario | Before | After |
|----------|--------|-------|
| Admin changes batch 100→500 | Runner keeps using 100 until restart | Immediately uses 500 on next request |
| Runner requests tasks | Sends `batch_size: 100` in request | No batch_size in request, backend decides |
| Backend returns tasks | Limited by runner's requested batch | Limited by admin-configured batch |

## Benefits
1. **No restart required** - Admin can change batch size dynamically
2. **Single source of truth** - Backend controls all speed settings
3. **Simpler runner code** - Runner just processes what it receives

