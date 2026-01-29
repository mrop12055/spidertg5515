# Per-Account System Cleanup - COMPLETED ✅

## Summary

Comprehensive cleanup completed on 2026-01-29. The system now fully prioritizes per-account JSON metadata for API credentials and device fingerprints.

## Changes Made

### 1. get-batch-tasks - Per-Account Priority ✅
- Updated warmup and campaign task dispatch to use `getApiCredentialsForAccount()`
- Per-account credentials are used first, pool fallback for legacy accounts

### 2. Accounts.tsx - Removed Legacy Deletion ✅
- Removed deletion from `telegram_api_credentials` table
- Per-account credentials are stored in `telegram_accounts` and deleted automatically

### 3. process-account-upload - Removed Fingerprint Generation ✅
- Removed ~400 lines of device arrays and generation code
- Fingerprints now MUST come from JSON metadata
- Logs warning if fingerprint is missing

### 4. Logs.tsx - Removed fingerprint_generated References ✅
- Removed obsolete task type from labels and icons

### 5. report-task-result - Removed fingerprint_generated Case ✅
- Removed dead code for fingerprint generation task handling

### 6. SetupGuide.tsx - Updated Documentation ✅
- Changed "ROUND-ROBIN API SYSTEM" to "PER-ACCOUNT API SYSTEM"

### 7. api-helper.ts - Clarified Purpose ✅
- Updated header comments to emphasize per-account is primary
- Pool functions marked as "LEGACY FALLBACK"

## Benefits

- Consistent API priority across all runners
- ~400 lines of unused code removed
- Accurate Python documentation
- Cleaner account deletion (no separate API table cleanup)
- Better logging distinguishing per-account vs pool usage
