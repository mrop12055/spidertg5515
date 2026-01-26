
# Fix: Campaign Runner Phase Logging and Truncated Error Messages

## Issues Identified

### Issue 1: Truncated Error Messages

Error messages like **"You tried to use a method that is not av"** are being cut off because the Python code intentionally limits error output:

| Location | Limit | Example Output |
|----------|-------|----------------|
| Connect errors | 40 chars | "You tried to use a method that is not av" |
| Send errors | 60 chars | Truncated at 60 characters |
| Exception handler | 100 chars | Slightly longer but still cut |

**Full error message**: "You tried to use a method that is not available for your account" - This is a Telegram API error indicating the account is **FROZEN** or restricted.

### Issue 2: Phase Logging "showing not only 2,3"

The 5-phase pipeline logs are working correctly, but phase numbers display in the terminal output. If you're seeing unusual output, it may be due to:
- Multiple batches running in quick succession (overlapping logs)
- Log buffer issues in the terminal

---

## Technical Implementation

### Fix 1: Increase Error Message Length Limits

Update the Python code embedded in `SetupGuide.tsx` to show full error messages (up to 150-200 characters):

**Current (truncated):**
```python
print(f"    ✗ [{account_phone}] Connection error: {last_connection_error[:60]}")
print(f"    ✗ [{account_phone}] → {recipient}: {error_str[:60]}")
print(f"    ⚠ Connect [{acc_id[:8]}]: {str(e)[:40]}")
```

**Fixed (full error):**
```python
print(f"    ✗ [{account_phone}] Connection error: {last_connection_error[:150]}")
print(f"    ✗ [{account_phone}] → {recipient}: {error_str[:150]}")
print(f"    ⚠ Connect [{acc_id[:8]}]: {str(e)[:100]}")
```

### Fix 2: Add Phase Number Prefix to Logs

Make phase logging clearer with consistent formatting:

**Current:**
```python
print(f"  🔌 Phase 1: Connecting {len(account_tasks_map)} accounts...")
print(f"  📇 Phase 2: Importing contacts...")
```

**Fixed (clearer prefix):**
```python
print(f"  [1/5] 🔌 Connecting {len(account_tasks_map)} accounts...")
print(f"  [2/5] 📇 Importing contacts...")
print(f"  [3/5] ⏳ Safety wait {wait_time:.1f}s...")
print(f"  [4/5] 📤 Sending {len(tasks)} messages...")
print(f"  [5/5] 🔌 Disconnecting clients...")
```

---

## Files to Update

| File | Changes |
|------|---------|
| `src/pages/SetupGuide.tsx` | Update `process_batch_optimized` function phase logging |
| `src/pages/SetupGuide.tsx` | Update all error truncation limits from `[:40]`/`[:60]` to `[:150]` |

---

## Summary of Changes

1. **Error messages**: Increase truncation limit from 40-60 chars to 150 chars so full errors like "You tried to use a method that is not available for your account" are visible
2. **Phase logging**: Add `[X/5]` prefix format for clearer phase identification
3. **Consistent formatting**: Standardize error output across all locations in the runner code
