

# Improved Bulk JSON + Session Import System

## Overview

Enhance the existing JSON + session import system to ensure all account metadata from JSON files is properly stored and utilized, with better validation, feedback, and reliability.

## Current Issues Identified

1. **Fingerprint Update Logic**: Existing accounts with device info don't get updated when re-importing with new JSON metadata
2. **Missing 2FA Storage**: The `twoFA` field from JSON files is not being stored
3. **Limited Upload Feedback**: Users can't easily see which accounts have JSON metadata vs generated fingerprints
4. **No JSON Validation**: Missing validation before processing could cause silent failures

## Implementation Plan

### Phase 1: Database Schema Update

**Add 2FA column to telegram_accounts table:**
- Add `two_fa_password` column (text, nullable) to store the 2FA password from JSON
- This allows the runner to handle 2FA prompts automatically if needed

### Phase 2: Backend Processing Improvements

**File: `supabase/functions/process-account-upload/index.ts`**

1. **Store 2FA password from JSON**
   - Extract `twoFA` from JSON metadata
   - Store in new `two_fa_password` column

2. **Fix fingerprint update logic for existing accounts**
   - When JSON provides device info, ALWAYS update the fingerprint columns (even for existing accounts)
   - This ensures re-importing with new JSON updates the device info

3. **Improve logging**
   - Log exactly which fields came from JSON vs generated
   - Include summary in response: accounts with JSON API, accounts with JSON fingerprint

4. **Add JSON validation**
   - Validate `app_id` is a valid number
   - Validate `app_hash` is a valid hex string (32 chars)
   - Return specific errors for invalid JSON data

### Phase 3: Frontend Improvements

**File: `src/pages/Accounts.tsx`**

1. **Enhanced upload summary**
   - Show breakdown: X accounts with JSON API credentials, Y accounts with JSON fingerprints, Z with generated fingerprints
   - Display warning if JSON files are missing required fields

2. **JSON validation before upload**
   - Validate `app_id` and `app_hash` format before sending to backend
   - Show which JSON files have issues

3. **Visual indicators in upload dialog**
   - Show checkmarks for accounts with complete JSON metadata
   - Show warnings for accounts with partial or missing JSON

### Phase 4: Enhanced API Credential Logging

**File: `supabase/functions/get-next-task/index.ts`**

1. **Better logging for credential source**
   - Log clearly: "Using PER-ACCOUNT API: app_id=XXXX" vs "Using POOL API: app_id=XXXX"
   - Track success rates by credential source for analytics

## Technical Details

### JSON Field Mapping (Complete)
```
JSON Field          -> Database Column
-----------------------------------------
app_id              -> api_id (stored as string)
app_hash            -> api_hash
device              -> device_model
sdk                 -> system_version
app_version         -> app_version
lang_pack           -> lang_code
system_lang_pack    -> system_lang_code
twoFA               -> two_fa_password (NEW)
phone               -> phone_number (fallback)
session_file        -> phone_number (fallback)
```

### Validation Rules
- `app_id`: Must be numeric (converted to string for storage)
- `app_hash`: Must be 32-character hex string
- `device`: Any non-empty string
- `sdk`: Any non-empty string (e.g., "Windows 11", "Android 14")

### Response Structure (Enhanced)
```json
{
  "successful": 100,
  "failed": 2,
  "account_ids": ["uuid1", "uuid2", ...],
  "metadata_stats": {
    "with_json_api": 98,
    "with_json_fingerprint": 95,
    "with_generated_fingerprint": 5,
    "with_2fa": 12
  },
  "errors": ["phone1: Invalid app_hash format"]
}
```

## Summary of Changes

| Component | Change |
|-----------|--------|
| Database | Add `two_fa_password` column to `telegram_accounts` |
| `process-account-upload` | Store 2FA, fix fingerprint update, add validation, improve logging |
| `Accounts.tsx` | Enhanced upload feedback, JSON validation, visual indicators |
| `get-next-task` | Better credential source logging |

## Benefits

1. **Complete Data Capture**: All JSON fields including 2FA are stored
2. **Reliable Updates**: Re-importing accounts updates their fingerprints correctly
3. **Better Visibility**: Users see exactly what was imported from each account
4. **Error Prevention**: Validation catches issues before they cause problems
5. **Debugging**: Clear logs show which API credentials are being used

