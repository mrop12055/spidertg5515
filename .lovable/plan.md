

# Fix: JSON Metadata Not Being Matched for Direct File Uploads

## Problem Identified
When uploading `.session` and `.json` files directly (not via ZIP), the JSON metadata is not being associated with the accounts. 359 accounts are missing their device fingerprint, API credentials, and other metadata.

## Root Cause Analysis
After reviewing the code in `src/pages/Accounts.tsx`, the phone key extraction logic appears correct:

```javascript
const extractPhoneFromFilename = (filename: string): string => {
  const baseName = filename.replace(/\.session$/i, '');  // Only strips .session
  const digits = baseName.replace(/\D/g, '');  // Strips all non-digits (including .json letters)
  // ...
};
```

**Potential Issues:**
1. **File selection order**: If `.session` and `.json` files aren't selected together in the same dialog, they won't be matched
2. **Filename format differences**: Slight variations like leading zeros, spaces, or special characters could cause mismatches
3. **File MIME type rejection**: The dropzone might not accept `.json` files in some browsers

## Solution

### 1. Improve Phone Key Extraction (line 570-577)
Make the function explicitly handle both `.session` and `.json` extensions:

```javascript
const extractPhoneFromFilename = (filename: string): string => {
  // Strip both .session and .json extensions
  const baseName = filename
    .replace(/\.session$/i, '')
    .replace(/\.json$/i, '');
  const digits = baseName.replace(/\D/g, '');
  if (!digits) {
    return `+unknown_${Date.now()}`;
  }
  return `+${digits}`;
};
```

### 2. Add Debug Logging (temporary)
Add console logs to see exactly what's happening during file matching:

```javascript
console.log('Session files phone keys:', Array.from(allSessions.keys()));
console.log('JSON files phone keys:', Array.from(allJsons.keys()));
```

### 3. Add Matching Report Toast
After processing, show how many JSON files matched:

```javascript
const matchedCount = Array.from(allSessions.keys())
  .filter(key => allJsons.has(key)).length;
console.log(`Matched ${matchedCount}/${allSessions.size} sessions with JSON metadata`);
```

### 4. Verify MIME Type Acceptance
Ensure `.json` files are properly accepted in the dropzone config (line 722-733):

```javascript
accept: {
  'application/x-sqlite3': ['.session'],
  'application/octet-stream': ['.session'],
  'application/json': ['.json'],
  'text/json': ['.json'],  // Add this
  'application/zip': ['.zip'],
  'application/x-zip-compressed': ['.zip'],
},
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Accounts.tsx` | Fix extractPhoneFromFilename, add debug logging, improve MIME types |

## Testing Steps
1. Upload session + JSON files directly (not ZIP)
2. Check browser console for phone key matching logs
3. Verify toast shows "X with JSON metadata"
4. Check database for populated metadata fields

