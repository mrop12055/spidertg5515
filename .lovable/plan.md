

# Security Verification: Proxy Failure Handling

## Analysis Summary

After thoroughly reviewing all Python runners and edge functions, I found that **the current implementation is already secure**:

### What's Already Correct

1. **Proxy is NEVER removed from account during failure**
   - The `report_result("proxy_error", ...)` handler in `report-task-result/index.ts` (lines 1399-1459) only:
     - Sets `disabled_reason` on the account
     - Marks proxy `status: "error"` in the proxies table
     - Does NOT change `proxy_id` - the proxy assignment remains intact

2. **Retry delay is already 3 minutes**
   - `PROXY_RETRY_DELAY = 180` (line 138 in SetupGuide.tsx)
   - This is exactly what you requested

3. **Session is disconnected BEFORE retry**
   - `force_disconnect_session()` is called immediately when proxy fails
   - Client is removed from `active_clients` dictionary
   - Socket is forcefully closed with 10-second timeout
   - Only THEN is the account added to retry queue

4. **Auto-reconnect is disabled**
   - `auto_reconnect=False` prevents Telethon from reconnecting on its own
   - `connection_retries=0` ensures no internal retry attempts
   - All reconnections go through our controlled flow

### The Flow (Verified Secure)

```text
Proxy Failure Detected
        ↓
force_disconnect_session()     ← CLIENT KILLED IMMEDIATELY
        ↓
Client removed from active_clients
        ↓
Socket disconnected (10s timeout)
        ↓
asyncio.sleep(0.5) for cleanup
        ↓
report_result("proxy_error")   ← Marks proxy as "error" in DB
        ↓                         (proxy_id NOT removed from account)
add_to_proxy_retry_queue()     ← Wait 3 minutes before retry
        ↓
[After 3 minutes]
        ↓
Retry connection with SAME proxy (proxy_id still assigned)
        ↓
If still failing after 3 attempts → mark account auto_disabled
```

### Database Confirmation

Looking at `report-task-result/index.ts` lines 1407-1415:
```typescript
// Only update disabled_reason - DO NOT change proxy_id, status, or ban_reason
await supabase
  .from("telegram_accounts")
  .update({ 
    disabled_reason: `Proxy error: ${reason || "Connection failed"}`,
    ban_reason: null
    // NOTE: We do NOT change status, proxy_id, or any fingerprint data
  })
  .eq("id", account_id);
```

The `proxy_id` is intentionally left unchanged so the account stays linked to its assigned proxy.

### Conclusion

**No changes needed** - the system already:
1. Disconnects accounts immediately when proxy fails
2. Never removes the proxy assignment from accounts
3. Waits 3 minutes before retry attempts
4. Retries 3 times with the same proxy before marking account as auto_disabled

The proxy assignment (`proxy_id` on the account) is only ever changed:
- By admin in the dashboard (manual reassignment)
- When deleting a proxy (sets accounts to `proxy_id: null`)
- Never automatically during error handling

---

### Optional Enhancement: Add Explicit Logging

If you want additional confidence, I can add logging to the Python runners to confirm the disconnect-before-retry sequence:

```python
# In force_disconnect_session
print(f"  [SECURITY] {phone} - PROXY FAILED - disconnecting BEFORE any retry")
print(f"  [SECURITY] {phone} - Session terminated. Proxy assignment unchanged in DB.")
```

Would you like me to add this explicit logging, or are you satisfied with the current implementation?

