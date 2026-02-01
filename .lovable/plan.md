
# Remove Pool API Fallback - Use Only Per-Account Credentials

## Overview
This change modifies the API credential selection to exclusively use per-account credentials (stored in `telegram_accounts.api_id` and `api_hash` from JSON imports), removing the fallback to the shared pool from `telegram_api_credentials`.

## Current State
- **All 820 active accounts already have their own credentials** - the pool fallback is not being used
- The system checks per-account first, then falls back to pool (round-robin from `telegram_api_credentials`)
- Pool logic exists in two places:
  1. `supabase/functions/_shared/api-helper.ts` - shared helper
  2. `supabase/functions/runner-tasks/index.ts` - inlined function

## Changes Required

### 1. Modify `runner-tasks/index.ts` - Remove Pool Fallback
**Lines 101-115** - Simplify `getApiCredentialsForAccount` to only use per-account credentials:

```text
BEFORE:
async function getApiCredentialsForAccount(supabase: any, account: any) {
  if (account.api_id && account.api_hash) {
    return { api_id: account.api_id, api_hash: account.api_hash, api_credential_id: null };
  }
  // FALLBACK: Query pool
  const { data: apis } = await supabase.from('telegram_api_credentials')...
  if (apis && apis.length > 0) return pool_credential;
  return null;
}

AFTER:
async function getApiCredentialsForAccount(supabase: any, account: any) {
  if (account.api_id && account.api_hash) {
    console.log(`[api] Using per-account API for ${account.phone_number}: ${account.api_id}`);
    return { api_id: account.api_id, api_hash: account.api_hash, api_credential_id: null };
  }
  console.warn(`[api] Account ${account.phone_number} has no API credentials - skipping`);
  return null;
}
```

### 2. Modify `_shared/api-helper.ts` - Remove Pool Fallback
**Lines 32-61** - Update main function to skip pool:

```text
BEFORE:
- Uses selectNextApiCredential() as fallback
- Returns pool credential if account has no own credentials

AFTER:
- Returns null immediately if account has no own credentials
- Logs warning about missing credentials
```

### 3. Keep Pool Functions for Backwards Compatibility (No Changes)
The following functions remain but are unused:
- `selectNextApiCredential()` - not called anymore
- `recordApiUsage()` - still works (handles null api_credential_id gracefully)
- `increment_api_usage` RPC - still exists for any pool usage

## Behavior After Change
- Accounts **with** `api_id` + `api_hash`: Work normally using their own credentials
- Accounts **without** credentials: Will be **skipped** for tasks (cannot send messages)
- Pool table (`telegram_api_credentials`): No longer queried for credential selection

## Technical Details

### Files to Modify
1. `supabase/functions/runner-tasks/index.ts`
2. `supabase/functions/_shared/api-helper.ts`

### Impact
- **Performance**: Slightly faster (no pool query when account has credentials)
- **Security**: Ensures each account uses only its designated API credentials
- **Risk**: Accounts imported without credentials will not work until credentials are added
  - Current data shows 0 accounts affected (all 820 have credentials)

### No Database Changes Required
The `telegram_api_credentials` pool table remains unchanged for historical reference.
