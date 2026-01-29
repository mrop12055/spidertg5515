/**
 * Round-Robin API Credential Helper
 * 
 * BUILD: 2026-01-25-accurate-tracking-v3
 * 
 * ARCHITECTURE: "Increment on Success" (not on assignment)
 * - selectNextApiCredential(): Returns API WITHOUT incrementing (for task assignment)
 * - recordApiUsage(): Called ONLY when message is successfully sent
 * 
 * This ensures usage counts reflect ACTUAL message sends, not polling/assignment overhead.
 */

/**
 * SELECT the next API credential using round-robin rotation.
 * DOES NOT increment usage - that happens via recordApiUsage() on success.
 * 
 * @param supabase - Supabase client instance
 * @returns API credentials object (including id for tracking) or null if no APIs available
 */
export async function selectNextApiCredential(
  supabase: any
): Promise<{ id: string; api_id: string; api_hash: string } | null> {
  // Get active API with lowest usage_count (round-robin selection)
  const { data: apis, error } = await supabase
    .from('telegram_api_credentials')
    .select('id, api_id, api_hash, usage_count')
    .eq('is_active', true)
    .order('usage_count', { ascending: true })
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .limit(1);

  if (error || !apis || apis.length === 0) {
    console.error('[api-helper] No active APIs available:', error?.message || 'No APIs found');
    return null;
  }

  const api = apis[0];
  console.log(`[api-helper] Selected API ${api.api_id} (current usage: ${api.usage_count || 0}) - NO increment on assignment`);

  return {
    id: api.id,
    api_id: api.api_id,
    api_hash: api.api_hash
  };
}

/**
 * SELECT multiple API credentials for batch operations using round-robin.
 * DOES NOT increment usage - that happens via recordApiUsage() on success.
 * 
 * @param supabase - Supabase client instance
 * @param count - Number of API credentials needed
 * @returns Array of API credential objects (including id for tracking)
 */
export async function selectMultipleApiCredentials(
  supabase: any,
  count: number
): Promise<Array<{ id: string; api_id: string; api_hash: string }>> {
  if (count <= 0) return [];

  // Get all active APIs sorted by usage
  const { data: apis, error } = await supabase
    .from('telegram_api_credentials')
    .select('id, api_id, api_hash, usage_count')
    .eq('is_active', true)
    .order('usage_count', { ascending: true });

  if (error || !apis || apis.length === 0) {
    console.error('[api-helper] No active APIs for batch:', error?.message || 'No APIs found');
    return [];
  }

  const results: Array<{ id: string; api_id: string; api_hash: string }> = [];

  // Distribute tasks across APIs in round-robin fashion (without incrementing)
  for (let i = 0; i < count; i++) {
    const api = apis[i % apis.length];
    results.push({
      id: api.id,
      api_id: api.api_id,
      api_hash: api.api_hash
    });
  }

  console.log(`[api-helper] Selected ${count} APIs across ${apis.length} available - NO increment on assignment`);
  return results;
}

/**
 * RECORD API usage after a successful message send.
 * This is the ONLY place where usage_count is incremented.
 * Uses atomic RPC to prevent race conditions.
 * 
 * @param supabase - Supabase client instance
 * @param apiCredentialId - The UUID of the API credential that was used
 */
export async function recordApiUsage(
  supabase: any,
  apiCredentialId: string
): Promise<void> {
  if (!apiCredentialId) {
    console.warn('[api-helper] recordApiUsage called without apiCredentialId');
    return;
  }

  // ATOMIC INCREMENT via RPC (prevents race conditions under high concurrency)
  const { error: rpcError } = await supabase.rpc('increment_api_usage', { p_api_id: apiCredentialId });
  
  if (rpcError) {
    // Fallback to direct update if RPC fails
    console.warn('[api-helper] RPC failed, using fallback:', rpcError.message);
    await supabase
      .from('telegram_api_credentials')
      .update({
        usage_count: supabase.sql`COALESCE(usage_count, 0) + 1`,
        daily_usage: supabase.sql`COALESCE(daily_usage, 0) + 1`,
        last_used_at: new Date().toISOString()
      })
      .eq('id', apiCredentialId);
  }

  console.log(`[api-helper] Recorded usage for API ${apiCredentialId} (incremented on successful send)`);
}

/**
 * BATCH record API usage for multiple successful sends.
 * More efficient than calling recordApiUsage() multiple times.
 * 
 * @param supabase - Supabase client instance
 * @param apiCredentialIds - Array of API credential UUIDs that were successfully used
 */
export async function recordBatchApiUsage(
  supabase: any,
  apiCredentialIds: string[]
): Promise<void> {
  if (!apiCredentialIds || apiCredentialIds.length === 0) return;

  // Count occurrences of each API
  const usageCounts = new Map<string, number>();
  for (const id of apiCredentialIds) {
    if (id) {
      usageCounts.set(id, (usageCounts.get(id) || 0) + 1);
    }
  }

  // Call RPC for each API (in parallel)
  const updatePromises: Promise<any>[] = [];
  for (const [apiId, count] of usageCounts) {
    // Call RPC 'count' times for this API (each call increments by 1)
    for (let i = 0; i < count; i++) {
      updatePromises.push(
        supabase.rpc('increment_api_usage', { p_api_id: apiId })
      );
    }
  }

  await Promise.all(updatePromises);
  console.log(`[api-helper] Batch recorded usage for ${apiCredentialIds.length} successful sends`);
}

/**
 * Check if there are any active API credentials available
 * 
 * @param supabase - Supabase client instance
 * @returns true if APIs are available, false otherwise
 */
export async function hasAvailableApis(supabase: any): Promise<boolean> {
  const { count, error } = await supabase
    .from('telegram_api_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);

  return !error && (count || 0) > 0;
}

/**
 * Reset usage counts for all APIs (for daily reset)
 * 
 * @param supabase - Supabase client instance
 */
export async function resetApiUsageCounts(supabase: any): Promise<void> {
  await supabase
    .from('telegram_api_credentials')
    .update({ usage_count: 0 })
    .eq('is_active', true);

  console.log('[api-helper] Reset all API usage counts');
}

// =============================================
// LEGACY EXPORTS (for backwards compatibility)
// These now delegate to the new selection functions
// =============================================

/**
 * @deprecated Use selectNextApiCredential() instead. This legacy function
 * previously incremented on assignment, which caused over-counting.
 */
export async function getNextApiCredential(
  supabase: any
): Promise<{ api_id: string; api_hash: string } | null> {
  const result = await selectNextApiCredential(supabase);
  if (!result) return null;
  // Return without id for backwards compatibility with old callers
  return {
    api_id: result.api_id,
    api_hash: result.api_hash
  };
}

/**
 * @deprecated Use selectMultipleApiCredentials() instead.
 */
export async function getMultipleApiCredentials(
  supabase: any,
  count: number
): Promise<Array<{ api_id: string; api_hash: string }>> {
  const results = await selectMultipleApiCredentials(supabase, count);
  // Return without id for backwards compatibility
  return results.map(r => ({
    api_id: r.api_id,
    api_hash: r.api_hash
  }));
}

// Legacy exports for backwards compatibility (not used, but prevents import errors)
export function getAccountApiCredentials(account: {
  api_id?: string | null;
  api_hash?: string | null;
  telegram_api_credentials?: { api_id: string; api_hash: string } | null;
}): { api_id: string; api_hash: string } | null {
  if (account.api_id && account.api_hash) {
    return { api_id: account.api_id, api_hash: account.api_hash };
  }
  const creds = account.telegram_api_credentials;
  if (creds?.api_id && creds?.api_hash) {
    return { api_id: creds.api_id, api_hash: creds.api_hash };
  }
  return null;
}

export function hasApiCredentials(account: {
  api_id?: string | null;
  api_hash?: string | null;
  telegram_api_credentials?: { api_id: string; api_hash: string } | null;
}): boolean {
  return getAccountApiCredentials(account) !== null;
}

/**
 * Get effective API credentials for an account.
 * Priority order:
 * 1. Account's own api_id + api_hash (from JSON import)
 * 2. Pool credential (round-robin from telegram_api_credentials table)
 * 
 * @param account - Account with optional api_id and api_hash
 * @param poolCredential - Optional pool credential as fallback
 * @returns Effective credentials with api_credential_id for tracking (null if from account)
 */
export function getEffectiveApiCredentials(
  account: { api_id?: string | null; api_hash?: string | null },
  poolCredential: { id: string; api_id: string; api_hash: string } | null
): { api_id: string; api_hash: string; api_credential_id: string | null } | null {
  // Priority 1: Account's own credentials (from JSON import)
  if (account.api_id && account.api_hash) {
    console.log(`[api-helper] Using per-account credentials: ${account.api_id}`);
    return {
      api_id: account.api_id,
      api_hash: account.api_hash,
      api_credential_id: null, // No pool tracking for per-account credentials
    };
  }
  
  // Priority 2: Pool credential (round-robin)
  if (poolCredential) {
    console.log(`[api-helper] Using pool credential: ${poolCredential.api_id}`);
    return {
      api_id: poolCredential.api_id,
      api_hash: poolCredential.api_hash,
      api_credential_id: poolCredential.id,
    };
  }
  
  console.warn('[api-helper] No API credentials available (account has none, pool is empty)');
  return null;
}

/**
 * Get API credentials for an account, using per-account first then pool fallback.
 * This is the main function to use for task dispatch.
 * 
 * @param supabase - Supabase client
 * @param account - Account with optional api_id and api_hash
 * @returns Credentials object or null if none available
 */
export async function getApiCredentialsForAccount(
  supabase: any,
  account: { api_id?: string | null; api_hash?: string | null }
): Promise<{ api_id: string; api_hash: string; api_credential_id: string | null } | null> {
  // Check account's own credentials first
  if (account.api_id && account.api_hash) {
    return {
      api_id: account.api_id,
      api_hash: account.api_hash,
      api_credential_id: null,
    };
  }
  
  // Fallback to pool
  const poolCred = await selectNextApiCredential(supabase);
  if (poolCred) {
    return {
      api_id: poolCred.api_id,
      api_hash: poolCred.api_hash,
      api_credential_id: poolCred.id,
    };
  }
  
  return null;
}
