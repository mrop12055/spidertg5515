

# Fix: JSON Metadata Not Matching & Incorrect Upload Count

## Problems Identified

### Problem 1: JSON files not matching session files
The `extractPhoneFromFilename` function (line 578-585) only removes `.session` extension:

```typescript
const baseName = filename.replace(/\.session$/i, '');  // Only removes .session!
```

When you upload:
- `+123456789.session` -> extracts to `123456789` 
- `+123456789.json` -> extracts to `123456789json` (WRONG - .json not removed!)

This causes the JSON metadata map to use wrong keys, so session files can't find their matching JSON metadata.

### Problem 2: Backend returns "2 new" but UI shows "0 successful"
The backend logs confirm accounts ARE being inserted, but the frontend may not be correctly aggregating results. Need to add debug logging.

## Solution

### Fix 1: Update `extractPhoneFromFilename` to handle both extensions

**File:** `src/pages/Accounts.tsx` (lines 578-585)

**Before:**
```typescript
const extractPhoneFromFilename = (filename: string): string => {
  const baseName = filename.replace(/\.session$/i, '');  // Only .session
  const digits = baseName.replace(/\D/g, '');
  ...
};
```

**After:**
```typescript
const extractPhoneFromFilename = (filename: string): string => {
  // Remove BOTH .session and .json extensions
  const baseName = filename
    .replace(/\.session$/i, '')
    .replace(/\.json$/i, '');
  const digits = baseName.replace(/\D/g, '');
  ...
};
```

### Fix 2: Add debug logging for upload flow

Add console logs to track:
1. What phone keys are extracted from session files
2. What phone keys are extracted from JSON files  
3. How many matches are found
4. What metadata is attached to each account
5. What the backend response contains

### Fix 3: Improve metadata detection logging

In the upload mapping, log when device_model is found vs missing:

```typescript
const accountsToUpload = sessionFiles.map(sf => {
  const metadata = (sf as any).metadata;
  
  // Debug: Log what fields are available
  if (metadata) {
    console.log(`[Upload] ${sf.phoneNumber} metadata keys:`, Object.keys(metadata));
    console.log(`[Upload] ${sf.phoneNumber} device_model candidates:`, {
      device_model: metadata.device_model,
      device: metadata.device,
      deviceModel: metadata.deviceModel,
      model: metadata.model,
    });
  } else {
    console.log(`[Upload] ${sf.phoneNumber} has NO metadata`);
  }
  
  return { ... };
});
```

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/Accounts.tsx` | Fix `extractPhoneFromFilename` to remove `.json` extension; Add debug logging for upload flow |

## Expected Outcome

After fix:
- JSON files will correctly match their session files
- Device info will be extracted and saved to database
- Console logs will help debug any remaining issues
- Upload count will accurately reflect backend results

