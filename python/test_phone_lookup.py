#!/usr/bin/env python3
"""
Test script to debug phone number lookup issues
Run: python test_phone_lookup.py +919021746544
"""

import asyncio
import sys
import base64
import tempfile
import os

from telethon import TelegramClient
from telethon.tl.functions.contacts import ImportContactsRequest, GetContactsRequest, SearchRequest
from telethon.tl.types import InputPhoneContact

from config import BACKEND_URL, SUPABASE_KEY, TELEGRAM_API_ID, TELEGRAM_API_HASH
import httpx

SESSION_FOLDER = tempfile.mkdtemp(prefix="test_session_")


async def get_first_active_account():
    """Get first active account from backend"""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{BACKEND_URL.replace('/functions/v1', '/rest/v1')}/telegram_accounts",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
            },
            params={"status": "eq.active", "limit": "1", "select": "*"}
        )
        accounts = resp.json()
        if accounts:
            return accounts[0]
    return None


async def test_lookup(phone_to_test: str):
    """Test phone lookup with detailed debugging"""
    print("=" * 60)
    print("  Phone Lookup Test")
    print("=" * 60)
    
    # Normalize phone
    phone = phone_to_test.strip()
    if not phone.startswith("+"):
        phone = "+" + phone
    
    print(f"\n📱 Testing phone: {phone}")
    
    # Get account
    print("\n1. Getting active account...")
    account = await get_first_active_account()
    if not account:
        print("   ❌ No active accounts found!")
        return
    
    print(f"   ✓ Using account: {account['phone_number']}")
    
    # Decode session
    session_data = account.get("session_data")
    if not session_data:
        print("   ❌ No session data!")
        return
    
    session_path = os.path.join(SESSION_FOLDER, account["phone_number"].replace("+", ""))
    session_bytes = base64.b64decode(session_data)
    with open(session_path + ".session", "wb") as f:
        f.write(session_bytes)
    
    # Get API credentials
    api_id = account.get("api_id") or TELEGRAM_API_ID
    api_hash = account.get("api_hash") or TELEGRAM_API_HASH
    
    print(f"   API ID: {api_id}")
    
    # Create client
    print("\n2. Connecting to Telegram...")
    client = TelegramClient(session_path, int(api_id), api_hash)
    await client.connect()
    
    if not await client.is_user_authorized():
        print("   ❌ Session expired!")
        return
    
    me = await client.get_me()
    print(f"   ✓ Connected as: {me.first_name} (@{me.username}) [ID: {me.id}]")
    
    # Check account restrictions
    print("\n3. Checking account status...")
    try:
        # Try to get contacts to see if account is restricted
        contacts = await client(GetContactsRequest(hash=0))
        print(f"   ✓ Account can access contacts ({len(contacts.users)} contacts)")
    except Exception as e:
        print(f"   ⚠ Contact access error: {e}")
    
    # Test Method 1: Direct entity lookup
    print("\n4. Method 1: Direct entity lookup...")
    try:
        entity = await client.get_entity(phone)
        print(f"   ✓ Found: {entity.first_name} {entity.last_name or ''} (ID: {entity.id})")
    except Exception as e:
        print(f"   ✗ Failed: {type(e).__name__}: {e}")
    
    # Test Method 2: Import contact
    print("\n5. Method 2: Import contact...")
    try:
        import random
        contact = InputPhoneContact(
            client_id=random.randint(0, 2**62),
            phone=phone,
            first_name="TestContact",
            last_name=str(random.randint(1000, 9999))
        )
        result = await client(ImportContactsRequest([contact]))
        
        print(f"   Users found: {len(result.users)}")
        print(f"   Imported: {len(result.imported)}")
        print(f"   Popular invites: {len(result.popular_invites)}")
        print(f"   Retry contacts: {len(result.retry_contacts)}")
        
        if result.users:
            user = result.users[0]
            print(f"   ✓ Imported user: {user.first_name} {user.last_name or ''} (ID: {user.id}, Phone: {user.phone})")
        elif result.retry_contacts:
            print(f"   ⚠ User exists but has privacy restrictions")
        else:
            print(f"   ✗ No user found for this phone")
            
    except Exception as e:
        print(f"   ✗ Import failed: {type(e).__name__}: {e}")
    
    # Test Method 3: Search
    print("\n6. Method 3: Search by phone...")
    try:
        # Search with just digits
        digits = ''.join(filter(str.isdigit, phone))[-10:]
        search_result = await client(SearchRequest(q=digits, limit=5))
        print(f"   Search results: {len(search_result.users)} users")
        for user in search_result.users:
            print(f"     - {user.first_name} {user.last_name or ''} (@{user.username or 'no username'})")
    except Exception as e:
        print(f"   ✗ Search failed: {type(e).__name__}: {e}")
    
    # Test Method 4: ResolvePhone (newer API)
    print("\n7. Method 4: ResolvePhone (newer API)...")
    try:
        from telethon.tl.functions.contacts import ResolvePhoneRequest
        resolved = await client(ResolvePhoneRequest(phone=phone))
        if resolved and resolved.users:
            user = resolved.users[0]
            print(f"   ✓ Resolved: {user.first_name} {user.last_name or ''} (ID: {user.id})")
        else:
            print(f"   ✗ No user resolved")
    except AttributeError:
        print(f"   ℹ ResolvePhoneRequest not available in this Telethon version")
    except Exception as e:
        print(f"   ✗ Resolve failed: {type(e).__name__}: {e}")
    
    # Check spambot status
    print("\n8. Checking SpamBot status...")
    try:
        spambot = await client.get_entity("@SpamBot")
        await client.send_message(spambot, "/start")
        await asyncio.sleep(2)
        
        async for msg in client.iter_messages(spambot, limit=1):
            status_text = msg.text[:200] if msg.text else "No response"
            if "no limits" in status_text.lower() or "free" in status_text.lower():
                print(f"   ✓ Account is NOT restricted")
            elif "limit" in status_text.lower() or "restrict" in status_text.lower():
                print(f"   ⚠ Account may be RESTRICTED")
            print(f"   SpamBot says: {status_text}...")
    except Exception as e:
        print(f"   ⚠ Could not check SpamBot: {e}")
    
    await client.disconnect()
    
    print("\n" + "=" * 60)
    print("  Test Complete")
    print("=" * 60)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_phone_lookup.py +919021746544")
        print("       python test_phone_lookup.py 919021746544")
        sys.exit(1)
    
    phone = sys.argv[1]
    asyncio.run(test_lookup(phone))
