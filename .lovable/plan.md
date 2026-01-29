

# Fix Account Upload to Work with Python Runner

## Problem Summary

When uploading Telegram accounts with session + JSON files, all the required data needs to be correctly saved to the database so the Python runner can connect and run these accounts. The Python runner requires:

1. **Session data** (base64 encoded)
2. **API credentials** (`api_id`, `api_hash`) 
3. **Device fingerprint** (`device_model`, `system_version`, `app_version`)
4. **Assigned proxy** with active status

## Current State Analysis

After reviewing the code:

**Frontend (Accounts.tsx)** - Correctly maps JSON fields:
- `app_id` → `api_id`
- `app_hash` → `api_hash`  
- `device` → `device_model`
- `sdk` → `system_version`
- `twoFA` → `two_fa_password`
- `lang_pack` → `lang_code`
- `system_lang_pack` → `system_lang_code`

**API (admin-api)** - Saves all fields correctly since last fix.

**Python Runner** - Requires at connection time:
```python
if not acc.get("device_model") or not acc.get("api_id"):
    return None, "No fingerprint/API"
```

## Issues Identified

### Issue 1: JSON Format Variations
Some JSON files may use different field names. Need to handle:
- `api_id` OR `app_id`
- `api_hash` OR `app_hash`
- `device` OR `device_model`
- `sdk` OR `system_version`
- `twoFA` OR `two_fa_password` OR `2fa`

### Issue 2: Proxy Assignment
Accounts are uploaded without proxies. The Python runner won't connect accounts that don't have an active proxy. Users need to:
1. Upload accounts
2. Assign proxies to accounts

### Issue 3: Build ID Not Captured
The JSON may contain a `build_id` field that isn't being mapped.

## Solution

### Phase 1: Enhance JSON Metadata Interface

Update `JsonMetadata` interface to handle all known field name variations:

```typescript
interface JsonMetadata {
  // API credentials (multiple naming conventions)
  app_id?: number | string;
  api_id?: number | string;
  app_hash?: string;
  api_hash?: string;
  
  // Device fingerprint (multiple naming conventions)
  device?: string;
  device_model?: string;
  sdk?: string;
  system_version?: string;
  app_version?: string;
  build_id?: string;
  
  // Language settings
  lang_pack?: string;
  lang_code?: string;
  system_lang_pack?: string;
  system_lang_code?: string;
  
  // Session/Phone
  session_file?: string;
  phone?: string;
  
  // 2FA (multiple naming conventions)
  twoFA?: string;
  two_fa_password?: string;
  '2fa'?: string;
}
```

### Phase 2: Enhance Upload Handler

Update the account building logic in `handleUploadSessions` to handle all field name variations:

```typescript
const accountsToUpload = sessionFiles.map(sf => {
  const metadata = (sf as any).metadata as JsonMetadata | undefined;
  return {
    phone_number: sf.phoneNumber,
    session_data: sf.base64Data,
    // API credentials - try multiple field names
    api_id: (metadata?.api_id || metadata?.app_id)?.toString(),
    api_hash: metadata?.api_hash || metadata?.app_hash,
    // Device fingerprint - try multiple field names
    device_model: metadata?.device_model || metadata?.device,
    system_version: metadata?.system_version || metadata?.sdk,
    app_version: metadata?.app_version,
    build_id: metadata?.build_id,
    // Language settings
    lang_code: metadata?.lang_code || metadata?.lang_pack,
    system_lang_code: metadata?.system_lang_code || metadata?.system_lang_pack,
    // 2FA - try multiple field names
    two_fa_password: metadata?.two_fa_password || metadata?.twoFA || metadata?.['2fa'],
  };
});
```

### Phase 3: Update API to Handle All Fields

Update `admin-api` to include `build_id` in the insert data:

```typescript
const insertData = {
  phone_number: acc.phone_number || acc.phone,
  session_data: acc.session_data || acc.session,
  // ... existing fields ...
  build_id: acc.build_id,  // ADD THIS
  // ...
};
```

### Phase 4: Add Auto-Assign Proxy Option

Add an option during upload to automatically assign available proxies to new accounts:

1. Add checkbox "Auto-assign available proxies"
2. After upload, query available proxies (no `assigned_account_id`)
3. Assign one proxy per account until proxies run out
4. Show result: "12 accounts uploaded, 10 assigned proxies, 2 waiting for proxies"

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Accounts.tsx` | 1. Expand `JsonMetadata` interface for all field variations<br>2. Update field mapping logic in `handleUploadSessions`<br>3. Add auto-assign proxy checkbox and logic |
| `supabase/functions/admin-api/index.ts` | Add `build_id` to insert data |

## Post-Upload Workflow

After upload:
1. Accounts are created with status `disconnected`
2. User assigns proxies (or auto-assign handles it)
3. Python runner picks up accounts with:
   - Session data
   - API credentials
   - Device fingerprint
   - Active proxy
4. Runner connects and changes status to `active`

## Testing Checklist

- [ ] Upload session + JSON from ZIP file
- [ ] Verify all metadata fields saved correctly in database
- [ ] Assign proxy to uploaded account
- [ ] Verify Python runner can connect account
- [ ] Test with various JSON field naming conventions

