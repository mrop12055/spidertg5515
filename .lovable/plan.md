

## Fix: Reduce Cloud Compute Costs (from ~$25/day to ~$3-4/day)

### Root Cause
Your Python runner is polling the backend function every **3 seconds** when active and every **5 seconds** when idle. Each poll takes about 2 seconds of compute time. That adds up to **17,000+ function calls per day**, which is why your cloud balance drains so fast.

### Solution
Increase the polling intervals significantly. The runner does not need to check for new tasks every 3 seconds -- checking every 15-30 seconds still gives excellent responsiveness while cutting costs by 70-80%.

### Changes

**1. Backend function (`runner-tasks`):**
- When there are tasks to process: increase delay from **3s to 10s**
- When idle (no tasks): increase delay from **5s to 30s**
- When no accounts available: keep at 30s (already correct)

**2. Campaign speed setting in database:**
- Update `pollingInterval` from `3` to `10` in the `campaign_speed` app setting

### Why This Is Safe
- Your campaigns stagger messages with delays between them anyway (0.3-1.5s per message)
- A 10-second poll interval still delivers messages fast enough for bulk campaigns
- Incoming messages are handled via the listener, not polling -- they are unaffected
- The runner will still pick up tasks promptly, just with a few seconds more latency

### Expected Result
- Function calls drop from ~17,000/day to ~3,000-5,000/day
- Daily cloud cost drops from ~$25 to ~$3-5
- No noticeable impact on campaign speed or message delivery

### Technical Details

**File:** `supabase/functions/runner-tasks/index.ts`
- Line 660: Change `delay_after: tasks.length > 0 ? config.campaignPollingInterval : 5` to `delay_after: tasks.length > 0 ? config.campaignPollingInterval : 30`
- Default `campaignPollingInterval` in `parseSettings` (line 59): Change from `3` to `10`

**Database:** Update `app_settings` where `key = 'campaign_speed'` to set `pollingInterval` from `3` to `10`.

