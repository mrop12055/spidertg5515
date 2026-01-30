
# Fix: Account Stats Showing 0 Due to 1000 Row Limit

## Problem Identified
The "Unique Conversations" stat (displayed as a number next to the Users icon on each account card) shows **0** for many accounts even though they have sent messages. This happens because:

1. The query at line 446-450 fetches conversations to calculate per-account stats
2. It uses `.limit(50000)` but Supabase enforces a maximum of **1000 rows** per request
3. With ~3000 conversations in the database, only the first 1000 are returned
4. Accounts whose conversations are not in that first 1000 show 0 unique conversations

## Solution
Implement paginated fetching for the unique conversations query, similar to how it was fixed for the Conversations page.

---

## Implementation Steps

### Step 1: Update the `fetchUniqueConversations` function in `src/pages/Accounts.tsx`

Replace the single query with a paginated loop:

**Current code (lines 441-470):**
```typescript
const fetchUniqueConversations = async () => {
  const counts = new Map<string, { total: number; withReplies: number }>();
  
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('account_id, has_reply')
      .eq('first_message_sent', true)
      .limit(50000);
    
    if (error || !data) {
      console.error('Error fetching conversations:', error);
      return;
    }
    
    data.forEach((conv: any) => {
      // ... process
    });
    
    setUniqueConversations(counts);
    conversationsFetchedRef.current = true;
  } catch (err) {
    console.error('Error in fetchUniqueConversations:', err);
  }
};
```

**New code with pagination:**
```typescript
const fetchUniqueConversations = async () => {
  const counts = new Map<string, { total: number; withReplies: number }>();
  const PAGE_SIZE = 1000;
  const MAX_RECORDS = 50000;
  
  try {
    // Get total count first
    const { count: totalCount, error: countError } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('first_message_sent', true);
    
    if (countError) {
      console.error('Error getting conversation count:', countError);
      return;
    }
    
    const effectiveCount = Math.min(totalCount || 0, MAX_RECORDS);
    const totalPages = Math.ceil(effectiveCount / PAGE_SIZE);
    
    // Fetch all pages
    for (let page = 0; page < totalPages; page++) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      
      const { data, error } = await supabase
        .from('conversations')
        .select('account_id, has_reply')
        .eq('first_message_sent', true)
        .range(from, to);
      
      if (error) {
        console.error('Error fetching conversations page', page, error);
        break;
      }
      if (!data || data.length === 0) break;
      
      // Process in-memory
      data.forEach((conv: any) => {
        const existing = counts.get(conv.account_id) || { total: 0, withReplies: 0 };
        existing.total += 1;
        if (conv.has_reply) existing.withReplies += 1;
        counts.set(conv.account_id, existing);
      });
    }
    
    console.log(`Fetched unique conversations for ${counts.size} accounts from ${effectiveCount} records`);
    setUniqueConversations(counts);
    conversationsFetchedRef.current = true;
  } catch (err) {
    console.error('Error in fetchUniqueConversations:', err);
  }
};
```

---

## Technical Details

| Aspect | Before | After |
|--------|--------|-------|
| Max rows fetched | 1000 (Supabase limit) | Up to 50,000 (paginated) |
| Pages per fetch | 1 | Calculated dynamically |
| Accounts with stats | ~30% | 100% |

## Files Changed
- `src/pages/Accounts.tsx` - Update the `fetchUniqueConversations` function (lines 441-470)

## Testing
After implementation:
1. Navigate to the Accounts page
2. Verify that accounts with messages show non-zero values for the "Unique Conversations" stat (Users icon)
3. Hover over the stat to see the tooltip with reply rate

