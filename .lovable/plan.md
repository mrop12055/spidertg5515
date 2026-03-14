

# Fix Account Upload: Use Original JSON Metadata (app_id/app_hash) and Block Shared APIs

## Problem Found

Your JSON files use `app_id` and `app_hash` as field names. The **Accounts.tsx** upload code at line 623 correctly maps these:
```
api_id: (metadata?.api_id || metadata?.app_id)?.toString()
api_hash: metadata?.api_hash || metadata?.app_hash
```

However, the **TelegramContext.tsx** upload code (lines 757-758) does NOT handle these field name variations:
```
api_id: metadata.api_id,      // misses app_id
api_hash: metadata.api_hash,  // misses app_hash
```

There are **two separate upload paths** in the codebase, and the one in TelegramContext doesn't map `app_id`/`app_hash`, `sdk`/`device`, `twoFA`, or `lang_pack` at all. Additionally, neither path blocks re-upload of existing accounts to update their metadata.

Also, **all 442 accounts currently have the same api_id (2040)** because your JSON files all came with that value. The system correctly read it, but it's the same across all accounts. To prevent future mass-blocks, uploads with shared API credentials will be blocked.

## Changes

### 1. Fix TelegramContext.tsx upload metadata mapping
Update the `uploadAccounts` function (lines 750-760) to handle all field name variations, matching Accounts.tsx:
- `app_id` -> `api_id`, `app_hash` -> `api_hash`
- `device` -> `device_model`, `sdk` -> `system_version`
- `twoFA` / `2fa` -> `two_fa_password`
- `lang_pack` -> `lang_code`, `system_lang_pack` -> `system_lang_code`

### 2. Add "Update Existing Accounts" mode to Accounts.tsx upload
Modify the backend `admin-api` `/upload-accounts` endpoint to support an `update_existing: true` flag:
- When true: if a phone number already exists, UPDATE its metadata (api_id, api_hash, device_model, system_version, app_version, lang_code, system_lang_code, two_fa_password, session_data) with the new values
- When false (default): skip existing accounts as before
- Add a toggle in the upload dialog: "Update existing accounts" checkbox

### 3. Block uploads with shared API credentials
Add validation in the frontend upload handler (Accounts.tsx `handleUploadSessions`):
- Before sending to backend, check if more than one account in the batch shares the same `api_id`
- If duplicates found, show an error toast: "Upload blocked: X accounts share the same API ID (Y). Each account must have unique API credentials."
- Do not proceed with the upload

### 4. Add validation in admin-api backend
In the `/upload-accounts` handler, add a server-side check:
- Count distinct `api_id` values in the incoming batch
- If any `api_id` is used by more than one account, reject the entire batch with an error

## File Changes

| File | Change |
|------|--------|
| `src/context/TelegramContext.tsx` | Fix metadata field mapping in `uploadAccounts` (add `app_id`, `app_hash`, `device`, `sdk`, `twoFA`, `lang_pack` support) |
| `src/pages/Accounts.tsx` | Add "Update existing accounts" toggle; add shared-API validation before upload |
| `supabase/functions/admin-api/index.ts` | Add `update_existing` mode to upsert metadata; add server-side shared-API validation |

