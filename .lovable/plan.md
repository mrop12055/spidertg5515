

# Bulk JSON + Session Import System

## Overview

This plan implements a new bulk import system that reads account metadata directly from JSON files (containing `app_id`, `app_hash`, device fingerprints) alongside `.session` files. This approach eliminates the need for the centralized API credentials round-robin system, as each account will use its own embedded credentials.

## Current State Analysis

### Existing Architecture
1. **Account Upload Flow**: Currently accepts only `.session` files, extracting phone numbers from filenames
2. **API Credentials System**: Uses a centralized `telegram_api_credentials` table with round-robin rotation
3. **Round-Robin Flow**: `get-next-task` calls `selectNextApiCredential()` from the shared pool for every task
4. **Settings Page**: Has an "API Keys" tab with `ApiCredentialsManager` component for managing shared credentials

### Database Schema (Already Supports Per-Account Credentials)
- `telegram_accounts` table already has `api_id` and `api_hash` columns for per-account storage
- Device fingerprint columns exist: `device_model`, `system_version`, `app_version`, `lang_code`, `system_lang_code`, `build_id`

## Implementation Plan

### Phase 1: Enhanced File Upload (Frontend)

**File: `src/pages/Accounts.tsx`**

1. **Extend dropzone to accept JSON files**
   - Add `.json` to accepted file types alongside `.session`
   - Parse JSON files to extract metadata

2. **Add ZIP support for bulk upload**
   - User can upload a ZIP containing pairs of files:
     - `916207530928.json` (metadata)
     - `916207530928.session` (session data)
   - Or individual JSON + session files

3. **JSON Parsing Logic**
   Extract from each JSON:
   - `app_id` - Telegram API ID
   - `app_hash` - Telegram API Hash
   - `phone` - Phone number (fallback to filename)
   - `device` - Maps to `device_model`
   - `sdk` - Maps to `system_version`
   - `app_version` - Telegram app version
   - `lang_pack` / `system_lang_pack` - Language codes
   - `session_file` - Alternative phone number source

4. **File Matching Logic**
   - Match JSON to session files by phone number
   - If JSON provides `session_file` field, use that for matching
   - Display validation: show which files are paired/unpaired

### Phase 2: Backend Processing Updates

**File: `supabase/functions/process-account-upload/index.ts`**

1. **Accept extended account data structure**
   ```typescript
   interface AccountData {
     phone_number: string;
     session_data: string;
     api_id?: string;      // From JSON
     api_hash?: string;    // From JSON
     device_model?: string; // From JSON device field
     system_version?: string; // From JSON sdk field
     app_version?: string;  // From JSON
     lang_code?: string;    // From JSON lang_pack
     system_lang_code?: string; // From JSON system_lang_pack
   }
   ```

2. **Preserve JSON-provided fingerprints**
   - If JSON provides device info, use it instead of generating
   - Only generate fingerprints for accounts without JSON metadata

3. **Store per-account API credentials**
   - Save `api_id` and `api_hash` from JSON into the account record
   - These will be used by the runner instead of the shared pool

### Phase 3: Task Dispatch Updates (Use Per-Account Credentials)

**File: `supabase/functions/get-next-task/index.ts`**

1. **Priority order for API credentials**
   - First: Use account's own `api_id` and `api_hash` if present
   - Fallback: Use shared pool via `selectNextApiCredential()` (for legacy accounts)

2. **Update credential resolution logic**
   ```typescript
   // Check if account has its own credentials
   const accountApiId = account.api_id;
   const accountApiHash = account.api_hash;
   
   if (accountApiId && accountApiHash) {
     // Use per-account credentials (no pool lookup needed)
     api_id = accountApiId;
     api_hash = accountApiHash;
     api_credential_id = null; // No pool tracking
   } else {
     // Fallback to round-robin pool
     const poolApi = await selectNextApiCredential(supabase);
     // ... existing logic
   }
   ```

3. **Apply changes to all task types**
   - Livechat parallel mode
   - Livechat single mode
   - Campaign tasks
   - Account check tasks (spambot, etc.)
   - Warmup tasks

**File: `supabase/functions/_shared/api-helper.ts`**

1. **Add helper function for account credential priority**
   ```typescript
   export function getEffectiveApiCredentials(
     account: { api_id?: string; api_hash?: string },
     poolCredential: { api_id: string; api_hash: string; id: string } | null
   ): { api_id: string; api_hash: string; api_credential_id: string | null } | null
   ```

### Phase 4: Remove API Credentials System from UI

**File: `src/pages/Settings.tsx`**

1. **Remove "API Keys" tab entirely**
   - Delete the `<TabsContent value="api">` section
   - Remove `ApiCredentialsManager` import
   - Update tab grid from 3 columns to 2 columns

**File: `src/components/settings/ApiCredentialsManager.tsx`**

1. **Delete this component** (no longer needed)

### Phase 5: Cleanup (Optional - Can Be Done Later)

**Database Cleanup** (migrations to remove unused tables/columns):
- Mark `telegram_api_credentials` table as deprecated
- Can keep for backwards compatibility with existing accounts
- New accounts will use per-account credentials

## File Structure for Upload

Users should prepare files in one of these formats:

### Option 1: ZIP File
```
accounts.zip
├── 916207530928.json
├── 916207530928.session
├── 919876543210.json
├── 919876543210.session
└── ...
```

### Option 2: Individual Files
Drag and drop multiple JSON + session files together. The system will match them by phone number.

### JSON File Format (Expected)
```json
{
  "app_id": 2040,
  "app_hash": "b18441a1ff607e10a989891a5462e627",
  "sdk": "Windows 11",
  "device": "PRIME Z390-A",
  "app_version": "5.12.3 x64",
  "lang_pack": "tdesktop",
  "system_lang_pack": "en-US",
  "session_file": "916207530928",
  "phone": "916207530928",
  "twoFA": "8899"
}
```

## Technical Summary

| Component | Change |
|-----------|--------|
| `src/pages/Accounts.tsx` | Extend file upload to parse JSON + match with session files |
| `supabase/functions/process-account-upload/index.ts` | Accept and store per-account API credentials + device info from JSON |
| `supabase/functions/get-next-task/index.ts` | Use account's own credentials if present, fallback to pool |
| `supabase/functions/_shared/api-helper.ts` | Add helper for credential priority logic |
| `src/pages/Settings.tsx` | Remove "API Keys" tab |
| `src/components/settings/ApiCredentialsManager.tsx` | Delete component |

## Benefits

1. **Per-Account Isolation**: Each account uses its own API credentials, reducing shared risk
2. **Authentic Device Fingerprints**: Preserves original device info from the source
3. **No API Management Overhead**: Users don't need to add/manage API keys separately
4. **Simplified Architecture**: Credentials are bundled with accounts, not managed separately
5. **Scalability**: Works seamlessly for 2000+ accounts

