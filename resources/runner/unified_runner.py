"""TelegramCRM local runner (Phase 3 skeleton).

This file is bundled with the desktop app and spawned by the Electron main
process. It replaces the previous cloud-hosted VPS runner. The full Telethon
worker logic is ported here in a follow-up pass; for now this skeleton:

  * reads the local API URL, sessions dir and files dir from env vars
  * emits a heartbeat every 10s so the Dashboard shows "running"
  * exits cleanly on Ctrl+C / SIGTERM

Environment variables (set by electron/runner.cjs):
  TCRM_API_URL          e.g. http://127.0.0.1:53211
  TCRM_SESSIONS_DIR     path to .session files
  TCRM_FILES_DIR        path to attachments
  TCRM_USER_DATA        app data root
"""

from __future__ import annotations

import os
import signal
import sys
import time
from datetime import datetime, timezone

API_URL = os.environ.get("TCRM_API_URL", "http://127.0.0.1:0")
SESSIONS_DIR = os.environ.get("TCRM_SESSIONS_DIR", "")
FILES_DIR = os.environ.get("TCRM_FILES_DIR", "")

_stop = False


def _handle_signal(signum, _frame):
    global _stop
    _stop = True
    print(f"[runner] signal {signum} received, shutting down", flush=True)


def main() -> int:
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handle_signal)
        except (ValueError, OSError):
            pass

    print(f"[runner] starting python={sys.version.split()[0]}", flush=True)
    print(f"[runner] api={API_URL}", flush=True)
    print(f"[runner] sessions={SESSIONS_DIR}", flush=True)
    print(f"[runner] files={FILES_DIR}", flush=True)

    tick = 0
    while not _stop:
        tick += 1
        now = datetime.now(timezone.utc).isoformat()
        print(f"[runner] heartbeat {tick} {now}", flush=True)
        # Sleep in short slices so signals are handled promptly.
        for _ in range(10):
            if _stop:
                break
            time.sleep(1)

    print("[runner] stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
