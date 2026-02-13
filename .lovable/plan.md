

## Fix: Username Campaign Recipients - Conversation Creation Bug

### Problem Found
The task payload fix (sending `username` instead of `phone`) is correct, but the **result reporting** code has a bug. When the Python runner reports a successful campaign send for a username recipient:

1. **Conversation lookup fails**: Line 740 does `.eq("recipient_phone", r.recipient_phone)` but `r.recipient_phone` is `null` for username recipients -- this query won't find anything useful
2. **Conversation creation is incomplete**: Line 751-761 creates a conversation with `recipient_phone: null` but never sets `recipient_username`
3. **Duplicate conversations**: Since the lookup always fails for username recipients, every retry or re-send creates a new conversation

### Solution
Update the result reporting section to handle username recipients properly:

- When looking up existing conversations, also check by `recipient_username` if `recipient_phone` is null/missing
- When creating new conversations, include `recipient_username` from the runner's report
- The runner already sends back `recipient_username` in its result payload (it resolves the user and reports back the username)

### Changes

**File: `supabase/functions/runner-tasks/index.ts`**

**1. Conversation lookup (lines 736-741)**

Change from:
```typescript
const { data: existingConv } = await supabase
  .from("conversations")
  .select("id")
  .eq("account_id", r.account_id)
  .eq("recipient_phone", r.recipient_phone)
  .maybeSingle();
```

To handle both phone and username lookups:
```typescript
let existingConvQuery = supabase
  .from("conversations")
  .select("id")
  .eq("account_id", r.account_id);

if (r.recipient_phone) {
  existingConvQuery = existingConvQuery.eq("recipient_phone", r.recipient_phone);
} else if (r.recipient_username) {
  existingConvQuery = existingConvQuery.eq("recipient_username", r.recipient_username);
} else if (r.recipient_telegram_id) {
  existingConvQuery = existingConvQuery.eq("recipient_telegram_id", r.recipient_telegram_id);
}

const { data: existingConv } = await existingConvQuery.maybeSingle();
```

**2. Conversation creation (lines 751-761)**

Add `recipient_username` to the insert:
```typescript
const { data: newConv } = await supabase.from("conversations").insert({
  account_id: r.account_id,
  recipient_phone: r.recipient_phone || null,
  recipient_name: r.recipient_name,
  recipient_username: r.recipient_username || null,
  recipient_telegram_id: r.recipient_telegram_id,
  is_active: true,
  first_message_sent: true,
  seat_id: r.campaign_seat_id,
  campaign_id: r.campaign_id,
  campaign_name: r.campaign_name,
}).select().single();
```

**3. Conversation update (lines 743-749)**

Also update `recipient_username` on existing conversations if the runner resolved it:
```typescript
if (existingConv) {
  conversationId = existingConv.id;
  const convUpdates: Record<string, any> = {};
  if (r.recipient_telegram_id) convUpdates.recipient_telegram_id = r.recipient_telegram_id;
  if (r.recipient_username) convUpdates.recipient_username = r.recipient_username;
  if (r.recipient_phone && !existingConv.recipient_phone) convUpdates.recipient_phone = r.recipient_phone;
  if (Object.keys(convUpdates).length > 0) {
    await supabase.from("conversations").update(convUpdates).eq("id", conversationId);
  }
}
```

### No Other Changes Needed
- The task payload fix from the previous edit is correct
- The frontend `normalizeRecipient` already handles usernames properly
- The "recipient not found" retry logic uses `campaign_recipient_id` (UUID) so it works for both phone and username recipients
- The `contacts_data` marking uses `phone_number` which stores the username with `@` prefix -- this works correctly

### Summary
| File | Line | Change |
|------|------|--------|
| `runner-tasks/index.ts` | ~736-741 | Conversation lookup: support username and telegram_id fallback |
| `runner-tasks/index.ts` | ~743-749 | Conversation update: also update recipient_username |
| `runner-tasks/index.ts` | ~751-761 | Conversation insert: include recipient_username field |

The edge function will be redeployed automatically after the changes.
