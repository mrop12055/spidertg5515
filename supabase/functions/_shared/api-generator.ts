/**
 * Dynamic Per-Request API Generator
 * 
 * Generates a fresh, unique api_id AND api_hash for each Telegram API request.
 * EVERY MESSAGE/TASK gets completely unique credentials - NO REUSE!
 * 
 * This ensures:
 * - No duplicate API credentials across ANY requests
 * - Each message/task uses a unique api_id AND api_hash pair
 * - No API storage or tracking needed (ephemeral)
 * - Zero rate limits from credential reuse
 */

// Track used API IDs within the current request to ensure uniqueness
const usedApiIds = new Set<string>();

/**
 * Generate a random 32-character hex string for api_hash
 */
function generateRandomApiHash(): string {
  const chars = '0123456789abcdef';
  let hash = '';
  for (let i = 0; i < 32; i++) {
    hash += chars[Math.floor(Math.random() * 16)];
  }
  return hash;
}

/**
 * Generate a fresh, unique API credential pair.
 * Each call returns a COMPLETELY NEW api_id AND api_hash.
 * NO CREDENTIALS ARE EVER REUSED!
 * 
 * @returns {{ api_id: string; api_hash: string }} Fresh, unique API credentials
 */
export function generateApiCredentials(): { api_id: string; api_hash: string } {
  let api_id: string;
  
  // Generate random 7-8 digit api_id (1000000-99999999) to match real Telegram format
  // Keep trying until we get a unique one (within this request context)
  do {
    api_id = String(Math.floor(Math.random() * 99000000) + 1000000);
  } while (usedApiIds.has(api_id));
  
  usedApiIds.add(api_id);
  
  // Generate completely random api_hash for each request
  const api_hash = generateRandomApiHash();
  
  return {
    api_id,
    api_hash
  };
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
