

# Fix: Support More JSON Field Names for Device Info

## Problem
When uploading session JSON files, the device_model field isn't being extracted for some accounts because their JSON uses different field names than what the code currently supports.

## Current Supported Fields
```javascript
device_model: metadata?.device_model || metadata?.device
system_version: metadata?.system_version || metadata?.sdk
```

## Solution
Expand the field name mapping to support all common variations from different Telegram session export tools.

## Changes to `src/pages/Accounts.tsx`

### 1. Update `JsonMetadata` Interface (lines 68-97)

Add additional field name variations:
```typescript
interface JsonMetadata {
  // ... existing fields ...
  
  // Device fingerprint - add more variations
  deviceModel?: string;      // camelCase (NEW)
  model?: string;            // shorthand (NEW)
  device_info?: string;      // alternative (NEW)
  deviceInfo?: string;       // camelCase (NEW)
  
  sdk?: string;
  system_version?: string;
  systemVersion?: string;    // camelCase (NEW)
  os_version?: string;       // alternative (NEW)
  
  // App version variations
  appVersion?: string;       // camelCase (NEW)
  app_version?: string;
  version?: string;          // shorthand (NEW)
}
```

### 2. Update Upload Mapping (lines 755-758)

Expand the fallback chain:
```typescript
// Device fingerprint - try all known field name variations
device_model: metadata?.device_model 
  || metadata?.device 
  || metadata?.deviceModel 
  || metadata?.model 
  || metadata?.device_info 
  || metadata?.deviceInfo,
  
system_version: metadata?.system_version 
  || metadata?.sdk 
  || metadata?.systemVersion 
  || metadata?.os_version,
  
app_version: metadata?.app_version 
  || metadata?.appVersion 
  || metadata?.version,
```

### 3. Add Debug Logging (Optional)

Add console logging during JSON parsing to help identify unrecognized field names:
```typescript
// In parseJsonMetadata function
console.log('[JSON Metadata] Parsed fields:', Object.keys(json));
if (!json.device_model && !json.device && !json.deviceModel) {
  console.log('[JSON Metadata] No device field found. Available fields:', json);
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Accounts.tsx` | Expand `JsonMetadata` interface and upload mapping |

## Alternative: User Action

If your JSON uses a completely different field name, please share a sample JSON structure so I can add specific support for it.

