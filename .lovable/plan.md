
# Fix: Python Runner Stops After Catch-up Phase

## Problem Identified

Based on the code analysis, the Python runner completes the catch-up phase successfully but then stops before entering the main processing loop. The expected output "PROCESSING TASKS + LISTENING FOR MESSAGES" never appears.

## Root Cause Analysis

After thorough investigation of the runner code in `SetupGuide.tsx`, I identified several potential issues:

### 1. Silent Exception in `setup_handlers()` (Most Likely)
The `setup_handlers()` function at line 1234 iterates through all 803 connected clients to register event handlers. If any client connection becomes stale or throws an error during handler registration, the exception could be unhandled and cause the runner to exit silently.

```text
Flow:
connect_all_from_response() -> [catch-up completes]
                            ↓
                    setup_handlers()  ← Potential crash here
                            ↓
                    print("PROCESSING TASKS...")  ← Never reached
```

### 2. Missing Exception Handling in `setup_handlers()`
The function has no try/except wrapper:
```python
async def setup_handlers():
    for aid, client in clients.items():
        if getattr(client, "_h", False):
            continue
        # No error handling here - if client.on() fails, whole function crashes
        @client.on(events.NewMessage(incoming=True))
        async def handler(event, a=aid):
            await on_message(event, a)
        setattr(client, "_h", True)
```

### 3. Possible Event Loop Termination
With 803 clients having event handlers, the asyncio event loop might be hitting resource limits on the local machine.

## Proposed Fix

Update the Python runner code to add defensive error handling and debug logging:

### Changes to `setup_handlers()` function (around line 1234):

Add try/except around handler registration:
```python
async def setup_handlers():
    """Set up incoming message handlers."""
    success = 0
    failed = 0
    for aid, client in clients.items():
        if getattr(client, "_h", False):
            continue
        
        try:
            @client.on(events.NewMessage(incoming=True))
            async def handler(event, a=aid):
                await on_message(event, a)
            
            setattr(client, "_h", True)
            success += 1
        except Exception as e:
            phone = accounts.get(aid, {}).get("phone_number", "????")[-4:]
            print(f"  [HANDLER-ERR] [{phone}] {str(e)[:40]}")
            failed += 1
    
    print(f"  [HANDLERS] Set up {success} handlers, {failed} failed")
```

### Add Debug Logging Between Catch-up and Main Loop (around line 1414):

```python
_, _ = await connect_all_from_response(initial_accounts)
print("  [DEBUG] Catch-up complete, setting up handlers...")  # NEW
await setup_handlers()
print("  [DEBUG] Handlers ready, entering main loop...")      # NEW

print("\\n" + "="*50)
print("  PROCESSING TASKS + LISTENING FOR MESSAGES")
print("="*50 + "\\n")
```

### Add Flush to Ensure Output is Visible:

After critical print statements, add `sys.stdout.flush()` to ensure output appears immediately on Windows.

---

## Technical Details

**File to Update:** `src/pages/SetupGuide.tsx`

**Section:** The `unifiedRunnerPy` template string containing the Python runner code

**Changes:**
1. Lines ~1234-1244: Wrap `setup_handlers()` in try/except with logging
2. Lines ~1414-1419: Add debug print statements between catch-up and main loop entry
3. Add stdout flushing after key print statements

This fix will:
- Reveal exactly where the runner stops (via debug logging)
- Prevent silent crashes during handler setup
- Continue running even if some handlers fail to register
- Make debug output visible immediately on Windows
