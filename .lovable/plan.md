
# Plan: Fix Runner Restart Loop

## Problem Identified

The runner is stuck in a restart loop because of the outer `while True:` wrapper in `__main__`:

```python
if __name__ == "__main__":
    while True:
        try:
            asyncio.run(main())  # main() exits normally
        except KeyboardInterrupt:
            break
        except Exception as e:
            print("Crashed, restarting...")
            time.sleep(5)
```

When `main()` exits for ANY reason (including normal exit when `RUNNING = False`), the outer loop immediately restarts it. This causes the infinite "CONNECTING ACCOUNTS → No tasks → CONNECTING ACCOUNTS" loop you're seeing.

---

## Root Cause

The `RUNNING` flag is set to `False` by the signal handler (Ctrl+C), but:
1. `main()` exits its while loop cleanly
2. The outer `while True` loop sees no exception
3. It immediately calls `asyncio.run(main())` again
4. The new `main()` call has `RUNNING = True` (reset at module level)

This creates the restart loop.

---

## Solution

Modify the `__main__` block to only restart on actual crashes, not on clean exits:

### File: `src/pages/SetupGuide.tsx`

**Change the `__main__` block (around line 1265):**

```python
if __name__ == "__main__":
    print("\\n" + "="*50)
    print("  pip install telethon httpx pysocks")
    print("="*50 + "\\n")
    
    while True:
        try:
            asyncio.run(main())
            # If main() exits cleanly (RUNNING = False), break the loop
            if not RUNNING:
                print("  ✓ Clean shutdown")
                break
        except KeyboardInterrupt:
            print("\\n⏹ Stopped")
            break
        except Exception as e:
            print(f"\\n⚠ Crashed: {e}\\n  Restarting in 5s...")
            time.sleep(5)
            # Reset RUNNING flag for restart
            RUNNING = True
```

---

## What This Fixes

| Before | After |
|--------|-------|
| `main()` exits → immediately restart | `main()` exits → check `RUNNING` flag |
| Signal handler sets `RUNNING=False` → ignored | `RUNNING=False` → break outer loop |
| Infinite restart loop | Clean shutdown or crash-only restart |

---

## Expected Behavior After Fix

1. **Normal operation**: Runner connects, processes tasks, stays running
2. **Ctrl+C**: Sets `RUNNING=False`, exits main loop, breaks outer loop, stops
3. **Crash/Exception**: Logs error, waits 5 seconds, resets `RUNNING=True`, restarts

---

## Summary

Single change to the `__main__` block to:
1. Check if exit was intentional (`RUNNING = False`) and break
2. Only restart on actual exceptions/crashes
3. Reset `RUNNING = True` before restart so new loop works
