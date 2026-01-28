

# LiveChat Runner - Instant Session Kill on Proxy Failure

## Problem Summary

Your concern is valid: When a proxy fails, the system must **instantly kill the session FIRST** before anything else. The current code has gaps where the Telegram client might briefly be exposed to direct internet if:

1. The proxy dies **mid-connection** (partial connection state)
2. An exception is thrown before `force_disconnect_session()` is called
3. The session file isn't cleaned up before retry

## Current Code Flow Analysis

### What's Currently Working
- `connection_retries=0` and `auto_reconnect=False` in TelegramClient (line 869-871)
- Session files are deleted before retry (line 458-472)
- `force_disconnect_session()` deletes session files after disconnect (lines 286-301)

### Critical Gaps Found

**Gap 1: `retry_one()` doesn't force disconnect on exception**
In lines 586-594, if an exception occurs during retry, the code logs it and adds to retry queue, but does NOT call `force_disconnect_session()` first:

```python
except Exception as e:
    error_str = str(e).lower()
    print(f"    [{phone}] ✗ Error: {str(e)[:100]}")
    # ❌ MISSING: Force disconnect BEFORE adding to retry queue
    if any(p in error_str for p in PROXY_ERROR_PATTERNS):
        await add_to_proxy_retry_queue(acc_id, account_data, proxy_data)
```

**Gap 2: `get_or_create_client()` outer exception handler doesn't force disconnect**
In lines 1032-1038, if an exception occurs in the outer try block, it only logs and returns - no session cleanup:

```python
except Exception as e:
    err_str = str(e).lower()
    status = detect_account_status(err_str)
    print(f"  [{status.upper()}] {account['phone_number']}: {e}")
    # ❌ MISSING: Force disconnect and session file cleanup
    return None
```

**Gap 3: `connect_account_with_fingerprint()` exception handler doesn't force disconnect**
In lines 2922-2937, exceptions are caught but no explicit session kill happens before reporting error.

---

## Technical Changes Required

### Fix 1: Force Disconnect BEFORE Retry Queue in `retry_one()`

**Location:** Lines 586-594

**Current Code:**
```python
except Exception as e:
    error_str = str(e).lower()
    print(f"    [{phone}] ✗ Error: {str(e)[:100]}")
    
    if any(p in error_str for p in PROXY_ERROR_PATTERNS):
        await add_to_proxy_retry_queue(acc_id, account_data, proxy_data)
    
    return False
```

**Fixed Code:**
```python
except Exception as e:
    error_str = str(e).lower()
    print(f"    [{phone}] ✗ Error: {str(e)[:100]}")
    
    # CRITICAL: Force disconnect session FIRST before any retry logic
    await force_disconnect_session(acc_id, f"retry_exception:{error_str[:30]}")
    
    if any(p in error_str for p in PROXY_ERROR_PATTERNS):
        await add_to_proxy_retry_queue(acc_id, account_data, proxy_data)
    
    return False
```

### Fix 2: Force Disconnect in `get_or_create_client()` Outer Exception Handler

**Location:** Lines 1032-1038

**Current Code:**
```python
except Exception as e:
    err_str = str(e).lower()
    status = detect_account_status(err_str)
    print(f"  [{status.upper()}] {account['phone_number']}: {e}")
    if not skip_session_check:
        asyncio.create_task(report_session_check(account_id, success=False, error=str(e)))
    return None
```

**Fixed Code:**
```python
except Exception as e:
    err_str = str(e).lower()
    
    # CRITICAL: Force disconnect session FIRST to prevent any proxyless connection
    await force_disconnect_session(account_id, f"outer_exception:{err_str[:30]}")
    
    status = detect_account_status(err_str)
    print(f"  [{status.upper()}] {account['phone_number']}: {e}")
    if not skip_session_check:
        asyncio.create_task(report_session_check(account_id, success=False, error=str(e)))
    return None
```

### Fix 3: Force Disconnect in `connect_account_with_fingerprint()` Exception Handler

**Location:** Lines 2922-2937

**Current Code:**
```python
except Exception as e:
    error_str = str(e).lower()
    
    if is_network_error(error_str) or "winerror 64" in error_str:
        print(f"  [{phone}] NETWORK ERROR (local connection issue): {str(e)[:50]}")
        return None, f"NETWORK_ERROR:{e}"
    
    print(f"  [{phone}] PROXY ERROR: {str(e)[:50]} - update proxy in admin dashboard")
    await report_result("proxy_error", {...})
    return None, f"Proxy error: {e}"
```

**Fixed Code:**
```python
except Exception as e:
    error_str = str(e).lower()
    
    # CRITICAL: Force disconnect session FIRST - before ANY other action
    await force_disconnect_session(account_id, f"connect_exception:{error_str[:30]}")
    
    if is_network_error(error_str) or "winerror 64" in error_str:
        print(f"  [{phone}] NETWORK ERROR (local connection issue): {str(e)[:50]}")
        return None, f"NETWORK_ERROR:{e}"
    
    print(f"  [{phone}] PROXY ERROR: {str(e)[:50]} - update proxy in admin dashboard")
    await report_result("proxy_error", {...})
    return None, f"Proxy error: {e}"
```

### Fix 4: Delete Session File BEFORE TelegramClient Creation

**Location:** Lines 854-887 (`_get_or_create_client_internal`)

Add session file deletion BEFORE creating the TelegramClient to ensure no stale session state:

```python
# ========== STEP 5: CLEAN OLD SESSION FILE FIRST ==========
# Delete any existing session file to prevent SQLite locks and stale state
try:
    import glob
    session_patterns = [
        os.path.join(SESSION_FOLDER, f"*{phone.replace('+', '')}*.session"),
    ]
    for pattern in session_patterns:
        for session_file in glob.glob(pattern):
            try:
                os.remove(session_file)
            except:
                pass
except:
    pass

# ========== STEP 6: DECODE FRESH SESSION FILE ==========
session_path = decode_session_file(account["phone_number"], session_data)
```

---

## Updated Flow Diagram

```text
Connection Attempt:
    1. Delete any existing session file
    2. Decode fresh session from database
    3. Create TelegramClient with proxy
    4. Attempt connect (single attempt, no retry)
    
If proxy fails at ANY step:
    1. IMMEDIATELY call force_disconnect_session() ← FIRST!
    2. Delete session file (inside force_disconnect_session)
    3. Remove from active_clients
    4. THEN add to retry queue
    5. THEN report to backend
    
This ensures the account NEVER has a chance to connect without proxy.
```

---

## Summary of Changes

| File | Location | Change |
|------|----------|--------|
| SetupGuide.tsx | Lines 586-594 | Add `force_disconnect_session()` call BEFORE `add_to_proxy_retry_queue()` |
| SetupGuide.tsx | Lines 1032-1038 | Add `force_disconnect_session()` call at start of outer exception handler |
| SetupGuide.tsx | Lines 2922-2937 | Add `force_disconnect_session()` call at start of exception handler |
| SetupGuide.tsx | Before line 860 | Add session file cleanup BEFORE TelegramClient creation |

---

## Build Version

`2026-01-28-instant-kill-v2`

