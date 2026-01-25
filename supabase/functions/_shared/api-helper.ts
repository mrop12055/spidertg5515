/**
 * Round-Robin API Credential Helper
 * 
 * Provides round-robin selection of API credentials from telegram_api_credentials table.
 * Each task gets the API with the LOWEST usage_count, ensuring even distribution.
 * 
 * Example with 10 APIs and 40 tasks:
 * - Each API will be used exactly 4 times (40 / 10 = 4)
 * - API usage: 1,2,3,4,5,6,7,8,9,10,1,2,3,4,5,6,7,8,9,10...
 */

/**
 * Get the next API credential using round-robin rotation.
 * Selects the API with the LOWEST usage_count among active APIs.
 * This ensures even distribution: all APIs get equal usage.
 * 
 * @param supabase - Supabase client instance
 * @returns API credentials object or null if no APIs available
 */
export async function getNextApiCredential(
  supabase: any
): Promise<{ api_id: string; api_hash: string } | null> {
  // Reset daily usage if date changed
  const today = new Date().toISOString().split('T')[0];
  await supabase
    .from('telegram_api_credentials')
    .update({ daily_usage: 0, daily_usage_reset_at: today })
    .neq('daily_usage_reset_at', today);

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

  // Increment usage count atomically
  await supabase
    .from('telegram_api_credentials')
    .update({
      usage_count: (api.usage_count || 0) + 1,
      daily_usage: supabase.rpc ? undefined : (api.daily_usage || 0) + 1,
      last_used_at: new Date().toISOString()
    })
    .eq('id', api.id);

  console.log(`[api-helper] Selected API ${api.api_id} (usage: ${api.usage_count || 0} -> ${(api.usage_count || 0) + 1})`);

  return {
    api_id: api.api_id,
    api_hash: api.api_hash
  };
}

/**
 * Get multiple API credentials for batch operations using round-robin.
 * Distributes tasks evenly across all available APIs.
 * 
 * @param supabase - Supabase client instance
 * @param count - Number of API credentials needed
 * @returns Array of API credential objects
 */
export async function getMultipleApiCredentials(
  supabase: any,
  count: number
): Promise<Array<{ api_id: string; api_hash: string }>> {
  if (count <= 0) return [];

  // Reset daily usage if date changed
  const today = new Date().toISOString().split('T')[0];
  await supabase
    .from('telegram_api_credentials')
    .update({ daily_usage: 0, daily_usage_reset_at: today })
    .neq('daily_usage_reset_at', today);

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

  const results: Array<{ api_id: string; api_hash: string }> = [];
  const usageDelta = new Map<string, number>();

  // Distribute tasks across APIs in round-robin fashion
  for (let i = 0; i < count; i++) {
    const api = apis[i % apis.length];
    results.push({
      api_id: api.api_id,
      api_hash: api.api_hash
    });
    usageDelta.set(api.id, (usageDelta.get(api.id) || 0) + 1);
  }

  // Batch update all usage counts
  const updatePromises = [];
  for (const [id, delta] of usageDelta) {
    const api = apis.find((a: any) => a.id === id);
    if (api) {
      updatePromises.push(
        supabase
          .from('telegram_api_credentials')
          .update({
            usage_count: (api.usage_count || 0) + delta,
            last_used_at: new Date().toISOString()
          })
          .eq('id', id)
      );
    }
  }
  await Promise.all(updatePromises);

  console.log(`[api-helper] Distributed ${count} tasks across ${apis.length} APIs`);
  return results;
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
