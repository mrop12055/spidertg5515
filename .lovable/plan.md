

# Fix: Only Fetch Incoming Messages (Skip Own Sent Messages)

## Problem
When fetching unread messages during catch-up, the runner is also reporting messages that YOU sent. These get recorded as "recipient replied" even though they're your own outgoing messages.

## Root Cause
In the `fetch_unread_messages()` function (lines 948-1006), the code fetches all messages from a dialog but never checks WHO sent each message. Telethon messages have an `out` property:
- `msg.out = True` means YOU sent this message
- `msg.out = False` means the OTHER person sent this message

Currently, ALL messages are processed and reported as "incoming_message", even your own sent ones.

## Solution
Add a simple check to skip outgoing messages:

### File: `src/pages/SetupGuide.tsx`

**Location:** Line 953-960, inside the message loop

**Before:**
```python
for msg in reversed(messages):  # Process oldest first
    if not msg.text and not msg.media:
        continue
    
    # SKIP messages older than 24 hours
    if msg.date and msg.date < cutoff_time:
        skipped_old += 1
        continue
```

**After:**
```python
for msg in reversed(messages):  # Process oldest first
    if not msg.text and not msg.media:
        continue
    
    # SKIP our own outgoing messages - only process incoming from recipient
    if msg.out:
        continue
    
    # SKIP messages older than 24 hours
    if msg.date and msg.date < cutoff_time:
        skipped_old += 1
        continue
```

## Technical Details

The `msg.out` property is a boolean provided by Telethon:
- When `True`: This message was sent FROM the account (outgoing)
- When `False`: This message was sent TO the account (incoming)

By adding `if msg.out: continue`, we skip all outgoing messages and only process messages actually sent by the recipient.

## Expected Result

| Before | After |
|--------|-------|
| Your sent messages + recipient messages all reported as "incoming" | Only recipient's messages reported |
| Conversations show duplicate/wrong "recipient replied" entries | Clean incoming message history |

