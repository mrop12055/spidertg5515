
# Plan: Fix API Usage Tracking for Campaign Runner

## Problem Summary

API usage counts remain at 0 despite successful message sends because the **Python campaign runner on your VPS has not been restarted** since the code fix was applied. The runner is using old code that does not include `api_credential_id` in the result payload.

## Current Situation

- 138 messages sent successfully
- All have `api_credential_id = NULL` in both `messages` and `campaign_recipients` tables
- Edge function `report-batch-results` receives results but finds 0 valid API credential IDs to increment

## Solution

### Step 1: Restart the Campaign Runner on VPS (User Action Required)

You need to stop and restart your campaign runner script on your VPS server. The updated code at line 2066 already includes the fix:

```python
api_credential_id = account.get("api_credential_id")

result = {
    "success": success,
    "error": error,
    "campaign_recipient_id": msg.get("campaign_recipient_id"),
    "account_id": account_id,
    "api_credential_id": api_credential_id,  # This was added
    ...
}
```

**On your VPS, run:**
1. Stop the running campaign runner (Ctrl+C or kill the process)
2. Re-download the latest `campaign_runner.py` script
3. Start the runner again

### Step 2: Verify Fix is Working

After restart, check the edge function logs. You should see:
```
[report-batch-results] Recorded API usage for 10 successful sends
```

### Step 3: Optional Cleanup (SQL)

After the runner is restarted and processing new batches correctly, you can reset all API usage counts to start fresh:

```sql
UPDATE telegram_api_credentials SET usage_count = 0, daily_usage = 0;
```

## Technical Details

The data flow for API usage tracking is:

1. `get-batch-tasks` edge function assigns `api_credential_id` to each task's account object (line 1040)
2. Python runner extracts it: `account.get("api_credential_id")` (line 2058)
3. Python runner includes it in result payload (line 2066)
4. `report_batch_results()` sends results to edge function (line 2155)
5. Edge function filters for valid IDs and calls `recordBatchApiUsage()` (lines 92-98)
6. RPC `increment_api_usage` atomically updates the counter

The break occurs at step 2-3 because the old runner code did not have these lines.

## No Code Changes Required

The fix was already implemented in a previous update. The only action needed is **restarting your VPS runner** to pick up the new code.
