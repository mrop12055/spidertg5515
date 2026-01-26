
# Complete Plan: Show Exact Telegram Error Messages + Proper Error Classification

This comprehensive plan covers ALL the changes we discussed:
1. Show exact Telegram errors (no prefixes/wrappers) in Recent Errors dashboard
2. Show exact Telegram errors in Task Queue dashboard
3. Distinguish between RECIPIENT errors (skip recipient) vs ACCOUNT errors (retry with different account)
4. Add all official Telegram error codes you provided

---

## Part 1: Update `report-session-check/index.ts` - Remove Error Prefixes

**Current code (lines 140-157):**
```typescript
if (isBanned) {
  banReason = `Account banned/deleted: ${error}`;  // ❌ Prefix
} else if (isSessionExpired) {
  banReason = `Session expired/invalid: ${error}`;  // ❌ Prefix
} else if (isRestricted) {
  banReason = `Temporarily restricted: ${error}`;  // ❌ Prefix
} else {
  banReason = `Connection error: ${error}`;  // ❌ Prefix
}
```

**New code:**
```typescript
if (isBanned) {
  banReason = error;  // ✅ Raw error only
} else if (isSessionExpired) {
  banReason = error;  // ✅ Raw error only
} else if (isRestricted) {
  banReason = error;  // ✅ Raw error only
} else {
  banReason = error;  // ✅ Raw error only
}
```

**Add new session error patterns (lines 119-127):**
```typescript
const sessionExpiredPatterns = [
  "session expired",
  "session revoked",
  "sessionrevoked",
  "auth key duplicated",
  "authkeyduplicatederror",
  "unauthorized",
  "invalid session",
  // ADD: Official Telegram session errors
  "phone_code_hash_empty",
  "phone_code_empty",
  "phone_code_expired",
  "type_constructor_invalid",
  "api_id_invalid",
];
```

---

## Part 2: Update `report-task-result/index.ts` - Error Classification + Raw Errors

### 2.1 Add Official Telegram Error Codes

**Update `skipRecipientErrors` (lines 488-495) - ONLY recipient errors that should mark recipient as failed:**
```typescript
const skipRecipientErrors = [
  'user not found',
  'no user',
  'peer_id_invalid',
  'user was deleted',
  'specified user',
  'user deleted',
  // ADD: Official Telegram RECIPIENT errors (recipient-side issues)
  'phone_number_invalid',      // Recipient phone format is wrong
  'phone_number_unoccupied',   // Recipient is NOT on Telegram
];
```

**Add NEW category for ACCOUNT session/API errors (NOT recipient errors):**
```typescript
// NEW: Account session/API errors - DO NOT skip recipient, retry with different account
const accountSessionErrors = [
  'api_id_invalid',           // API credentials invalid
  'phone_code_hash_empty',    // Session issue
  'phone_code_empty',         // Session issue
  'phone_code_expired',       // Session expired
  'type_constructor_invalid', // Protocol/session issue
  'firstname_invalid',        // Account setup issue
  'lastname_invalid',         // Account setup issue
];
```

**Add NEW category for media/file errors (skip operation, not recipient):**
```typescript
// Media/file errors - skip this operation, not a recipient issue
const mediaFileErrors = [
  'file_part_invalid',
  'file_parts_invalid',
  'file_part_',  // catches FILE_PART_X_MISSING
  'md5_checksum_invalid',
  'photo_invalid_dimensions',
  'field_name_invalid',
  'field_name_empty',
];
```

### 2.2 Add Account Session Error Handling Logic

After line 515 (isSkipOnly check), add:
```typescript
// Check if it's an ACCOUNT session/API error - should mark account as disconnected
// and retry recipient with different account (NOT skip the recipient!)
const isAccountSessionError = accountSessionErrors.some(r => errorLower.includes(r));

// Check if it's a media/file error - skip operation but don't affect account or recipient
const isMediaError = mediaFileErrors.some(r => errorLower.includes(r));
```

**Add handling for account session errors (after line 665):**
```typescript
} else if (isAccountSessionError && account_id && campaign_recipient_id) {
  // ACCOUNT SESSION/API ERROR - mark account as disconnected, retry recipient with different account
  console.log(`[report-task-result] Account ${account_id} session/API error - resetting recipient for different account: ${error}`);
  
  await supabase
    .from("telegram_accounts")
    .update({
      status: "disconnected",
      ban_reason: error,  // ✅ Raw error
    })
    .eq("id", account_id);
  
  // Reset recipient for different account (NOT failed - this is an account issue, not recipient)
  const { data: currentRecipient } = await supabase
    .from("campaign_recipients")
    .select("failed_account_ids")
    .eq("id", campaign_recipient_id)
    .single();
  
  const failedAccountIds: string[] = currentRecipient?.failed_account_ids || [];
  if (!failedAccountIds.includes(account_id)) {
    failedAccountIds.push(account_id);
  }
  
  await supabase
    .from("campaign_recipients")
    .update({
      status: "pending",
      sent_by_account_id: null,
      api_credential_id: null,
      failed_reason: null,
      failed_account_ids: failedAccountIds,
      scheduled_at: null,
    })
    .eq("id", campaign_recipient_id);
    
  console.log(`[report-task-result] Recipient ${campaign_recipient_id} reset for pickup by different account (account session error)`);
}
```

### 2.3 Update All `failed_reason` Assignments to Use Raw Error

**Line 565:**
```typescript
// CURRENT:
failed_reason: `Failed after ${retryCount + 1} attempts: Privacy restricted`,
// CHANGE TO:
failed_reason: error,  // ✅ Raw error
```

---

## Part 3: Update `report-batch-results/index.ts` - Error Classification + Raw Errors

### 3.1 Add Error Classification for Permanent Failures

**Before line 520 (Handle permanent failures), add error classification:**
```typescript
// Classify "permanent" errors into actual recipient failures vs account errors
const recipientErrorPatterns = [
  'user not found',
  'no user',
  'peer_id_invalid',
  'user was deleted',
  'phone_number_invalid',
  'phone_number_unoccupied',
];

const accountErrorPatterns = [
  'api_id_invalid',
  'phone_code',
  'type_constructor_invalid',
  'firstname_invalid',
  'lastname_invalid',
  'auth_key',
  'session',
];

// Split permanent into actual recipient failures vs account errors
const actualRecipientFailures = permanent.filter(r => {
  const errorLower = (r.error || '').toLowerCase();
  const isRecipientError = recipientErrorPatterns.some(e => errorLower.includes(e));
  const isAccountError = accountErrorPatterns.some(e => errorLower.includes(e));
  // Only mark as failed if it's definitely a recipient issue, not an account issue
  return isRecipientError || (!isAccountError && !errorLower.includes('session'));
});

const accountErrorResults = permanent.filter(r => {
  const errorLower = (r.error || '').toLowerCase();
  return accountErrorPatterns.some(e => errorLower.includes(e));
});
```

### 3.2 Handle Account Errors Separately

**Replace permanent handling (lines 520-541) with:**
```typescript
// Handle ACTUAL recipient failures (only recipient-related errors)
if (actualRecipientFailures.length > 0) {
  const permanentIds = actualRecipientFailures.map((r) => r.campaign_recipient_id);
  failPromises.push(
    asPromise(
      supabase
        .from("campaign_recipients")
        .update({ status: "failed" })
        .in("id", permanentIds)
    )
  );

  for (const r of actualRecipientFailures) {
    failPromises.push(
      asPromise(
        supabase
          .from("campaign_recipients")
          .update({ failed_reason: r.error })  // ✅ Raw error
          .eq("id", r.campaign_recipient_id)
      )
    );
  }
}

// Handle ACCOUNT errors - mark account as disconnected, reset recipient for different account
for (const r of accountErrorResults) {
  failPromises.push(
    (async () => {
      // Mark account as disconnected
      if (r.account_id) {
        await supabase
          .from("telegram_accounts")
          .update({
            status: "disconnected",
            ban_reason: r.error,  // ✅ Raw error
          })
          .eq("id", r.account_id);
        console.log(`[report-batch-results] Account ${r.account_id} disconnected (session/API error): ${r.error}`);
      }

      // Reset recipient for different account
      const { data: current } = await supabase
        .from("campaign_recipients")
        .select("failed_account_ids")
        .eq("id", r.campaign_recipient_id)
        .single();

      const failedIds: string[] = current?.failed_account_ids || [];
      if (r.account_id && !failedIds.includes(r.account_id)) {
        failedIds.push(r.account_id);
      }

      await supabase
        .from("campaign_recipients")
        .update({
          status: "pending",
          failed_reason: null,
          failed_account_ids: failedIds,
          sent_by_account_id: null,
          api_credential_id: null,
          scheduled_at: null,
        })
        .eq("id", r.campaign_recipient_id);
        
      console.log(`[report-batch-results] Recipient ${r.campaign_recipient_id} reset for different account (account error)`);
    })()
  );
}
```

### 3.3 Update Frozen Account Handler (line 484)

```typescript
// CURRENT:
ban_reason: r.error || "Account frozen by Telegram",
// CHANGE TO:
ban_reason: r.error || "frozen",  // ✅ Shorter fallback
```

---

## Part 4: Summary of All Changes

### Files to Update

| File | Change Type | Description |
|------|-------------|-------------|
| `report-session-check/index.ts` | Remove prefixes | Change `banReason = "Prefix: ${error}"` to `banReason = error` |
| `report-session-check/index.ts` | Add patterns | Add new Telegram session error codes |
| `report-task-result/index.ts` | Add patterns | Add official Telegram error codes for recipients, accounts, media |
| `report-task-result/index.ts` | Add logic | Handle account session errors separately (don't skip recipient) |
| `report-task-result/index.ts` | Fix `failed_reason` | Use raw `error` instead of custom messages |
| `report-batch-results/index.ts` | Classify errors | Split "permanent" into recipient failures vs account errors |
| `report-batch-results/index.ts` | Add handling | Account errors reset recipient for different account |
| `report-batch-results/index.ts` | Fix `ban_reason` | Use raw `error` for all statuses |

### Complete Telegram Error Code Reference

| Error Code | Type | Action |
|------------|------|--------|
| `PHONE_NUMBER_INVALID` | Recipient | Mark recipient as failed |
| `PHONE_NUMBER_UNOCCUPIED` | Recipient | Mark recipient as failed (not on Telegram) |
| `API_ID_INVALID` | Account | Mark account disconnected, retry with different account |
| `PHONE_CODE_HASH_EMPTY` | Account | Mark account disconnected |
| `PHONE_CODE_EMPTY` | Account | Mark account disconnected |
| `PHONE_CODE_EXPIRED` | Account | Mark account disconnected |
| `TYPE_CONSTRUCTOR_INVALID` | Account | Mark account disconnected |
| `FIRSTNAME_INVALID` | Account | Mark account disconnected |
| `LASTNAME_INVALID` | Account | Mark account disconnected |
| `PHONE_NUMBER_OCCUPIED` | Info | Log only (not an error for our use case) |
| `USERS_TOO_FEW` | Operation | Skip operation |
| `USERS_TOO_MUCH` | Operation | Skip operation |
| `FILE_PART_INVALID` | Media | Skip operation |
| `FILE_PARTS_INVALID` | Media | Skip operation |
| `FILE_PART_X_MISSING` | Media | Skip operation |
| `MD5_CHECKSUM_INVALID` | Media | Skip operation |
| `PHOTO_INVALID_DIMENSIONS` | Media | Skip operation |
| `FIELD_NAME_INVALID` | General | Skip operation |
| `FIELD_NAME_EMPTY` | General | Skip operation |

### Expected Dashboard Display After Changes

**Recent Errors Card will show:**
- `UserDeactivatedError` instead of `Account banned/deleted: UserDeactivatedError`
- `PHONE_NUMBER_UNOCCUPIED` instead of `Connection error: PHONE_NUMBER_UNOCCUPIED`
- `API_ID_INVALID` instead of `Session expired/invalid: API_ID_INVALID`
- `UserPrivacyRestrictedError` instead of `Failed after 2 attempts: Privacy restricted`

**Task Queue will show:**
- Raw `failed_reason` from Telegram in the Error column
- No custom prefixes or retry count text

---

## Technical Flow Diagram

```text
Telegram Error Received
         |
         v
  ┌──────────────────────┐
  │ Is it RECIPIENT error?│
  │ (PHONE_NUMBER_INVALID,│
  │  PHONE_NUMBER_UNOCCUPIED,│
  │  user not found, etc.)│
  └───────┬──────────────┘
          │
     YES  │  NO
          │   │
          v   v
   ┌─────────┐  ┌──────────────────────┐
   │ Mark    │  │ Is it ACCOUNT error? │
   │recipient│  │ (API_ID_INVALID,     │
   │as FAILED│  │  PHONE_CODE_EXPIRED, │
   │         │  │  session errors)     │
   └─────────┘  └───────┬──────────────┘
                        │
                   YES  │  NO
                        │   │
                        v   v
                 ┌─────────────┐  ┌─────────────┐
                 │ Mark account│  │ Is it MEDIA │
                 │ disconnected│  │ error?      │
                 │ Reset       │  └──────┬──────┘
                 │ recipient   │         │
                 │ to PENDING  │    YES  │  NO
                 └─────────────┘         │   │
                                         v   v
                                  ┌──────────┐ ┌────────────┐
                                  │ Skip     │ │ Unknown -  │
                                  │ operation│ │ retry with │
                                  │ only     │ │ diff acct  │
                                  └──────────┘ └────────────┘
```

This ensures recipients are only marked as "failed" when the issue is genuinely with the recipient (not on Telegram, invalid phone format), while account issues trigger a retry with a different account.
