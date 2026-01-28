

# Implementation: Fix "Original account is not available" Error

## Problem
When users try to send messages from the Conversations page, they see:
**"Original account is not available. Cannot send from a different number."**

This happens for ALL conversations because `accounts` from `useTelegram()` context is always an empty array (the context no longer populates it - accounts are now loaded via the dedicated `useAccounts` hook).

## Solution: Use the useAccounts hook

Replace the empty `accounts` array from TelegramContext with the properly loaded accounts from `useAccounts` hook.

## File Changes

### File: `src/pages/Conversations.tsx`

**Change 1: Add import for useAccounts hook (line 4-5)**
```typescript
import { useTelegram } from '@/context/TelegramContext';
import { useAccounts } from '@/hooks/useAccounts';
```

**Change 2: Update hook usage (lines 58-74)**
```typescript
const Chat: React.FC = () => {
  const { 
    conversations, 
    messages, 
    sendMessage, 
    sendMediaMessage,
    // accounts,  <-- REMOVE THIS from context destructuring
    typingUsers,
    markConversationAsRead,
    startNewConversation,
    deleteConversation,
    deleteConversations,
    blockContact,
    blockContacts
  } = useTelegram();
  
  // Use the dedicated accounts hook for proper data loading
  const { accounts, isLoading: accountsLoading } = useAccounts();
```

**Change 3: Add loading protection in handleSendMessage (lines 505-513)**
```typescript
const handleSendMessage = async () => {
  if ((!messageInput.trim() && !selectedImage) || !selectedConv) return;
  
  // Wait for accounts to load before attempting to send
  if (accountsLoading) {
    toast.info('Loading accounts, please wait...');
    return;
  }
  
  // CRITICAL: Always use the conversation's original account - never fallback to another account
  const account = accounts.find(a => a.id === selectedConv.accountId);
  if (!account) {
    toast.error('Original account is not available. Cannot send from a different number.');
    return;
  }
  // ... rest unchanged
```

## Expected Outcome

After implementing this fix:
1. The `accounts` array will be properly populated from the database via `useAccounts` hook
2. Messages will send correctly from the original account
3. The error "Original account is not available" will only appear for genuinely deleted/unavailable accounts
4. A loading message will appear if accounts haven't loaded yet

## Testing Steps

1. Navigate to the Conversations page
2. Select any conversation
3. Type a message and click Send
4. Verify the message appears in the chat without any error
5. Confirm the message is sent from the correct (original) account

