

# Fix: Remove Invalid Wildcard and Disable MIME Type Filtering

## Problem Confirmed
The console logs show: `Skipped "*/*" because it is not a valid MIME type`

React-dropzone does NOT support wildcard MIME types like `*/*`. The JSON files are still being silently rejected because your browser reports them with a MIME type not in our list.

## Solution

Remove the MIME type filtering entirely and filter by file extension in code instead. This is the most reliable approach since browsers report inconsistent MIME types for `.json` files.

### Change: Disable Accept Filter Completely

Remove the `accept` prop from useDropzone and validate file extensions manually in the `onDrop` function:

**File: src/pages/Accounts.tsx (lines 738-764)**

Remove the entire `accept` configuration and add extension filtering in `onDrop`:

```typescript
const { getRootProps, getInputProps, isDragActive } = useDropzone({
  onDrop,
  onDropRejected: (rejectedFiles) => {
    console.log('[Upload Debug] Rejected files:', rejectedFiles.map(f => ({
      name: f.file.name,
      type: f.file.type,
      errors: f.errors
    })));
    if (rejectedFiles.length > 0) {
      toast.warning(`${rejectedFiles.length} files were rejected. Check console for details.`);
    }
  },
  // No accept filter - we validate extensions manually in onDrop
  disabled: isUploading,
  multiple: true
});
```

Then add validation at the start of `onDrop`:

```typescript
const onDrop = useCallback(async (acceptedFiles: File[]) => {
  // Filter to only allowed extensions
  const allowedExtensions = ['.session', '.json', '.zip'];
  const validFiles = acceptedFiles.filter(f => {
    const ext = f.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    return ext && allowedExtensions.includes(ext);
  });
  
  const rejectedCount = acceptedFiles.length - validFiles.length;
  if (rejectedCount > 0) {
    toast.warning(`${rejectedCount} files skipped (unsupported format)`);
  }
  
  console.log('[Upload Debug] Accepted files:', validFiles.map(f => ({
    name: f.name,
    type: f.type,
    size: f.size
  })));
  
  // Use validFiles instead of acceptedFiles for the rest
  // ...
```

## Files to Modify

| File | Change |
|------|--------|
| src/pages/Accounts.tsx | Remove `accept` prop from useDropzone, add manual extension filtering in `onDrop` |

## Why This Works
- Bypasses browser MIME type detection entirely
- Filters purely by file extension (`.session`, `.json`, `.zip`)
- Works consistently across Windows, macOS, Linux
- Eliminates the `*/*` warning

## Testing Steps
1. Hard-refresh the page (Ctrl+F5)
2. Delete the test account without metadata
3. Upload session + JSON files together
4. Check console for `[Upload Debug] Accepted files` showing both files
5. Verify database has metadata populated

