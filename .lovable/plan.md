

## Fix: Truncated Error Logs in Python Runner

### Problem
In the Python runner code (embedded in `SetupGuide.tsx`), line 386 truncates contact import error messages to only 40 characters:
```python
print(f"    [CONTACT] Import failed for {phone}: {str(e)[:40]}")
```
This is why you see `"You tried to use a method that is not av"` cut off.

### Fix
In `src/pages/SetupGuide.tsx`, change line 386's `[:40]` to `[:200]` (or remove the limit entirely) so the full error message is visible in the VPS console. This matches the convention already used elsewhere in the runner (e.g., `disabled_reason` uses `[:200]`).

**Single line change:**
```python
# Before
print(f"    [CONTACT] Import failed for {phone}: {str(e)[:40]}")

# After
print(f"    [CONTACT] Import failed for {phone}: {str(e)[:200]}")
```

This will let you see the full Telegram error (likely "You tried to use a method that is not available for the current authorization key") which indicates the account session is broken or partially authorized.

