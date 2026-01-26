
# Plan: Add URL Format Support for Proxy Import

## Current Issue

The proxy import only supports the colon-separated format:
```text
host:port:username:password:type
```

But many proxy providers supply proxies in URL format:
```text
socks5://username:password@host:port
```

Your example:
```text
socks5://99180_JBIPc_c_in_smartpath_m_speed_s_KZ43P7XRB93KEEIU:tA8YZ0MjsN@residential.pingproxies.com:8971
```

---

## Solution Overview

Create a unified proxy parser that automatically detects and handles both formats:

1. **URL Format**: `protocol://user:pass@host:port`
2. **Colon Format**: `host:port:user:pass:type`

---

## Implementation Details

### File 1: `src/pages/Proxies.tsx`

Update the `parseBulkProxies()` function (around line 299) to:

```typescript
const parseBulkProxies = () => {
  const lines = bulkProxies.split('\n').filter(l => l.trim());
  const parsed: ProxyToAdd[] = lines.map(line => {
    const trimmed = line.trim();
    
    // Check if it's URL format: protocol://user:pass@host:port
    const urlMatch = trimmed.match(
      /^(https?|socks[45]):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/i
    );
    
    if (urlMatch) {
      const [, protocol, username, password, host, port] = urlMatch;
      return {
        host,
        port: parseInt(port) || 8080,
        username: username || undefined,
        password: password || undefined,
        type: protocol.toLowerCase().replace('socks', 'socks') as string,
      };
    }
    
    // Fallback to colon format: host:port:user:pass:type
    const parts = trimmed.split(':');
    const specifiedType = parts[4]?.toLowerCase();
    const validTypes = ['http', 'https', 'socks4', 'socks5'];
    
    return {
      host: parts[0] || '',
      port: parseInt(parts[1]) || 8080,
      username: parts[2] || undefined,
      password: parts[3] || undefined,
      type: validTypes.includes(specifiedType) ? specifiedType : bulkProxyType,
    };
  }).filter(p => p.host);
  
  setParsedProxies(parsed);
  return parsed;
};
```

### File 2: `src/hooks/useDatabase.ts`

Update the `addProxiesBulk()` function (around line 222) with the same URL parsing logic for consistency.

---

## Supported Formats After Implementation

| Format | Example |
|--------|---------|
| URL with auth | `socks5://user:pass@host.com:8971` |
| URL without auth | `http://proxy.example.com:8080` |
| Colon with type | `host.com:8080:user:pass:socks5` |
| Colon without type | `host.com:8080:user:pass` (uses selected default) |
| Colon minimal | `host.com:8080` |

---

## UI Enhancement

Add a hint in the bulk import dialog showing both supported formats:

```text
Supported formats:
• socks5://user:pass@host:port
• host:port:user:pass:type
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/Proxies.tsx` | Update `parseBulkProxies()` to detect URL format |
| `src/hooks/useDatabase.ts` | Update `addProxiesBulk()` with same parsing logic |

---

## Expected Outcome

After implementation, you can paste proxies in either format:
```text
socks5://99180_JBIPc_c_in_smartpath_m_speed_s_KZ43P7XRB93KEEIU:tA8YZ0MjsN@residential.pingproxies.com:8971
residential.pingproxies.com:8971:99180_JBIPc:tA8YZ0MjsN:socks5
```

Both will be correctly parsed and imported.
