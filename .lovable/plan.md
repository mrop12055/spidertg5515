## ✅ COMPLETED

# Fix Live Chat Message Reception - Analysis and Plan

## Issues Identified

### Critical Bug: Backend Edge Function Error

The primary issue causing live messages to not appear is a **JavaScript error in the edge function** that processes incoming messages:

```
TypeError: supabase.rpc(...).catch is not a function
at processIncomingMessage (runner-tasks/index.ts:992:13)
```

**Root Cause**: The Supabase JavaScript client's `.rpc()` method returns a Promise-like object, but using `.catch()` directly on it fails because it's not a native Promise.

**Location**: `supabase/functions/runner-tasks/index.ts` line 1087

**Impact**: When an incoming message arrives for an **existing conversation** (i.e., a reply to a campaign message), the backend crashes before:
1. Incrementing the unread count
2. Inserting the message into the database

This means replies to existing conversations are being lost, while messages from completely new users (new conversations) may work since they don't hit this code path.

---

## Technical Fix Required

### File: `supabase/functions/runner-tasks/index.ts`

**Current Code (lines 1086-1090):**
```typescript
// Increment unread_count atomically
await supabase.rpc('increment_unread_count', { conv_id: conversationId }).catch(() => {
  // Fallback if RPC doesn't exist - just update to at least 1
  supabase.from("conversations").update({ unread_count: 1 }).eq("id", conversationId).eq("unread_count", 0);
});
```

**Fixed Code:**
```typescript
// Increment unread_count atomically
try {
  const { error: rpcError } = await supabase.rpc('increment_unread_count', { conv_id: conversationId });
  if (rpcError) {
    // Fallback if RPC doesn't exist - just update to at least 1
    await supabase.from("conversations").update({ unread_count: 1 }).eq("id", conversationId).eq("unread_count", 0);
  }
} catch {
  // Fallback if RPC doesn't exist
  await supabase.from("conversations").update({ unread_count: 1 }).eq("id", conversationId).eq("unread_count", 0);
}
```

**Why this fixes it:**
- Uses proper Supabase SDK pattern: `const { error } = await supabase.rpc(...)` instead of `.catch()`
- Wraps in try/catch for safety
- The fallback update is now properly awaited

---

## Flow After Fix

```text
Incoming Message Flow (Fixed):

1. Telegram user replies to your message
2. Runner's on_message() fires
3. Runner calls: await report("incoming_message", {...})
4. Backend /runner-tasks/report receives the message
5. processIncomingMessage():
   - Finds existing conversation by telegram_id or phone
   - Updates conversation metadata (last_message_at, has_reply, etc.)
   - Increments unread_count (NOW WORKS!)
   - Inserts message into messages table
6. Realtime subscription fires in frontend
7. Message appears in Conversations page
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `supabase/functions/runner-tasks/index.ts` | Fix `.catch()` syntax error on supabase.rpc() call |

---

## Expected Outcome

After deploying this fix:
1. All incoming messages from campaign recipients will be saved to the database
2. Messages will appear in the Conversations page in real-time
3. Unread counts will increment properly
4. The edge function errors will stop appearing in logs

