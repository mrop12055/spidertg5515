"""
TelegramCRM - Priority Lock Manager
=====================================
Prevents SQLite "database is locked" errors by coordinating
access across runners with priority-based queueing.

Priority levels (lower = higher priority):
1. livechat  - HIGHEST (real-time user interactions)
2. campaign  - HIGH (time-sensitive outreach)
3. warmup    - MEDIUM (background warming)
4. account   - LOW (management tasks)
5. block     - LOWEST (cleanup tasks)
"""

import asyncio
import time
from typing import Dict, Optional
from collections import defaultdict

# Priority levels (lower number = higher priority)
PRIORITY_LEVELS = {
    "livechat": 1,
    "campaign": 2,
    "warmup": 3,
    "warmup_chat": 3,
    "account": 4,
    "block": 5,
}

# Global lock state
_account_locks: Dict[str, asyncio.Lock] = {}
# account_id -> (runner_name, priority, acquired_at, reentrancy_count)
_account_owners: Dict[str, tuple] = {}
_pending_queue: Dict[str, list] = defaultdict(list)  # account_id -> [(priority, event, runner)]
_global_lock = asyncio.Lock()

# Configuration
LOCK_TIMEOUT = 30.0  # Maximum time to hold a lock
WAIT_TIMEOUT = 15.0  # Maximum time to wait for a lock
PREEMPT_GRACE_PERIOD = 2.0  # Let lower priority finish current operation


def get_priority(runner: str) -> int:
    """Get priority level for a runner (lower = higher priority)"""
    return PRIORITY_LEVELS.get(runner, 10)


async def acquire_account_lock(account_id: str, runner: str, timeout: float = WAIT_TIMEOUT) -> bool:
    """Acquire lock for an account with priority-based queuing.

    Notes:
    - Locks are re-entrant per runner (same runner can acquire multiple times).
    - Stale locks are force-released after LOCK_TIMEOUT to avoid permanent deadlocks.

    Returns True if lock acquired, False if timed out.
    """
    priority = get_priority(runner)

    async with _global_lock:
        if account_id not in _account_locks:
            _account_locks[account_id] = asyncio.Lock()

        # Re-entrant: if we already own the lock, just bump the count.
        owner = _account_owners.get(account_id)
        if owner:
            owner_runner, owner_priority, acquired_at, count = owner
            if owner_runner == runner:
                _account_owners[account_id] = (owner_runner, owner_priority, acquired_at, count + 1)
                return True

            # Stale owner safeguard
            if (time.time() - acquired_at) > LOCK_TIMEOUT:
                try:
                    if _account_locks[account_id].locked():
                        _account_locks[account_id].release()
                except RuntimeError:
                    pass
                _account_owners.pop(account_id, None)

    lock = _account_locks[account_id]
    start_time = time.time()

    while True:
        # Try acquire when available
        if not lock.locked():
            try:
                await asyncio.wait_for(lock.acquire(), timeout=0.2)
                async with _global_lock:
                    _account_owners[account_id] = (runner, priority, time.time(), 1)
                return True
            except asyncio.TimeoutError:
                pass

        # Check staleness + priority (soft)
        async with _global_lock:
            owner = _account_owners.get(account_id)
            if owner:
                owner_runner, owner_priority, acquired_at, count = owner

                # Force-release stale locks
                if (time.time() - acquired_at) > LOCK_TIMEOUT:
                    try:
                        if lock.locked():
                            lock.release()
                    except RuntimeError:
                        pass
                    _account_owners.pop(account_id, None)
                else:
                    # Higher priority runner is waiting; we don't forcibly preempt,
                    # but this makes intent visible for future yield logic.
                    if priority < owner_priority:
                        pass

        if (time.time() - start_time) > timeout:
            return False

        await asyncio.sleep(0.1)


def release_account_lock(account_id: str, runner: str):
    """Release lock for an account (re-entrant)."""
    if account_id not in _account_locks:
        return

    lock = _account_locks[account_id]

    # Only release if we own it
    owner = _account_owners.get(account_id)
    if not owner:
        return

    owner_runner, owner_priority, acquired_at, count = owner
    if owner_runner != runner:
        return

    # Re-entrant release
    if count > 1:
        _account_owners[account_id] = (owner_runner, owner_priority, acquired_at, count - 1)
        return

    # Final release
    _account_owners.pop(account_id, None)
    if lock.locked():
        try:
            lock.release()
        except RuntimeError:
            pass  # Lock was already released


def should_yield(account_id: str, current_runner: str) -> bool:
    """
    Check if current runner should yield to a higher priority runner.
    Call this periodically in long-running operations.
    """
    # Not implemented yet - for future optimization
    # Would check pending queue for higher priority waiters
    return False


class AccountLock:
    """Context manager for priority-based account locking"""
    
    def __init__(self, account_id: str, runner: str, timeout: float = WAIT_TIMEOUT):
        self.account_id = account_id
        self.runner = runner
        self.timeout = timeout
        self.acquired = False
    
    async def __aenter__(self):
        self.acquired = await acquire_account_lock(self.account_id, self.runner, self.timeout)
        if not self.acquired:
            raise asyncio.TimeoutError(f"Could not acquire lock for {self.account_id} ({self.runner})")
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.acquired:
            release_account_lock(self.account_id, self.runner)
        return False


async def with_priority_lock(account_id: str, runner: str, coro, timeout: float = WAIT_TIMEOUT):
    """
    Execute a coroutine with priority-based locking.
    
    Usage:
        result = await with_priority_lock(account_id, "livechat", some_async_func())
    """
    async with AccountLock(account_id, runner, timeout):
        return await coro


# Simplified API for quick lock/unlock
async def lock_account(account_id: str, runner: str) -> bool:
    """Quick lock - returns True if acquired"""
    return await acquire_account_lock(account_id, runner)


def unlock_account(account_id: str, runner: str):
    """Quick unlock"""
    release_account_lock(account_id, runner)


def get_lock_stats() -> dict:
    """Get current lock statistics for debugging"""
    owners = {}
    for acc_id, owner in _account_owners.items():
        runner, priority, acquired_at, count = owner
        owners[acc_id] = {
            "runner": runner,
            "priority": priority,
            "acquired_at": acquired_at,
            "count": count,
        }

    return {
        "active_locks": len(_account_owners),
        "owners": owners,
    }
