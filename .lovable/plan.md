
# Plan: Fix Campaign Recipient Extraction Bug

## Problem Found

The Python runner is receiving recipient data as an **object** (dictionary) but treating it as a **string**:

```text
Edge Function sends:
  recipient: { phone: "+919176830038", name: null, ... }

Python extracts:
  task.get("recipient")  →  {"phone": "+919176830038", ...}  (dict, not string!)

Python then calls:
  send_message(client, "{'phone': '+919...'}", ...)  →  FAILS
```

The error `Recipient not found` occurs because the code is trying to use `{'phone': '+919...'}` as a phone number.

---

## Solution

Update the recipient extraction logic in the Python runner to handle both:
1. **String format** (phone number directly)
2. **Object format** (dictionary with `phone` key)

### File: `src/pages/SetupGuide.tsx`

**Change in `process()` function (around line 1095-1101):**

```python
# Extract recipient - handle both string and object formats
raw_recipient = (
    task.get("recipient") or 
    td.get("recipient_phone") or 
    td.get("recipient_telegram_id") or 
    msg.get("recipient") or 
    msg.get("recipient_phone")
)

# If recipient is a dict (from campaign), extract the phone/telegram_id
if isinstance(raw_recipient, dict):
    recipient = (
        raw_recipient.get("phone") or 
        raw_recipient.get("telegram_id") or 
        raw_recipient.get("username") or 
        ""
    )
else:
    recipient = raw_recipient
```

---

## What This Fixes

| Before | After |
|--------|-------|
| `recipient = {"phone": "+91..."}` | `recipient = "+919176830038"` |
| Passed dict to `send_message()` | Passed actual phone string |
| "Recipient not found" for ALL | Messages sent successfully |

---

## Root Cause Analysis

The edge function correctly structures campaign tasks with recipient as an object:
```javascript
recipient: {
  phone: r.phone_number,      // "+919176830038"
  name: r.name,               // null
  telegram_id: null,
  username: null,
}
```

But the Python runner assumed `task.get("recipient")` would return a string, not a dict.

---

## Summary

Single change to extract the phone number from the recipient object when it's a dictionary instead of a string.

After this fix, re-download the `unified_runner.py` from the Setup Guide and restart it.
