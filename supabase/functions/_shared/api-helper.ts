/**
 * API Credential Helper
 * 
 * Fetches API credentials from stored telegram_api_credentials table
 * instead of generating random ones. Accounts MUST have api_id and api_hash
 * assigned in their record (mirrored from their api_credential_id assignment).
 * 
 * If an account has no API assigned, it should be skipped.
 */

/**
 * Get API credentials from an account record.
 * Returns the account's stored api_id and api_hash.
 * If not present, returns null (account should be skipped).
 */
export function getAccountApiCredentials(account: {
  api_id?: string | null;
  api_hash?: string | null;
  telegram_api_credentials?: { api_id: string; api_hash: string } | null;
}): { api_id: string; api_hash: string } | null {
  // Priority 1: Use directly stored api_id/api_hash on account
  if (account.api_id && account.api_hash) {
    return {
      api_id: account.api_id,
      api_hash: account.api_hash
    };
  }
  
  // Priority 2: Use from joined telegram_api_credentials relation
  const creds = account.telegram_api_credentials;
  if (creds?.api_id && creds?.api_hash) {
    return {
      api_id: creds.api_id,
      api_hash: creds.api_hash
    };
  }
  
  // No API credentials found
  return null;
}

/**
 * Check if account has valid API credentials
 */
export function hasApiCredentials(account: {
  api_id?: string | null;
  api_hash?: string | null;
  telegram_api_credentials?: { api_id: string; api_hash: string } | null;
}): boolean {
  return getAccountApiCredentials(account) !== null;
}
