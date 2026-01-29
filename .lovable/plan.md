
## What’s actually happening (based on your logs)

### 1) The “disconnect immediately” is *not* happening before 180s
Your log shows the proxy connection waits the full timeout:
- `Attempt 1 at connecting failed: OSError: [WinError 121] ...`
- then: `[CONNECTION TIMEOUT] ... Proxy failed after 180s - DISABLING ACCOUNT IMMEDIATELY`

So it is waiting ~180 seconds, then disabling (as requested). The confusing “immediate” part comes from the next bug.

### 2) The real bug: `name 'message_queues' is not defined`
Right after the runner kills the session, `force_disconnect_session()` throws a `NameError` because it references `message_queues`, but `message_queues` is not defined anywhere in the generated Python code.

That creates this noisy chain:
- proxy fails after 180s → we call `force_disconnect_session()` (correct)
- inside `force_disconnect_session()` → `NameError` → prints `[DISCONNECTED] ... message_queues is not defined`
This makes it look like the runner “disconnects instantly” or is unstable.

### 3) The WinError 121 itself
`WinError 121 The semaphore timeout period has expired` is a Windows network/proxy socket timeout (proxy provider / route issue). It’s not a “session check” issue, and it’s exactly the kind of error we should treat as “proxy failed” and kill the session to prevent any chance of non-proxy reconnect.

## Goal (what we will ensure)

1. Always attempt connection **with proxy + fingerprint** (never without proxy).
2. Give the proxy **exactly 180s** to connect.
3. If still not connected after 180s:
   - **kill session immediately**
   - **mark account status = disconnected** and **auto_disabled=true**
   - **mark proxy status = error**
   - **never remove proxy_id from account**
4. Remove the misleading `message_queues` NameError and any side-effects from it.

## Implementation plan (code changes)

### A) Fix `message_queues` NameError safely (primary fix)
**File:** `src/pages/SetupGuide.tsx` (inside the `clientManagerPy` python template)

1) Define `message_queues` globally near `active_clients`
- Add:
  - `message_queues: Dict[str, asyncio.Queue] = {}` (or `Dict[str, any]` if queue typing is not used elsewhere)

2) Make `force_disconnect_session()` robust even if `message_queues` is absent
- Change Step 3 cleanup to:
  - check if `message_queues` exists before referencing it (e.g., wrap in `try/except NameError` or `if 'message_queues' in globals(): ...`)
This prevents any crash/noise during critical disconnect operations.

**Result:** You will no longer see `[DISCONNECTED] ... message_queues is not defined`, and the disconnect behavior will be clean and predictable.

---

### B) Ensure we are not reintroducing retries via health-check paths
Right now, the LiveChat runner health check section still calls:
- `await add_to_proxy_retry_queue(acc_id, {"id": acc_id}, None)`

But your latest requirement is:
- proxy fails after 180s → disable immediately (no retry queue)

So we will update the LiveChat runner logic so:
- health_check failures do **not** enqueue into `_proxy_retry_queue` (since this queue conflicts with “immediate disable” behavior)
- health_check failure will:
  - kill session (`force_disconnect_session`)
  - log the reason (`log_error`)
  - optionally report a backend result type that marks the account “disconnected” (without removing proxy assignment)
  - NOT schedule proxy retries automatically

**File:** `src/pages/SetupGuide.tsx` (inside `livechatRunnerPy` python template)

---

### C) Keep the “proxy always used” security guarantee
We will verify and enforce in the connect/reconnect code paths:
- no code path calls `client.connect()` unless:
  - proxy exists and is active
  - the client was constructed with that proxy
- keep Telethon settings:
  - `auto_reconnect=False`
  - `connection_retries=0`
so Telethon never tries to reconnect behind our back.

(From your snippets, most of this is already correct; we’ll just ensure there are no bypass paths.)

## Validation / Testing steps (what you should see)

1) Run LiveChat runner with a known bad proxy:
- It should wait up to **180s**, then:
  - print the timeout message
  - print force-disconnect messages
  - **no `message_queues` error**
  - account becomes `disconnected + auto_disabled` in the dashboard
  - proxy becomes `error`
  - account still has the same proxy_id assigned

2) Run LiveChat runner with a working proxy:
- Accounts connect, show fingerprint usage, and stay connected.

3) Confirm no “immediate disconnect” logs appear before ~180s on proxy failure.
(After this fix, logs will be clearer and won’t falsely suggest instant disconnects.)

## Files we will modify
- `src/pages/SetupGuide.tsx`
  - Update the embedded Python templates:
    - `clientManagerPy`: define `message_queues` + guard cleanup in `force_disconnect_session`
    - `livechatRunnerPy`: remove/adjust any leftover retry-queue behavior that contradicts “disable immediately”

## Notes / Expectations
- `WinError 121` will still happen if the proxy provider or route is unhealthy. Our job is to handle it safely (kill session + disable) so it cannot cause unproxied reconnect attempts.
- If you want, we can also add a clearer log line that prints an elapsed timer (start/end timestamps) to make the 180s wait obvious in logs.

