## Findings from the deep check

I found several realistic ways the same Telegram session can be opened twice:

1. **Locks are taken after connecting, not before connecting**
   - The runner connects accounts first, then calls the backend lock route.
   - During startup/catch-up, another Python runner can fetch the same accounts and connect them too.

2. **Duplicate-runner guard is too short for startup**
   - The backend only blocks another runner if the previous heartbeat is newer than 15 seconds.
   - With hundreds of accounts, startup/catch-up can take much longer than 15 seconds before the next heartbeat.

3. **The lock route does not confirm which accounts were actually locked**
   - If another runner already owns a lock, the Python script still assumes it is safe.

4. **Some task paths can bypass account locks**
   - Campaign listening accounts are filtered by lock, but warmup, live chat, and account-action task account payloads can still be returned without checking whether the account is locked by another runner.

5. **Duplicate account rows can connect the same session inside one Python process**
   - The Python script locks by account ID only.
   - If two rows share the same phone/session data, they can create two TelegramClient instances for the same Telegram auth key.

6. **Crash/restart cleanup can be safer**
   - On internal restart, the script clears old clients and unlocks before a guaranteed graceful disconnect.
   - Failed/timeout connect attempts also do not always set a reconnect grace marker.

## Fix plan

1. **Pre-lock before Telegram connect**
   - Update the Python runner to claim account locks before creating any `TelegramClient`.
   - Only connect accounts that the backend confirms are locked by this runner instance.
   - If lock is denied, skip the account completely.

2. **Make backend locking authoritative**
   - Update the lock endpoint to return `locked_ids` and `rejected_ids`.
   - Allow locking only when the account is unlocked, already owned by the same runner, or stale.
   - Do not let Python assume a lock succeeded silently.

3. **Strengthen duplicate-runner protection**
   - Await the heartbeat write instead of fire-and-forget.
   - Increase the duplicate runner window so a second runner cannot start while the first is still connecting/catching up.
   - Add heartbeat renewal during long startup phases.

4. **Apply lock filtering to every task source**
   - Ensure campaign, warmup, live chat, and account-action tasks only return accounts available to this runner instance.
   - Prevent task processing from connecting an account owned by another runner.

5. **Add same-session protection inside Python**
   - Build a stable session key from normalized phone/session data.
   - Prevent two different account IDs with the same phone/session from connecting in the same Python process.
   - Deduplicate the startup account list before connection waves.

6. **Safer retry and restart cleanup**
   - Set reconnect grace after any failed/timeout connect attempt.
   - Disconnect stale clients before clearing local state on crash restart.
   - Avoid immediate reconnect while Telethon may still have a background connection closing.

7. **Fix the Windows runner launcher**
   - Adjust `RUN.bat` so it selects one Python command instead of running `py` and then launching `python` again after a real runner exit.

8. **Verify duplicate data risk**
   - Check the database for duplicate phone/session rows and report if any exist, because duplicate rows can also cause this issue even after code hardening.