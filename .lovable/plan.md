

# Fix: JSON Files Being Silently Rejected by Dropzone

## Problem Identified
The 359 new accounts were uploaded **without JSON metadata** because the JSON files are being **silently rejected** by the dropzone before they reach the processing code.

**Root Cause**: The `react-dropzone` `accept` configuration filters files by MIME type. When you select JSON files, your browser may report them with a MIME type that doesn't match the configured list (e.g., `application/octet-stream` for `.json` files on Windows), causing them to be silently dropped.

## Evidence
- The debug logs `[Upload Debug]` never appeared in the console
- All 359 new accounts have no metadata, suggesting 0 JSON files were processed
- The upload at 13:58:34 UTC shows all accounts missing `device_model`, `api_id`, `api_hash`

## Solution

### Change 1: Remove Strict MIME Type Filtering
Instead of filtering by MIME type (which varies by browser/OS), accept all files and filter by extension in code.

**Current code (lines 731-744):**
```typescript
const { getRootProps, getInputProps, isDragActive } = useDropzone({
  onDrop,
  accept: {
    'application/x-sqlite3': ['.session'],
    'application/octet-stream': ['.session'],
    'application/json': ['.json'],
    'text/json': ['.json'],
    'text/plain': ['.json'],
    'application/zip': ['.zip'],
    'application/x-zip-compressed': ['.zip'],
  },
  disabled: isUploading,
  multiple: true
});
```

**New code:**
```typescript
const { getRootProps, getInputProps, isDragActive } = useDropzone({
  onDrop,
  accept: {
    // Accept common MIME types but also use wildcard
    'application/x-sqlite3': ['.session'],
    'application/octet-stream': ['.session', '.json'],
    'application/json': ['.json'],
    'text/json': ['.json'],
    'text/plain': ['.json', '.session'],
    'application/zip': ['.zip'],
    'application/x-zip-compressed': ['.zip'],
    // Fallback for any file type - we filter by extension in onDrop
    '*/*': ['.session', '.json', '.zip'],
  },
  disabled: isUploading,
  multiple: true
});
```

### Change 2: Add Rejected Files Logging
Add `onDropRejected` callback to see if files are being rejected:

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
  accept: { /* ... */ },
  // ...
});
```

### Change 3: Add Early Debug Logging in onDrop
Log what files actually made it through:

```typescript
const onDrop = useCallback(async (acceptedFiles: File[]) => {
  console.log('[Upload Debug] Accepted files:', acceptedFiles.map(f => ({
    name: f.name,
    type: f.type,
    size: f.size
  })));
  
  // ... rest of function
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Accounts.tsx` | Update dropzone accept config, add onDropRejected handler, add early logging |

## Technical Details

The `accept` prop in react-dropzone uses MIME types as keys with file extensions as values. The issue is:
- Different browsers report different MIME types for `.json` files
- Windows may use `application/octet-stream` for `.json`
- macOS may use `text/plain` or nothing
- The wildcard `*/*` approach ensures all files with the correct extensions are accepted

## Testing Steps
1. **Delete** the 359 accounts without metadata
2. **Refresh** the page to ensure new code is loaded
3. **Upload** your session + JSON files again
4. **Check console** for `[Upload Debug]` messages
5. **Verify** toast shows "X with JSON metadata"
6. **Query database** to confirm metadata is populated

