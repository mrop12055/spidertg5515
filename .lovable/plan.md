
# Plan: Allow Restricted/Cooldown Accounts to Receive Messages

## Problem

When the runner is set to "unified" mode, it only fetches accounts with `status = 'active'`. This means accounts in `cooldown` or `restricted` status are completely excluded from the runner. The consequence:

- Accounts on cooldown can't receive incoming messages from existing conversations
- Accounts with PeerFlood restriction can't continue chatting with people who already replied

These accounts should still be connected so they can listen for incoming messages - they just shouldn't be used for sending new campaign messages.

## Current Behavior

```
Runner fetches accounts:
├── livechat runner → status IN ('active', 'restricted', 'cooldown', 'frozen')
└── unified runner  → status = 'active' ONLY ← Problem!

Result: cooldown/restricted accounts are disconnected entirely
```

## Proposed Solution

Change the account fetching logic for the "unified" runner to:
1. Fetch accounts with status IN `('active', 'cooldown', 'restricted')` for **listening purposes**
2. Keep the existing filtering that excludes cooldown/restricted accounts from **campaign task assignment**

## Technical Changes

### File: `supabase/functions/runner-tasks/index.ts`

**Change 1: Expand account status filter for unified runner (lines 209-217)**

Currently:
```typescript
if (isLivechat) {
  accountsQuery = accountsQuery.in("status", ["active", "restricted", "cooldown", "frozen"]);
} else {
  accountsQuery = accountsQuery.eq("status", "active");  // ← Too restrictive
}
```

Change to:
```typescript
if (isLivechat) {
  accountsQuery = accountsQuery.in("status", ["active", "restricted", "cooldown", "frozen"]);
} else {
  // Include restricted/cooldown accounts so they can LISTEN for messages
  // Campaign task assignment will still filter them out
  accountsQuery = accountsQuery.in("status", ["active", "cooldown", "restricted"]);
}
```

**Change 2: Separate "usable for sending" vs "usable for listening" (lines 229-241)**

Split the logic:
- `sendableAccounts` - accounts that can be assigned new campaign tasks (active only, under daily limit)
- `listeningAccounts` - all connected accounts that should receive incoming messages (includes cooldown/restricted)

```typescript
// Accounts that can SEND new campaign messages
const sendableAccounts = accounts.filter((a: any) => {
  if (!a.proxy_id || !a.proxies || a.proxies.status !== 'active') return false;
  if (a.status !== 'active') return false;  // Only active can send to new recipients
  const limit = config.campaignMessagesPerAccountPerDay || a.daily_limit || config.dailyLimit;
  if ((a.messages_sent_today ?? 0) >= limit) return false;
  return true;
});

// Accounts that can LISTEN for incoming messages (broader list)
const connectableAccounts = accounts.filter((a: any) => {
  if (!a.proxy_id || !a.proxies || a.proxies.status !== 'active') return false;
  // cooldown/restricted can still listen
  return ['active', 'cooldown', 'restricted'].includes(a.status);
});
```

**Change 3: Use `sendableAccounts` for campaign task assignment, `connectableAccounts` for listener list**

- Campaign tasks loop uses `sendableAccounts` (line 271)
- Livechat outgoing messages use account from message (already correct)
- The `listeningAccounts` array returned to runner uses `connectableAccounts`

## Result After Fix

| Scenario | Before | After |
|----------|--------|-------|
| Account hits PeerFlood | Disconnected from runner | Stays connected, listens for messages |
| Account in cooldown | Disconnected from runner | Stays connected, listens for messages |
| New campaign messages | Excludes cooldown/restricted | Still excludes (correct) |
| Reply to existing chat | Account disconnected, can't receive | Account connected, receives instantly |

## Files to Change

| File | Change |
|------|--------|
| `supabase/functions/runner-tasks/index.ts` | Update account filtering logic to separate sending vs listening |

## Testing

After implementing:
1. Put an account in cooldown (manually or via PeerFlood)
2. Verify the runner still connects and maintains the client for that account
3. Have someone reply to an existing conversation with that account
4. Verify the message appears in Conversations page
5. Start a new campaign - verify the cooldown account is NOT used for sending
