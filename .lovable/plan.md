

# Change Auto-Assign Proxy Default to OFF

## Problem
The "Auto-assign available proxies" checkbox in the Add Accounts dialog defaults to **checked (ON)**. The user wants this to default to **unchecked (OFF)** so proxies are not automatically assigned when uploading accounts.

## Current Verification
From the database query, the upload functionality is working correctly:
- **Metadata fields saved correctly**: `api_id`, `api_hash`, `device_model`, `system_version`, `two_fa_password` are all populated from JSON
- **Session data**: Properly encoded and stored
- **Proxies being auto-assigned**: Current accounts have `proxy_id` set because auto-assign was enabled

## Solution
Change a single line in `src/pages/Accounts.tsx`:

**Line 149 - Change from:**
```typescript
const [autoAssignProxy, setAutoAssignProxy] = useState(true);
```

**To:**
```typescript
const [autoAssignProxy, setAutoAssignProxy] = useState(false);
```

## Behavior After Fix
| Scenario | Before Fix | After Fix |
|----------|-----------|-----------|
| Open Add Accounts dialog | Auto-assign checkbox is checked | Auto-assign checkbox is unchecked |
| Upload without checking the box | Proxies auto-assigned | No proxies assigned (manual assignment later) |
| User checks the box manually | Proxies auto-assigned | Proxies auto-assigned |

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/Accounts.tsx` | Line 149: Change `useState(true)` to `useState(false)` |

## Summary
This is a one-line change that sets the auto-assign proxy checkbox to be **unchecked by default**, allowing users to manually opt-in if they want automatic proxy assignment during upload.

