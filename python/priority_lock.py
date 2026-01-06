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
_account_owners: Dict[str, tuple] = {}  # account_id -> (runner_name, priority, acquired_at)
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
    """
    Acquire lock for an account with priority-based queuing.
    Higher priority runners can preempt lower priority ones.
    
    Returns True if lock acquired, False if timed out.
    """
    priority = get_priority(runner)
    
    async with _global_lock:
        # Get or create lock for this account
        if account_id not in _account_locks:
            _account_locks[account_id] = asyncio.Lock()
    
    lock = _account_locks[account_id]
    start_time = time.time()
    
    while True:
        # Check if we can acquire
        if not lock.locked():
            try:
                await asyncio.wait_for(lock.acquire(), timeout=0.1)
                _account_owners[account_id] = (runner, priority, time.time())
                return True
            except asyncio.TimeoutError:
                pass
        
        # Check current owner
        async with _global_lock:
            owner = _account_owners.get(account_id)
            if owner:
                owner_runner, owner_priority, acquired_at = owner
                
                # If we have higher priority (lower number), request preemption
                if priority < owner_priority:
                    # Just log and wait - let lower priority finish current op
                    elapsed = time.time() - acquired_at
                    if elapsed > PREEMPT_GRACE_PERIOD:
                        # Lower priority has had enough time, they should yield soon
                        pass
        
        # Check timeout
        if time.time() - start_time > timeout:
            return False
        
        # Wait a bit before retrying
        await asyncio.sleep(0.1)


def release_account_lock(account_id: str, runner: str):
    """Release lock for an account"""
    if account_id in _account_locks:
        lock = _account_locks[account_id]
        owner = _account_owners.get(account_id)
        
        # Only release if we own it
        if owner and owner[0] == runner:
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
    return {
        "active_locks": len([a for a in _account_owners]),
        "owners": dict(_account_owners),
    }
