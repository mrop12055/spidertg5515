

# Fix: Runner Crash After Catchup Due to Media Downloads

## Root Cause

The runner downloads **entire media files** (videos, documents, photos) into memory during catchup, base64-encodes them, and sends them as JSON to the backend. A single video can be 50-500MB. With multiple accounts catching up in parallel via `asyncio.gather`, RAM usage spikes massively and the OS kills the process (OOM kill with no Python traceback).

This also explains why the crash started happening recently -- it only crashes when there are **unread messages with media** (especially videos) waiting during catchup.

## Solution

### 1. Skip large media during catchup -- only sync text + metadata

During catchup, do NOT download media files. Instead, just report the message with a placeholder like `[Video]`, `[Photo]`, `[Document]`. The media is already stored on Telegram and can be fetched on-demand later from the chat UI. Catchup's job is to sync **message history**, not download files.

### 2. Cap media download size in the real-time handler

For the live `on_message` handler, add a size check. Skip download for media larger than 5MB to prevent a single large incoming file from causing issues.

### 3. Add full error logging in catchup

Replace the truncated error on line 1113 with full traceback so any remaining issues are visible.

### 4. Update version

Bump to `2026-02-10-media-fix-v12`.

## Technical Details

**File:** `src/pages/SetupGuide.tsx`

### Change 1: Catchup -- skip media downloads entirely (lines 1054-1076)

Replace the media download block in `fetch_unread_messages` with simple metadata detection:

```python
# Detect media type WITHOUT downloading (no memory spike)
media_url = None
media_type = None
if msg.media:
    if msg.photo:
        media_type = "image"
    elif msg.video:
        media_type = "video"
    elif msg.document:
        media_type = "document"
    else:
        media_type = "media"
    
    if not content:
        content = f"[{media_type.capitalize()}]"
```

This eliminates all memory-intensive downloads during the catchup phase.

### Change 2: Real-time handler -- add size guard (lines 907-927)

Add a file size check before downloading in `on_message`:

```python
if event.message.media:
    try:
        # Skip large files (>5MB) to prevent memory issues
        file_size = getattr(event.message.media, 'document', None)
        if file_size and hasattr(file_size, 'size') and file_size.size > 5 * 1024 * 1024:
            media_type = "document"
            content = content or "[Large file - skipped]"
        else:
            media_bytes = await asyncio.wait_for(event.message.download_media(bytes), timeout=30)
            # ... existing base64 logic ...
    except Exception as e:
        print(f"  [MEDIA] Download failed: {e}")
        if not content:
            content = "[Media]"
```

### Change 3: Full error logging in catchup (line 1112-1113)

```python
except Exception as e:
    import traceback
    print(f"  [CATCHUP] [{phone}] Error: {type(e).__name__}: {str(e)}")
    traceback.print_exc()
    sys.stdout.flush()
```

### Change 4: Version bump

```python
const runnerBuild = "2026-02-10-media-fix-v12";
```

## Why This Fixes It

- Catchup no longer downloads ANY media files, so RAM stays flat regardless of how many unread videos exist
- The runner will always survive catchup and reach the main loop
- Messages still get synced with correct text and media type labels
- Real-time handler gets a size guard to prevent future crashes from large incoming files
- Users can still see media in the chat -- the Telegram message ID is synced, so media can be fetched on-demand if needed later

