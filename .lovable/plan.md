

# Plan: Increase Account Query Limit to 5,000 in Edge Functions

## Problem
The `runner-tasks` edge function queries accounts **without an explicit limit**, causing Supabase to apply its default 1,000-row limit. With 1,000+ accounts in your system, the Python runner only receives a partial list.

## Solution
Add `.limit(5000)` to all account queries in the edge functions to ensure all accounts are fetched.

## Files to Modify

### 1. `supabase/functions/runner-tasks/index.ts`

**Location:** Line 262 (account query)

```text
Current:
  const { data: accounts, error: accountsError } = await accountsQuery;

Change to:
  const { data: accounts, error: accountsError } = await accountsQuery.limit(5000);
```

### 2. `supabase/functions/admin-api/index.ts`

**Location:** Line 50-51 (GET /accounts endpoint)

```text
Current:
  const { data, error } = await supabase.from('telegram_accounts').select('*, proxies(*)');

Change to:
  const { data, error } = await supabase.from('telegram_accounts').select('*, proxies(*)').limit(5000);
```

**Location:** Line 77 (GET /proxies endpoint) - for consistency

```text
Current:
  const { data, error } = await supabase.from('proxies').select('*');

Change to:
  const { data, error } = await supabase.from('proxies').select('*').limit(5000);
```

## Summary of Changes

| File | Endpoint/Query | Current Limit | New Limit |
|------|----------------|---------------|-----------|
| runner-tasks/index.ts | Account fetch | 1,000 (default) | 5,000 |
| admin-api/index.ts | GET /accounts | 1,000 (default) | 5,000 |
| admin-api/index.ts | GET /proxies | 1,000 (default) | 5,000 |

## After Implementation
1. Edge functions will be auto-deployed
2. Python runner will receive all 1,000+ accounts
3. No changes needed to the Python runner code

