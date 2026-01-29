

# Fix Account Upload API Mismatch

## Problem Identified

The Accounts page upload feature is broken because of a mismatch between what the frontend expects and what the `admin-api` endpoint returns.

## Root Cause

When the edge functions were consolidated, the `/upload-accounts` endpoint in `admin-api` was simplified and lost several important features:

1. **Missing response fields** - Frontend expects `successful`, `failed`, `account_ids`, `metadata_stats` but API returns only `imported`
2. **Missing tag support** - Frontend sends `tags` parameter but API ignores it
3. **Missing 2FA field** - The `two_fa_password` field from JSON metadata is not being saved
4. **No duplicate handling** - API doesn't track which accounts failed due to duplicates
5. **No metadata statistics** - API doesn't track JSON metadata usage stats

## Current State

Frontend sends:
```typescript
body: { 
  path: '/upload-accounts', 
  accounts: chunk,  // Contains phone_number, session_data, api_id, api_hash, device_model, etc.
  tags: tagsToAssign  // Tags to assign to new accounts
}
```

Frontend expects:
```typescript
{
  successful: number,
  failed: number,
  account_ids: string[],
  metadata_stats: {
    with_json_api: number,
    with_json_fingerprint: number,
    with_generated_fingerprint: number,
    with_2fa: number,
  }
}
```

API currently returns:
```typescript
{
  success: true,
  imported: number  // Just the count
}
```

## Solution

Update the `admin-api` edge function's `/upload-accounts` route to:

1. Include `two_fa_password` in the insert data
2. Include `tags` array in the insert data
3. Handle duplicate phone numbers gracefully (upsert or skip)
4. Track and return proper success/failure counts
5. Return created account IDs
6. Calculate and return metadata statistics

## Implementation

### Changes to `supabase/functions/admin-api/index.ts`

Update the `/upload-accounts` handler (lines 232-261) with this enhanced logic:

```typescript
if (path === '/upload-accounts' && method === 'POST') {
  const { accounts, tags } = body;
  if (!accounts?.length) return jsonResponse({ error: "accounts array required" }, 400);

  let successful = 0;
  let failed = 0;
  const accountIds: string[] = [];
  const metadataStats = {
    with_json_api: 0,
    with_json_fingerprint: 0,
    with_generated_fingerprint: 0,
    with_2fa: 0,
  };

  // Process accounts one by one to handle duplicates gracefully
  for (const acc of accounts) {
    // Track metadata stats
    if (acc.api_id && acc.api_hash) metadataStats.with_json_api++;
    if (acc.device_model || acc.system_version) metadataStats.with_json_fingerprint++;
    if (acc.two_fa_password) metadataStats.with_2fa++;

    const insertData = {
      phone_number: acc.phone_number || acc.phone,
      session_data: acc.session_data || acc.session,
      first_name: acc.first_name,
      last_name: acc.last_name,
      username: acc.username,
      telegram_id: acc.telegram_id,
      api_id: acc.api_id,
      api_hash: acc.api_hash,
      device_model: acc.device_model,
      system_version: acc.system_version,
      app_version: acc.app_version,
      lang_code: acc.lang_code || 'en',
      system_lang_code: acc.system_lang_code || 'en-US',
      two_fa_password: acc.two_fa_password,  // NEW: Include 2FA password
      tags: tags || [],  // NEW: Include tags
      status: 'disconnected',
    };

    // Try to insert, skip if duplicate (phone_number is unique)
    const { data, error } = await supabase
      .from('telegram_accounts')
      .insert(insertData)
      .select('id')
      .single();

    if (error) {
      console.log(`[admin-api] Account ${acc.phone_number} failed: ${error.message}`);
      failed++;
    } else {
      successful++;
      if (data?.id) accountIds.push(data.id);
    }
  }

  return jsonResponse({
    success: true,
    successful,
    failed,
    account_ids: accountIds,
    metadata_stats: metadataStats,
  });
}
```

## Benefits After Fix

1. **Uploads will work correctly** - Response format matches frontend expectations
2. **Tags assigned on upload** - New accounts will have tags immediately
3. **2FA passwords saved** - Password from JSON metadata will be stored
4. **Clear feedback** - User sees accurate success/failure counts
5. **Auto-verify works** - Account IDs are returned for verification
6. **Metadata stats shown** - User sees how many accounts had API credentials, fingerprints, 2FA

## Files to Modify

| File | Change |
|------|--------|
| `supabase/functions/admin-api/index.ts` | Update `/upload-accounts` route with proper response format |

