

# Fix: Settings API Keys - Usage Display and Live Updates

## Problems Identified

1. **Wrong Usage Displayed**: The table shows `usage_count` (lifetime) in the "Usage" column instead of `daily_usage` (today's usage)
2. **Stats Card Mismatch**: The summary shows "Total Messages Sent: 18" which is correct for lifetime, but the user wants focus on daily
3. **Page Refresh Loop**: Every 30 seconds, `fetchCredentials()` sets `isLoading = true` causing a full table re-render with spinner animation
4. **No Live Updates**: Changes to usage values require full data refetch instead of updating numbers in-place

## Database Reality
- You have **16 API keys** 
- `usage_count` ranges from 15-18 (lifetime total)
- `daily_usage` = 0 for all (was reset or no messages sent today)

## Solution Overview

### Change 1: Display Today's Usage (daily_usage) in Table

Update the table column to show `daily_usage` instead of `usage_count`:

| Current | Fixed |
|---------|-------|
| `{cred.usage_count \|\| 0}` | `{cred.daily_usage \|\| 0}` |

### Change 2: Fix Stats Cards Labels

Current stats:
- "Total Messages Sent" → shows `usage_count` sum
- "24h Usage" → shows `daily_usage` sum

User wants emphasis on TODAY's usage, so:
- Rename "Total Messages Sent" → "Lifetime Usage" 
- Keep "24h Usage" as the primary focus

### Change 3: Remove Full Page Refresh - Use Realtime Updates

Replace the 30-second `setInterval` with Supabase Realtime subscription:

```typescript
// Instead of this (causes full reload):
const interval = setInterval(fetchCredentials, 30000);

// Use this (updates only changed values):
const channel = supabase
  .channel('api-credentials-updates')
  .on('postgres_changes', 
    { event: 'UPDATE', schema: 'public', table: 'telegram_api_credentials' },
    (payload) => {
      // Update only the changed credential in-place
      setCredentials(prev => prev.map(c => 
        c.id === payload.new.id ? { ...c, ...payload.new } : c
      ));
    }
  )
  .subscribe();
```

### Change 4: Don't Show Loading Spinner on Background Refresh

Only show loading spinner on initial load, not on refetches:

```typescript
const fetchCredentials = async (showLoading = true) => {
  if (showLoading) setIsLoading(true);
  // ... fetch logic
};

// Initial load: show spinner
fetchCredentials(true);

// Window focus: no spinner
const handleFocus = () => fetchCredentials(false);
```

---

## Technical Details

### File: `src/components/settings/ApiCredentialsManager.tsx`

**Change 1: Line 359-362 - Table Usage Column**
```typescript
// BEFORE:
<Badge variant={cred.usage_count > 0 ? "default" : "secondary"}>
  {cred.usage_count || 0}
</Badge>

// AFTER:
<Badge variant={cred.daily_usage > 0 ? "default" : "secondary"}>
  {cred.daily_usage || 0}
</Badge>
```

**Change 2: Lines 305-308 - Stats Card Label**
```typescript
// BEFORE:
<p className="text-2xl font-bold text-blue-500">{totalUsage.toLocaleString()}</p>
<p className="text-xs text-muted-foreground">Total Messages Sent</p>

// AFTER:
<p className="text-2xl font-bold text-blue-500">{totalUsage.toLocaleString()}</p>
<p className="text-xs text-muted-foreground">Lifetime Usage</p>
```

**Change 3: Lines 39-75 - Replace Interval with Realtime**
```typescript
const fetchCredentials = async (showLoading = true) => {
  if (showLoading) setIsLoading(true);
  // ... rest same
};

useEffect(() => {
  fetchCredentials(true); // Initial load with spinner
  
  // Realtime subscription for live updates (no full reload)
  const channel = supabase
    .channel('api-credentials-live')
    .on('postgres_changes', 
      { event: '*', schema: 'public', table: 'telegram_api_credentials' },
      (payload) => {
        if (payload.eventType === 'UPDATE') {
          setCredentials(prev => prev.map(c => 
            c.id === payload.new.id ? { ...c, ...payload.new as ApiCredential } : c
          ));
        } else if (payload.eventType === 'INSERT') {
          fetchCredentials(false);
        } else if (payload.eventType === 'DELETE') {
          setCredentials(prev => prev.filter(c => c.id !== payload.old.id));
        }
      }
    )
    .subscribe();
  
  // Window focus - refresh without spinner
  const handleFocus = () => fetchCredentials(false);
  window.addEventListener('focus', handleFocus);
  
  return () => {
    window.removeEventListener('focus', handleFocus);
    supabase.removeChannel(channel);
  };
}, []);
```

**Change 4: Table Header Label - Line 345**
```typescript
// BEFORE:
<TableHead className="text-center">Usage</TableHead>

// AFTER:
<TableHead className="text-center">Today</TableHead>
```

---

## Expected Outcome

After implementation:
1. Table "Today" column shows `daily_usage` (currently 0 for all APIs)
2. Stats cards clearly differentiate "Lifetime Usage" vs "24h Usage"
3. Values update in real-time without page refresh/spinner
4. No more visual flickering or "refreshing again and again"
5. Window focus triggers a silent background refresh

