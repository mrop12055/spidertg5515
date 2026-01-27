

# Plan: Fix LiveChat Unread Message Sync and Health Check Issues

## Problems Identified

Based on my investigation, I found **three distinct issues**:

### Issue 1: Health Check Failure When Adding to Retry Queue

When `check_client_health` fails and triggers `add_to_proxy_retry_queue`, the function is called with minimal data:

```python
# Line 3414 - Current problematic code
await add_to_proxy_retry_queue(acc_id, {"id": acc_id}, None)
```

This passes ONLY the account ID, missing critical fields:
- `api_id` / `api_hash` - Required for reconnection
- `phone_number` - For logging
- `session_data` - For session reconstruction
- `proxy_id` - For proxy lookup

When the retry logic runs (lines 398-421), it tries to fetch from database where `api_id` and `api_hash` are NULL (since the system uses round-robin API pool assignment).

**Result**: Accounts fail with "No API credentials assigned" and never reconnect.

### Issue 2: Duplicate Database Triggers Causing Unread Count Issues

There are **4 overlapping triggers** on the `messages` table:

| Trigger Name | Event | Function |
|--------------|-------|----------|
| `on_message_insert` | INSERT | `update_conversation_on_message()` |
| `trg_update_conversation_on_message` | INSERT OR UPDATE | `update_conversation_on_message()` |
| `trigger_update_conversation_on_message` | INSERT | `update_conversation_on_message()` |
| `update_conversation_on_new_message` | INSERT | `update_conversation_details()` |

The two functions differ:
- `update_conversation_on_message()`: Counts all unread messages in conversation (accurate)
- `update_conversation_details()`: Increments `unread_count + 1` (can cause duplicates)

**Result**: On message insert, up to 4 triggers fire, potentially running 3 different update queries with conflicting counting logic.

### Issue 3: Missing API Credentials in Proxy Retry Queue

The `add_to_proxy_retry_queue` stores `account_data` but doesn't preserve the API credentials that were injected by the edge function during initial task assignment:

```python
_proxy_retry_queue[account_id] = {
    "count": 1,
    "next_retry_at": now + 180,
    "account_data": account_data,  # Missing api_id/api_hash from original task
    "proxy_data": proxy_data
}
```

---

## Solution

### Fix 1: Preserve API Credentials in Health Check Handler

Update the health check failure handler to pass the full account data including API credentials from the active client's cached data.

**File**: `src/pages/SetupGuide.tsx`

**Location**: Lines 3411-3414 (inside `keep_clients_alive()`)

**Current Code**:
```python
# Immediately disconnect dead connections and add to retry queue
for acc_id in health_check_disconnects:
    await force_disconnect_session(acc_id, "health_check_failed")
    await add_to_proxy_retry_queue(acc_id, {"id": acc_id}, None)
```

**New Code**:
```python
# Immediately disconnect dead connections and add to retry queue
for acc_id in health_check_disconnects:
    # Get cached account data for this client (includes API credentials)
    cached_data = _client_account_data.get(acc_id, {"id": acc_id})
    
    await force_disconnect_session(acc_id, "health_check_failed")
    await add_to_proxy_retry_queue(acc_id, cached_data, cached_data.get("proxy"))
```

### Fix 2: Add Client Account Data Cache

Create a global cache to store original account data (including API credentials) when clients are created.

**Location**: Add near line 195 (after other global variables)

```python
# Cache account data with API credentials for reconnection
_client_account_data: Dict[str, dict] = {}
```

**Location**: Inside `_get_or_create_client_internal()` - after successful connection (around line 900)

```python
# Cache account data for reconnection scenarios
_client_account_data[account_id] = {
    "id": account_id,
    "phone_number": phone,
    "api_id": api_id,
    "api_hash": api_hash,
    "api_credential_id": account.get("api_credential_id"),
    "proxy_id": account.get("proxy_id"),
    "proxy": task_proxy
}
```

### Fix 3: Clean Up Duplicate Database Triggers

Create a migration to drop redundant triggers and keep only the most accurate one.

**Migration SQL**:
```sql
-- Drop duplicate triggers - keep only the accurate counting function
DROP TRIGGER IF EXISTS on_message_insert ON public.messages;
DROP TRIGGER IF EXISTS trg_update_conversation_on_message ON public.messages;  
DROP TRIGGER IF EXISTS trigger_update_conversation_on_message ON public.messages;

-- Keep only update_conversation_on_new_message which uses update_conversation_details()
-- This one does a proper COUNT() of unread messages instead of simple increment
```

Actually, looking at the functions:
- `update_conversation_details()` uses `COALESCE(unread_count, 0) + 1` (simple increment)
- `update_conversation_on_message()` uses `SELECT COUNT(*)` (accurate count)

**Corrected Migration**:
```sql
-- Drop duplicate and less accurate triggers
DROP TRIGGER IF EXISTS on_message_insert ON public.messages;
DROP TRIGGER IF EXISTS trigger_update_conversation_on_message ON public.messages;  
DROP TRIGGER IF EXISTS update_conversation_on_new_message ON public.messages;

-- Keep only trg_update_conversation_on_message (INSERT OR UPDATE) 
-- which uses update_conversation_on_message() with accurate COUNT()
```

### Fix 4: Update Build Version

**Location**: Line 3475

```python
print("  BUILD: 2026-01-27-health-check-fix")
```

---

## Technical Details

### API Credential Flow (Current - Broken on Retry)

```text
Edge Function (get-next-task)
    ↓ injects api_id/api_hash from pool
Initial Connection
    ↓ works (has API credentials)
Network Error / Health Check Fail
    ↓ calls add_to_proxy_retry_queue(acc_id, {"id": acc_id}, None)
Retry after 3 minutes
    ↓ fetches from DB where api_id is NULL
FAIL: "No API credentials assigned"
```

### API Credential Flow (Fixed)

```text
Edge Function (get-next-task)
    ↓ injects api_id/api_hash from pool
Initial Connection
    ↓ caches full account_data in _client_account_data
    ↓ works
Network Error / Health Check Fail
    ↓ calls add_to_proxy_retry_queue(acc_id, _client_account_data[acc_id], proxy)
Retry after 3 minutes
    ↓ uses cached api_id/api_hash
SUCCESS: Reconnects with same API credentials
```

---

## Files to Modify

1. **`src/pages/SetupGuide.tsx`**:
   - Add `_client_account_data` global cache (line ~195)
   - Cache account data in `_get_or_create_client_internal()` (line ~900)
   - Update health check handler to use cached data (lines 3411-3414)
   - Update build version (line 3475)

2. **Database Migration**:
   - Drop 3 duplicate triggers on `messages` table
   - Keep only `trg_update_conversation_on_message`

---

## Expected Outcome

| Before | After |
|--------|-------|
| Health check failures lose API credentials | API credentials cached for reconnection |
| Retry always fails with "No API credentials" | Retry uses cached API credentials |
| 4 triggers fire on message insert | 1 trigger fires (accurate unread count) |
| Potential double/triple counting | Single accurate COUNT() query |

