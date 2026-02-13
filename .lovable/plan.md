

## Add Username Support for Campaign Message Sending

### Problem
The system already accepts usernames (e.g., `@telegram_user`) when creating campaigns -- the frontend parses them correctly and stores them in the `campaign_recipients.phone_number` field. However, the backend **never passes the username to the Python runner**. It hardcodes `username: null` in the task payload, so the runner has no way to resolve usernames and the message fails silently.

LiveChat already works correctly because it reads `recipient_username` from the conversations table.

### Solution
Fix the backend to detect when a campaign recipient's `phone_number` starts with `@` and pass it as `username` instead of `phone` in the task payload. This way the Python runner receives the username and can resolve the Telegram user correctly.

### Changes

**1. Backend: `supabase/functions/runner-tasks/index.ts`**

In the campaign task builder (around line 439), change the recipient object from:
```
recipient: {
  phone: r.phone_number,
  name: r.name,
  telegram_id: null,
  username: null,
}
```
to detect if `phone_number` starts with `@`:
```
recipient: {
  phone: r.phone_number.startsWith('@') ? null : r.phone_number,
  name: r.name,
  telegram_id: null,
  username: r.phone_number.startsWith('@') ? r.phone_number : null,
}
```

Also update the message template replacement to handle usernames:
```
const content = (r.campaigns.message_template || '')
  .replace(/{name}/g, r.name || 'there')
  .replace(/{phone}/g, r.phone_number)
  .replace(/{username}/g, r.phone_number.startsWith('@') ? r.phone_number : '');
```

**2. Frontend: `src/components/campaigns/CreateCampaignDialog.tsx`**

Add `{username}` as a supported variable in the message template placeholder text so users know they can use it.

### What Already Works (No Changes Needed)
- Frontend recipient parsing (normalizeRecipient) -- already handles `@username` format
- Recipient upload and deduplication -- works with any string in `phone_number`
- LiveChat sending -- already passes `recipient_username` from conversations
- Campaign recipient table -- stores usernames in `phone_number` field (this is fine)

### Technical Details

| File | Change |
|------|--------|
| `supabase/functions/runner-tasks/index.ts` (line ~439) | Detect `@` prefix in `phone_number` and route to `username` field in task payload |
| `supabase/functions/runner-tasks/index.ts` (line ~413) | Add `{username}` template variable support |
| `src/components/campaigns/CreateCampaignDialog.tsx` (line ~434) | Update placeholder to mention `{username}` variable |

No database changes needed. The edge function will be redeployed automatically.

