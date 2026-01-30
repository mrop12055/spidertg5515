
# Plan: Fix Incoming Media (Picture) Receiving

## Overview

Modify the Python runner and Edge Function to properly download, store, and display incoming media (photos, videos, documents) in the admin dashboard.

---

## Current vs Fixed Flow

```text
CURRENT (Broken):
1. User receives photo on Telegram
2. Python runner reports: {"content": "[Media]"}
3. Edge saves message with no media_url
4. UI shows "[Media]" text - no picture!

FIXED:
1. User receives photo on Telegram
2. Python downloads photo as bytes
3. Python sends base64 to Edge Function
4. Edge uploads to Supabase Storage
5. Edge saves message with media_url
6. UI displays the actual image!
```

---

## Technical Changes

### 1. Python Runner - Download Incoming Media

**File**: `src/pages/SetupGuide.tsx`

**Change 1**: Update `on_message()` handler (lines 819-846) to download media

```python
async def on_message(event, acc_id: str):
    """Handle incoming messages - registered on all clients."""
    try:
        sender = await event.get_sender()
        if not sender or not isinstance(sender, User) or getattr(sender, 'bot', False):
            return
        if not getattr(sender, 'contact', False):
            return
        
        phone = None
        if hasattr(sender, 'phone') and sender.phone:
            phone = f"+{sender.phone}" if not sender.phone.startswith('+') else sender.phone
        
        name = f"{sender.first_name or ''} {sender.last_name or ''}".strip() or str(sender.id)
        content = event.message.text or ""
        
        # Download media if present
        media_url = None
        media_type = None
        if event.message.media:
            try:
                import base64
                media_bytes = await event.message.download_media(bytes)
                if media_bytes:
                    b64 = base64.b64encode(media_bytes).decode()
                    # Determine media type
                    if event.message.photo:
                        media_type = "image"
                        media_url = f"data:image/jpeg;base64,{b64}"
                    elif event.message.video:
                        media_type = "video"
                        media_url = f"data:video/mp4;base64,{b64}"
                    elif event.message.document:
                        media_type = "document"
                        media_url = f"data:application/octet-stream;base64,{b64}"
                    
                    if not content:
                        content = f"[{media_type.capitalize()}]"
            except Exception as e:
                print(f"  [MEDIA] Download failed: {e}")
                if not content:
                    content = "[Media]"
        
        acc = accounts.get(acc_id, {})
        print(f"  📩 [{acc.get('phone_number','?')[-4:]}] ← {name[:12]}: {content[:25]}...")
        
        await report("incoming_message", {
            "account_id": acc_id,
            "sender_id": sender.id,
            "sender_name": name,
            "sender_username": getattr(sender, 'username', None),
            "sender_phone": phone,
            "content": content,
            "telegram_message_id": event.message.id,
            "media_url": media_url,
            "media_type": media_type
        })
    except:
        pass
```

**Change 2**: Update `fetch_unread_messages()` similarly (lines 885-916)

```python
for msg in reversed(messages):
    if not msg.text and not msg.media:
        continue
    
    # SKIP messages older than 24 hours
    if msg.date and msg.date < cutoff_time:
        skipped_old += 1
        continue
    
    content = msg.text or ""
    media_url = None
    media_type = None
    
    # Download media if present
    if msg.media:
        try:
            import base64
            media_bytes = await client.download_media(msg, bytes)
            if media_bytes:
                b64 = base64.b64encode(media_bytes).decode()
                if msg.photo:
                    media_type = "image"
                    media_url = f"data:image/jpeg;base64,{b64}"
                elif msg.video:
                    media_type = "video"
                    media_url = f"data:video/mp4;base64,{b64}"
                else:
                    media_type = "document"
                    media_url = f"data:application/octet-stream;base64,{b64}"
                
                if not content:
                    content = f"[{media_type.capitalize()}]"
        except:
            if not content:
                content = "[Media]"
    
    await report("incoming_message", {
        "account_id": acc_id,
        "sender_id": entity.id,
        "sender_name": name,
        "sender_username": getattr(entity, 'username', None),
        "sender_phone": sender_phone,
        "content": content,
        "telegram_message_id": msg.id,
        "media_url": media_url,
        "media_type": media_type
    })
```

---

### 2. Edge Function - Process Incoming Media

**File**: `supabase/functions/runner-tasks/index.ts`

**Update** `processIncomingMessage()` function (around line 887) to handle media upload:

```typescript
async function processIncomingMessage(supabase: any, r: any, now: string) {
  const accountId = r.account_id;
  const senderId = r.sender_id || r.recipient_telegram_id;
  const senderPhone = r.sender_phone || r.recipient_phone;
  const senderName = r.sender_name || r.recipient_name;
  const senderUsername = r.sender_username || r.recipient_username;
  const content = r.content || "[Media]";
  const telegramMessageId = r.telegram_message_id;

  // Process media if provided
  let mediaUrl: string | null = null;
  let mediaType: string | null = r.media_type || null;
  
  if (r.media_url && r.media_url.startsWith('data:')) {
    try {
      const base64Data = r.media_url.split(',')[1];
      const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      
      const ext = mediaType === 'image' ? 'jpg' : mediaType === 'video' ? 'mp4' : 'bin';
      const filename = `incoming/${accountId}/${Date.now()}_${telegramMessageId || 'msg'}.${ext}`;
      
      const { error: uploadError } = await supabase.storage
        .from('message-attachments')
        .upload(filename, binaryData, { 
          contentType: mediaType === 'image' ? 'image/jpeg' : 
                       mediaType === 'video' ? 'video/mp4' : 
                       'application/octet-stream',
          upsert: true 
        });
      
      if (!uploadError) {
        const { data: urlData } = supabase.storage
          .from('message-attachments')
          .getPublicUrl(filename);
        mediaUrl = urlData.publicUrl;
        console.log(`[incoming] Uploaded media: ${filename}`);
      } else {
        console.error('[incoming] Media upload error:', uploadError);
      }
    } catch (e) {
      console.error('[incoming] Media processing failed:', e);
    }
  } else if (r.media_url) {
    // Direct URL (already hosted)
    mediaUrl = r.media_url;
  }

  // ... existing conversation lookup code ...

  // Insert the incoming message WITH media
  const { error: msgError } = await supabase
    .from("messages")
    .insert({
      account_id: accountId,
      conversation_id: conversationId,
      content: content,
      direction: 'incoming',
      status: 'delivered',
      delivered_at: now,
      telegram_message_id: telegramMessageId,
      media_url: mediaUrl,      // NEW
      media_type: mediaType,    // NEW
    });
  
  // ...
}
```

---

## Files to Change

| File | Change |
|------|--------|
| `src/pages/SetupGuide.tsx` | Download incoming media in `on_message()` and `fetch_unread_messages()`, send as base64 |
| `supabase/functions/runner-tasks/index.ts` | Process base64 media in `processIncomingMessage()`, upload to storage, save URL |

---

## Edge Cases Handled

| Scenario | Handling |
|----------|----------|
| Text-only message | No media processing, works as before |
| Photo message | Downloads, uploads as JPG, displays in UI |
| Video message | Downloads, uploads as MP4, displays in UI |
| Large files | Telegram compresses photos; videos may be larger |
| Download fails | Falls back to `[Media]` text |
| Upload fails | Logs error, message still saved without media |
| Duplicate messages | Existing deduplication by `telegram_message_id` |

---

## Result After Fix

- **Outgoing media**: Already works (uploads from UI)
- **Incoming media**: Will now download from Telegram, upload to storage, and display in chat
- **Avatar sync**: Already fixed in previous change
