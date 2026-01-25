/**
 * Dynamic Per-Request API Generator
 * 
 * Generates a fresh, unique api_id for each Telegram API request,
 * paired with a master api_hash that is constant for all requests.
 * 
 * This ensures:
 * - No duplicate API credentials across requests
 * - Each message/task uses a unique api_id
 * - No API storage or tracking needed (ephemeral)
 */

// Master API hash - constant for all requests
const MASTER_API_HASH = "dd46137d85394024a756add8ab24f888";

// Track used API IDs within the current request to ensure uniqueness
const usedApiIds = new Set<string>();

/**
 * Generate a fresh, unique API credential pair.
 * Each call returns a new random api_id with the master api_hash.
 * 
 * @returns {{ api_id: string; api_hash: string }} Fresh API credentials
 */
export function generateApiCredentials(): { api_id: string; api_hash: string } {
  let api_id: string;
  
  // Generate random 8-digit api_id (10000000-99999999)
  // Keep trying until we get a unique one (within this request context)
  do {
    api_id = String(Math.floor(Math.random() * 90000000) + 10000000);
  } while (usedApiIds.has(api_id));
  
  usedApiIds.add(api_id);
  
  return {
    api_id,
    api_hash: MASTER_API_HASH
  };
}

/**
 * Get the master API hash constant.
 * Useful for logging or configuration display.
 * 
 * @returns {string} The master API hash
 */
export function getMasterApiHash(): string {
  return MASTER_API_HASH;
}

/**
 * Clear the used API IDs set.
 * Call this at the start of a new request context if needed.
 */
export function resetUsedApiIds(): void {
  usedApiIds.clear();
}

/**
 * Get count of API IDs generated in current request.
 * Useful for logging/debugging.
 * 
 * @returns {number} Number of unique API IDs generated
 */
export function getGeneratedCount(): number {
  return usedApiIds.size;
}
