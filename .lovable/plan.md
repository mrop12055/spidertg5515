

# Plan: Add Proxy Debug Logging to Python Runner

## Problem
When accounts connect, there's no log output showing which proxy is being used (or if no proxy is configured). This makes it impossible to verify proxies are working.

## Solution
Add print statements to the `connect()` function to clearly show proxy information when each account connects.

---

## Changes Required

### File: `src/pages/SetupGuide.tsx`

**Location:** Inside the `connect()` function, after proxy is extracted and before TelegramClient is created

Add these debug lines:

```python
# After get_proxy() is called, add:
p_data = acc.get("proxies") or acc.get("proxy")
if proxy:
    print(f"  [PROXY] [{phone[-4:]}] Using: {p_data.get('host')}:{p_data.get('port')} ({p_data.get('proxy_type', 'socks5')})")
else:
    print(f"  [PROXY] [{phone[-4:]}] WARNING: No proxy configured!")
```

---

## Expected Output After Fix

**With proxy:**
```
  [PROXY] [6401] Using: residential.pingproxies.com:8265 (socks5)
  [CONNECT] [6401] Starting connection...
  ✓ [6401] Connected
```

**Without proxy:**
```
  [PROXY] [6401] WARNING: No proxy configured!
  [CONNECT] [6401] Starting connection...
  ✗ [6401] Connection failed - no proxy
```

---

## Summary

This is a simple logging addition that will show you exactly:
1. Which proxy each account is using
2. The host, port, and type of proxy
3. A warning if no proxy is configured

No changes to frozen account handling - only active accounts will be fetched as before.

