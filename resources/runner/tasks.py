"""Task handlers for the local runner.

Each handler is `async def handle(worker, params, files_dir) -> dict`
returning a JSON-serializable result. Exceptions bubble up so the caller
marks the task failed with the message.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict

from telethon import functions, types, errors  # type: ignore


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def sync_profile(worker, params, files_dir):
    me = await worker.client.get_me(input_peer=False)
    full = await worker.client(functions.users.GetFullUserRequest(id="me"))
    about = getattr(getattr(full, "full_user", None), "about", None)
    return {
        "id": me.id,
        "username": me.username,
        "first_name": me.first_name,
        "last_name": me.last_name,
        "phone": me.phone,
        "premium": bool(getattr(me, "premium", False)),
        "about": about,
    }


async def change_name(worker, params, files_dir):
    first = (params or {}).get("first_name", "") or ""
    last = (params or {}).get("last_name", "") or ""
    await worker.client(functions.account.UpdateProfileRequest(first_name=first, last_name=last))
    return {"first_name": first, "last_name": last}


async def change_bio(worker, params, files_dir):
    bio = (params or {}).get("bio", "") or ""
    await worker.client(functions.account.UpdateProfileRequest(about=bio))
    return {"bio": bio}


async def change_photo(worker, params, files_dir):
    url_or_path = (params or {}).get("photo_url") or (params or {}).get("path")
    if not url_or_path:
        raise ValueError("photo_url missing")
    local_path = url_or_path
    if url_or_path.startswith(("http://", "https://")):
        import urllib.request
        os.makedirs(files_dir, exist_ok=True)
        local_path = os.path.join(files_dir, f"pfp_{worker.id}.jpg")
        urllib.request.urlretrieve(url_or_path, local_path)
    file = await worker.client.upload_file(local_path)
    await worker.client(functions.photos.UploadProfilePhotoRequest(file=file))
    return {"uploaded": True}


async def remove_photo(worker, params, files_dir):
    photos = await worker.client.get_profile_photos("me")
    if not photos:
        return {"removed": 0}
    await worker.client(functions.photos.DeletePhotosRequest(id=[
        types.InputPhoto(id=p.id, access_hash=p.access_hash, file_reference=p.file_reference)
        for p in photos
    ]))
    return {"removed": len(photos)}


async def logout_sessions(worker, params, files_dir):
    await worker.client(functions.auth.ResetAuthorizationsRequest())
    return {"reset": True}


async def change_password(worker, params, files_dir):
    existing = (params or {}).get("existing_password") or None
    new_pw = (params or {}).get("new_password") or None
    if not new_pw:
        raise ValueError("new_password required")
    await worker.client.edit_2fa(current_password=existing, new_password=new_pw)
    return {"changed": True}


async def privacy_settings(worker, params, files_dir):
    # Accept a map { last_seen|phone|profile_photo|forwards|calls: 'everyone'|'contacts'|'nobody' }
    mapping = {
        "last_seen": types.InputPrivacyKeyStatusTimestamp,
        "phone": types.InputPrivacyKeyPhoneNumber,
        "profile_photo": types.InputPrivacyKeyProfilePhoto,
        "forwards": types.InputPrivacyKeyForwards,
        "calls": types.InputPrivacyKeyPhoneCall,
    }
    applied = {}
    for key, cls in mapping.items():
        v = (params or {}).get(key)
        if not v:
            continue
        rule_cls = {
            "everyone": types.InputPrivacyValueAllowAll,
            "contacts": types.InputPrivacyValueAllowContacts,
            "nobody": types.InputPrivacyValueDisallowAll,
        }.get(v)
        if not rule_cls:
            continue
        await worker.client(functions.account.SetPrivacyRequest(key=cls(), rules=[rule_cls()]))
        applied[key] = v
    return {"applied": applied}


async def spambot_check(worker, params, files_dir):
    entity = await worker.client.get_entity("@SpamBot")
    async with worker.client.conversation(entity, timeout=20) as conv:
        await conv.send_message("/start")
        resp = await conv.get_response()
        text = resp.raw_text or ""
    lowered = text.lower()
    if "no limits" in lowered or "is free" in lowered:
        status = "clean"
    elif "limited" in lowered or "restricted" in lowered:
        status = "limited"
    else:
        status = "unknown"
    return {"status": status, "response": text[:500]}


async def block_contact(worker, params, files_dir):
    action = (params or {}).get("action", "block")
    target = (
        (params or {}).get("target_telegram_id")
        or (params or {}).get("target_username")
        or (params or {}).get("target_phone")
    )
    if not target:
        raise ValueError("no target")
    entity = await worker.client.get_entity(target)
    if action == "unblock":
        await worker.client(functions.contacts.UnblockRequest(id=entity))
    else:
        await worker.client(functions.contacts.BlockRequest(id=entity))
    return {"action": action, "target": str(target)}


async def import_contacts(worker, params, files_dir):
    phones = (params or {}).get("phone_numbers") or []
    if not phones:
        return {"imported": 0, "invalid": []}
    input_contacts = []
    for i, ph in enumerate(phones):
        input_contacts.append(types.InputPhoneContact(
            client_id=i, phone=ph, first_name=ph, last_name=""
        ))
    r = await worker.client(functions.contacts.ImportContactsRequest(contacts=input_contacts))
    imported = [getattr(u, "phone", None) for u in getattr(r, "users", [])]
    return {
        "imported": len(imported),
        "retry_contacts": list(getattr(r, "retry_contacts", []) or []),
        "phones": imported,
    }


HANDLERS = {
    "sync_profile": sync_profile,
    "change_name": change_name,
    "change_bio": change_bio,
    "change_photo": change_photo,
    "remove_photo": remove_photo,
    "logout_sessions": logout_sessions,
    "change_password": change_password,
    "privacy_settings": privacy_settings,
    "spambot_check": spambot_check,
}
