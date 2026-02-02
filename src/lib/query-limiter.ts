/**
 * Query Limiter & Circuit Breaker
 * 
 * Limits concurrent Supabase queries to prevent database overload.
 * Implements circuit breaker pattern to gracefully degrade on failures.
 */

const MAX_CONCURRENT = 5;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds

// Semaphore for limiting concurrent queries
let activeQueries = 0;
const queryQueue: Array<() => void> = [];

// Circuit breaker state
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let isCircuitOpen = false;

/**
 * Check if the circuit breaker is open (preventing new requests)
 */
export function isCircuitBreakerOpen(): boolean {
  if (!isCircuitOpen) return false;
  
  // Check if it's time to reset
  if (Date.now() > circuitOpenUntil) {
    isCircuitOpen = false;
    consecutiveFailures = 0;
    console.log('[circuit-breaker] Circuit closed, resuming normal operations');
    return false;
  }
  
  return true;
}

/**
 * Report a successful query (resets failure counter)
 */
export function reportSuccess(): void {
  consecutiveFailures = 0;
}

/**
 * Report a failed query (may trip circuit breaker)
 */
export function reportFailure(error?: Error): void {
  consecutiveFailures++;
  
  const isTimeout = error?.message?.includes('timeout') || 
                    error?.message?.includes('Connection terminated');
  
  if (isTimeout && consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    isCircuitOpen = true;
    circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
    console.warn(`[circuit-breaker] Circuit OPEN after ${consecutiveFailures} failures. Pausing for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
  }
}

/**
 * Get the time remaining until the circuit breaker resets
 */
export function getCircuitResetTimeMs(): number {
  if (!isCircuitOpen) return 0;
  return Math.max(0, circuitOpenUntil - Date.now());
}

/**
 * Wrap a query function with concurrency limiting
 */
export async function limitedQuery<T>(queryFn: () => Promise<T>): Promise<T> {
  // If circuit is open, throw immediately
  if (isCircuitBreakerOpen()) {
    throw new Error('Circuit breaker open - database temporarily unavailable');
  }
  
  // Wait for a slot if at max concurrency
  if (activeQueries >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => {
      queryQueue.push(resolve);
    });
  }
  
  activeQueries++;
  
  try {
    const result = await queryFn();
    reportSuccess();
    return result;
  } catch (error) {
    reportFailure(error as Error);
    throw error;
  } finally {
    activeQueries--;
    
    // Release next queued query
    const next = queryQueue.shift();
    if (next) next();
  }
}

/**
 * Execute paginated queries with concurrency control
 * Instead of firing all pages at once, process in batches of MAX_CONCURRENT
 */
export async function paginatedQueryWithLimit<T>(
  fetchPage: (page: number) => Promise<{ data: T[] | null; done: boolean }>,
  maxPages: number = 100
): Promise<T[]> {
  const allResults: T[] = [];
  
  for (let page = 0; page < maxPages; page += MAX_CONCURRENT) {
    // If circuit is open, stop and return what we have
    if (isCircuitBreakerOpen()) {
      console.warn('[paginated-query] Circuit open, returning partial results');
      break;
    }
    
    // Calculate how many pages to fetch in this batch
    const batchSize = Math.min(MAX_CONCURRENT, maxPages - page);
    const pagePromises: Promise<{ data: T[] | null; done: boolean }>[] = [];
    
    for (let i = 0; i < batchSize; i++) {
      pagePromises.push(fetchPage(page + i));
    }
    
    const results = await Promise.all(pagePromises);
    
    let shouldStop = false;
    for (const result of results) {
      if (result.data) {
        allResults.push(...result.data);
      }
      if (result.done) {
        shouldStop = true;
      }
    }
    
    if (shouldStop) break;
  }
  
  return allResults;
}

/**
 * Get current query limiter stats for debugging
 */
export function getQueryLimiterStats() {
  return {
    activeQueries,
    queuedQueries: queryQueue.length,
    isCircuitOpen,
    consecutiveFailures,
    circuitResetIn: getCircuitResetTimeMs(),
  };
}
