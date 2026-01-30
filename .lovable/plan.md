

# Plan: Fix Profile Sync to Update Account Avatar

## The Problem

When you run "Sync Profile", the account's name, username, and telegram_id are updated correctly, but the **profile picture is never synced** to the admin dashboard.

**Root Cause:**

| Component | Current Behavior | Issue |
|-----------|------------------|-------|
| Python Runner | Reports `avatar_id` (just a reference ID) | Does NOT download the actual photo |
| Edge Function | Ignores `avatar_id` completely | Never updates `avatar_url` in database |
| Result | Avatar never appears | Missing end-to-end implementation |

---

## Solution

Modify the Python runner to **download the actual profile photo** and upload it to Supabase Storage, then update the Edge Function to save the URL.

---

## Technical Changes

### 1. Python Runner (`src/pages/SetupGuide.tsx`)

**Location**: Lines 622-650 (sync_profile action)

**Changes**:
- Download the profile photo from Telegram
- Upload it to Supabase Storage (`message-attachments` bucket)
- Report the public URL instead of just an ID

```python
elif action == "sync_profile":
    print(f"  [SYNC] [{phone}] Fetching profile from Telegram...")
    me = await asyncio.wait_for(client.get_me(), timeout=15)
    
    if me:
        avatar_url = None
        try:
            # Download profile photo directly
            photo_bytes = await client.download_profile_photo(me, bytes)
            if photo_bytes:
                import base64
                # Upload to Supabase storage
                filename = f"avatars/{acc_id}_{me.id}.jpg"
                b64 = base64.b64encode(photo_bytes).decode()
                
                # Report with base64 for edge function to upload
                avatar_url = f"data:image/jpeg;base64,{b64}"  # Will be processed by edge
        except Exception as e:
            print(f"  [SYNC] [{phone}] Photo download failed: {e}")
        
        await report("sync_profile", {
            "task_id": task_id,
            "account_id": acc_id,
            "success": True,
            "telegram_id": me.id,
            "first_name": me.first_name,
            "last_name": me.last_name,
            "username": me.username,
            "phone": me.phone,
            "avatar_url": avatar_url  # Now contains actual photo data
        })
        return True, None
```

### 2. Edge Function (`supabase/functions/runner-tasks/index.ts`)

**Location**: Lines 675-679 (sync_profile handler)

**Changes**:
- Process the avatar data (base64 or URL)
- Upload to Supabase Storage if base64
- Update `avatar_url` in the database

```typescript
} else if (taskType === "sync_profile" || taskType === "get_me") {
  if (r.first_name) accountUpdates.first_name = r.first_name;
  if (r.last_name !== undefined) accountUpdates.last_name = r.last_name;
  if (r.username !== undefined) accountUpdates.username = r.username;
  if (r.telegram_id) accountUpdates.telegram_id = r.telegram_id;
  
  // Handle avatar from sync_profile
  if (r.avatar_url) {
    if (r.avatar_url.startsWith('data:image')) {
      // Base64 image - upload to storage
      try {
        const base64Data = r.avatar_url.split(',')[1];
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const filename = `avatars/${r.account_id}_${Date.now()}.jpg`;
        
        const { error: uploadError } = await supabase.storage
          .from('message-attachments')
          .upload(filename, binaryData, { contentType: 'image/jpeg', upsert: true });
        
        if (!uploadError) {
          const { data: urlData } = supabase.storage
            .from('message-attachments')
            .getPublicUrl(filename);
          accountUpdates.avatar_url = urlData.publicUrl;
        }
      } catch (e) {
        console.error('[sync_profile] Avatar upload failed:', e);
      }
    } else {
      // Direct URL
      accountUpdates.avatar_url = r.avatar_url;
    }
  }
}
```

---

## Flow After Fix

```text
1. User clicks "Sync Profile"
2. Python runner downloads photo from Telegram
3. Python sends base64 photo data to Edge Function
4. Edge Function uploads to Supabase Storage
5. Edge Function updates avatar_url in telegram_accounts
6. Realtime sync updates the UI
7. Avatar appears in admin dashboard
```

---

## Files to Change

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | Download actual profile photo and send as base64 |
| `supabase/functions/runner-tasks/index.ts` | Process avatar data and upload to storage |

---

## Edge Cases Handled

- **No profile photo**: `avatar_url` remains null, no error
- **Photo download fails**: Logs error, continues with other profile data
- **Large photos**: Compressed by Telegram, typically under 100KB
- **Storage upload fails**: Logs error, other profile data still saved

