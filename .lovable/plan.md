

# Dead Edge Functions Cleanup Plan

## Investigation Summary

After thorough analysis checking frontend code, cron jobs, edge function logs, HTTP analytics, and cross-function references, I've confirmed these edge functions are completely dead:

---

## Confirmed Dead Edge Functions

### 1. `enforce-proxy-mapping` (219 lines)

**Location:** `supabase/functions/enforce-proxy-mapping/index.ts`

**Evidence of No Usage:**
- Zero references in `src/` directory
- Zero references in Python runners (SetupGuide.tsx)
- Not in any cron job (only cron job is `reset-daily-message-counts` → `system-maintenance`)
- No edge function logs found (never been called)
- No HTTP analytics records
- Not called by any other edge functions

**What it does:** Redistributes proxies across accounts for 1:1 mapping with geo-matching.

**Why dead:** The bulk proxy assignment is now handled directly in the Accounts UI (`src/pages/Accounts.tsx`) with parallel batching, making this edge function obsolete.

---

### 2. `get-antibot-stats` (180 lines)

**Location:** `supabase/functions/get-antibot-stats/index.ts`

**Evidence of No Usage:**
- Zero references in `src/` directory
- No matching patterns like `antibot` found anywhere
- Not in any cron job
- No edge function logs found
- No HTTP analytics records

**What it does:** Returns anti-ban system statistics (proxy mapping, warmup, spambot status, geo-consistency).

**Why dead:** This was likely intended for a monitoring dashboard that was never built. The dashboard currently fetches stats directly from Supabase tables instead.

---

### 3. `detect-proxy-country` (173 lines) - BONUS FIND

**Location:** `supabase/functions/detect-proxy-country/index.ts`

**Evidence of No Usage:**
- Zero references in `src/` directory
- NOT called by `test-proxies` (verified - it has its own inline country detection)
- No edge function logs found
- No HTTP analytics records

**What it does:** Detects proxy geographic location via ip-api.com lookups.

**Why dead:** The `test-proxies` function has its own inline country detection logic (extracting country code from password like `-IN-` or `-US-`), making this function obsolete.

---

## Files to Delete

```text
supabase/functions/enforce-proxy-mapping/   # 219 lines
  └── index.ts

supabase/functions/get-antibot-stats/       # 180 lines
  └── index.ts

supabase/functions/detect-proxy-country/    # 173 lines
  └── index.ts
```

---

## Implementation Steps

1. Delete `supabase/functions/enforce-proxy-mapping/index.ts`
2. Delete `supabase/functions/get-antibot-stats/index.ts`
3. Delete `supabase/functions/detect-proxy-country/index.ts`
4. Delete the deployed edge functions from Supabase using the delete tool

---

## Risk Assessment

| Function | Risk | Reason |
|----------|------|--------|
| `enforce-proxy-mapping` | Zero | No references, no logs, no cron |
| `get-antibot-stats` | Zero | No references, no logs, no cron |
| `detect-proxy-country` | Zero | No references, replaced by inline logic in test-proxies |

---

## Total Cleanup

**Dead code removed:** ~572 lines across 3 edge functions

---

## Technical Details

### Verification Methods Used

1. **Code Search:** Searched for function names in `src/`, `supabase/functions/`, and all project files
2. **Cron Jobs:** Queried `cron.job` table - only `system-maintenance` is scheduled
3. **Edge Function Logs:** Checked for any execution logs - none found
4. **HTTP Analytics:** Queried `function_edge_logs` for any HTTP calls - zero results
5. **Cross-Reference:** Verified no edge function calls these via `invoke()` or `fetch()`
6. **Python Runners:** Verified SetupGuide.tsx doesn't reference these functions

