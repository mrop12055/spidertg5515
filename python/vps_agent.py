"""
TelegramCRM VPS Agent
Manages all Python runners remotely - start/stop/restart/update
Polls Supabase for commands and reports status back
"""

import os
import sys
import asyncio
import signal
import subprocess
import zipfile
import io
import platform
from datetime import datetime, timezone
from typing import Dict, Optional

import httpx

# Configuration - will be replaced by SetupGuide download
SUPABASE_URL = "YOUR_SUPABASE_URL"
SUPABASE_KEY = "YOUR_SUPABASE_KEY"
VPS_API_KEY = "YOUR_VPS_API_KEY"  # Generated when VPS is registered

# Get the directory where this script lives
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Runner definitions (block_runner removed)
RUNNERS = {
    "campaign": "campaign_runner.py",
    "livechat": "livechat_runner.py",
    "account": "account_runner.py",
    "warmup": "warmup_runner.py",
}

# Global state
RUNNING = True
processes: Dict[str, subprocess.Popen] = {}
vps_id: Optional[str] = None

POLL_INTERVAL = 5  # seconds
HEARTBEAT_INTERVAL = 10  # seconds


def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


async def register_vps(client: httpx.AsyncClient) -> Optional[str]:
    """Register this VPS and get its ID."""
    global vps_id
    
    # Check if already registered
    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers=get_headers(),
        params={"api_key": f"eq.{VPS_API_KEY}", "select": "id"}
    )
    
    if resp.status_code == 200 and resp.json():
        vps_id = resp.json()[0]["id"]
        print(f"[VPS] Found existing VPS: {vps_id[:8]}...")
        return vps_id
    
    # Register new VPS
    ip = await get_public_ip(client)
    resp = await client.post(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers={**get_headers(), "Prefer": "return=representation"},
        json={
            "name": f"VPS-{platform.node()}",
            "api_key": VPS_API_KEY,
            "ip_address": ip,
            "status": "online"
        }
    )
    
    if resp.status_code == 201:
        vps_id = resp.json()[0]["id"]
        print(f"[VPS] Registered new VPS: {vps_id[:8]}...")
        return vps_id
    
    print(f"[ERROR] Failed to register VPS: {resp.text}")
    return None


async def get_public_ip(client: httpx.AsyncClient) -> str:
    try:
        resp = await client.get("https://api.ipify.org?format=text", timeout=5)
        return resp.text.strip()
    except:
        return "unknown"


async def send_heartbeat(client: httpx.AsyncClient):
    """Update VPS status in database."""
    if not vps_id:
        return
    
    await client.patch(
        f"{SUPABASE_URL}/rest/v1/vps_connections",
        headers=get_headers(),
        params={"id": f"eq.{vps_id}"},
        json={
            "status": "online",
            "last_seen": datetime.now(timezone.utc).isoformat(),
        }
    )


async def send_log(client: httpx.AsyncClient, runner: str, level: str, message: str):
    """Send a log entry to the database."""
    if not vps_id:
        return
    
    await client.post(
        f"{SUPABASE_URL}/rest/v1/vps_logs",
        headers=get_headers(),
        json={
            "vps_id": vps_id,
            "runner_name": runner,
            "log_level": level,
            "message": message[:500],  # Limit message length
        }
    )


async def poll_commands(client: httpx.AsyncClient) -> list:
    """Get pending commands from database."""
    if not vps_id:
        return []
    
    resp = await client.get(
        f"{SUPABASE_URL}/rest/v1/vps_commands",
        headers=get_headers(),
        params={
            "vps_id": f"eq.{vps_id}",
            "status": "eq.pending",
            "order": "created_at.asc",
            "limit": "10"
        }
    )
    
    if resp.status_code == 200:
        return resp.json()
    return []


async def update_command(client: httpx.AsyncClient, cmd_id: str, status: str, result: str = None):
    """Update command status in database."""
    await client.patch(
        f"{SUPABASE_URL}/rest/v1/vps_commands",
        headers=get_headers(),
        params={"id": f"eq.{cmd_id}"},
        json={
            "status": status,
            "result": result,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
    )


async def start_runner(name: str, client: httpx.AsyncClient = None, fetch_first: bool = False) -> bool:
    """Start a specific runner process."""
    # Optionally fetch latest scripts before starting
    if fetch_first and client:
        await update_scripts(client, restart_after=False)
    
    if name in processes and processes[name].poll() is None:
        print(f"[RUNNER] {name} already running")
        return False
    
    script = RUNNERS.get(name)
    if not script:
        print(f"[ERROR] Unknown runner: {name}")
        return False
    
    # Use absolute path from script directory
    script_path = os.path.join(SCRIPT_DIR, script)
    if not os.path.exists(script_path):
        print(f"[ERROR] Script not found: {script_path}")
        return False
    
    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", script_path],  # -u for unbuffered output
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=SCRIPT_DIR,
            bufsize=1,
            universal_newlines=True,
        )
        processes[name] = proc
        print(f"[RUNNER] Started {name} (PID: {proc.pid})")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to start {name}: {e}")
        return False


def stop_runner(name: str) -> bool:
    """Stop a specific runner process."""
    if name not in processes:
        return False
    
    proc = processes[name]
    if proc.poll() is not None:
        del processes[name]
        return False
    
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    
    del processes[name]
    print(f"[RUNNER] Stopped {name}")
    return True


async def start_all(client: httpx.AsyncClient = None, fetch_first: bool = True):
    """Start all runners."""
    # Fetch latest scripts before starting all
    if fetch_first and client:
        await update_scripts(client, restart_after=False)
    
    results = []
    for name in RUNNERS:
        if await start_runner(name, client, fetch_first=False):
            results.append(name)
    return results


def stop_all():
    """Stop all runners."""
    results = []
    for name in list(processes.keys()):
        if stop_runner(name):
            results.append(name)
    return results


async def restart_all(client: httpx.AsyncClient = None):
    """Restart all runners."""
    stop_all()
    return await start_all(client, fetch_first=True)


async def update_scripts(client: httpx.AsyncClient, restart_after: bool = False) -> bool:
    """Download latest scripts from Supabase storage."""
    try:
        # Download ZIP from storage
        resp = await client.get(
            f"{SUPABASE_URL}/storage/v1/object/public/python-scripts/runners.zip",
            timeout=60
        )
        
        if resp.status_code != 200:
            print(f"[UPDATE] No update package found (status: {resp.status_code})")
            return False
        
        # Stop all runners first
        stop_all()
        
        # Extract ZIP to script directory
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            for info in zf.infolist():
                if info.filename.endswith('.py') and not info.filename.startswith('__'):
                    with zf.open(info) as source:
                        # Get just the filename, extract to SCRIPT_DIR
                        filename = os.path.basename(info.filename)
                        # Don't overwrite vps_agent.py or config.py
                        if filename in ['vps_agent.py', 'config.py']:
                            continue
                        target_path = os.path.join(SCRIPT_DIR, filename)
                        with open(target_path, 'wb') as target:
                            target.write(source.read())
                        print(f"[UPDATE] Extracted: {filename}")
        
        print("[UPDATE] Scripts updated successfully")
        
        if restart_after:
            await start_all(client, fetch_first=False)
        
        return True
        
    except Exception as e:
        print(f"[ERROR] Update failed: {e}")
        return False


async def process_command(client: httpx.AsyncClient, cmd: dict):
    """Process a single command."""
    cmd_id = cmd["id"]
    command = cmd["command"]
    target = cmd.get("target_runner")
    
    print(f"[CMD] Processing: {command}" + (f" ({target})" if target else ""))
    
    await update_command(client, cmd_id, "processing")
    
    try:
        result = ""
        
        if command == "start_all":
            started = await start_all(client, fetch_first=True)
            result = f"Started: {', '.join(started) if started else 'none'}"
            
        elif command == "stop_all":
            stopped = stop_all()
            result = f"Stopped: {', '.join(stopped) if stopped else 'none'}"
            
        elif command == "restart_all":
            restarted = await restart_all(client)
            result = f"Restarted: {', '.join(restarted) if restarted else 'none'}"
            
        elif command == "start_runner" and target:
            # Fetch latest scripts before starting single runner too
            if await start_runner(target, client, fetch_first=True):
                result = f"Started {target}"
            else:
                result = f"Failed to start {target}"
                
        elif command == "stop_runner" and target:
            if stop_runner(target):
                result = f"Stopped {target}"
            else:
                result = f"{target} was not running"
                
        elif command == "update":
            if await update_scripts(client, restart_after=True):
                result = "Scripts updated and restarted"
            else:
                result = "No updates available"
        else:
            result = f"Unknown command: {command}"
        
        await update_command(client, cmd_id, "completed", result)
        await send_log(client, "agent", "info", f"Command: {command} -> {result}")
        
    except Exception as e:
        error = str(e)[:200]
        await update_command(client, cmd_id, "failed", error)
        await send_log(client, "agent", "error", f"Command failed: {command} - {error}")


async def monitor_processes(client: httpx.AsyncClient):
    """Monitor runner processes, capture output, and restart if crashed."""
    for name, proc in list(processes.items()):
        # Read available output lines (non-blocking)
        try:
            if proc.stdout:
                import select
                # Check if there's data to read (works on Unix)
                if hasattr(select, 'select'):
                    readable, _, _ = select.select([proc.stdout], [], [], 0)
                    if readable:
                        line = proc.stdout.readline()
                        if line:
                            line = line.strip()
                            # Determine log level from content
                            level = "info"
                            if "[ERROR]" in line or "error" in line.lower():
                                level = "error"
                            elif "[WARNING]" in line or "warning" in line.lower():
                                level = "warning"
                            await send_log(client, name, level, f"[PID:{proc.pid}] {line}")
                else:
                    # Windows fallback - try readline with short timeout
                    line = proc.stdout.readline()
                    if line:
                        line = line.strip()
                        level = "info"
                        if "[ERROR]" in line or "error" in line.lower():
                            level = "error"
                        elif "[WARNING]" in line or "warning" in line.lower():
                            level = "warning"
                        await send_log(client, name, level, f"[PID:{proc.pid}] {line}")
        except Exception as e:
            pass  # Ignore read errors
        
        if proc.poll() is not None:
            # Process has exited
            exit_code = proc.returncode
            await send_log(client, name, "warning", f"[PID:{proc.pid}] Process exited with code {exit_code}, restarting...")
            del processes[name]
            # Auto-restart
            await start_runner(name, client, fetch_first=False)


async def main_loop():
    """Main agent loop."""
    global RUNNING
    
    print("=" * 50)
    print("  TelegramCRM VPS Agent")
    print("=" * 50)
    
    async with httpx.AsyncClient() as client:
        # Register VPS
        if not await register_vps(client):
            print("[FATAL] Could not register VPS")
            return
        
        await send_log(client, "agent", "info", "VPS Agent started")
        
        last_heartbeat = 0
        
        while RUNNING:
            try:
                now = asyncio.get_event_loop().time()
                
                # Send heartbeat
                if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                    await send_heartbeat(client)
                    last_heartbeat = now
                
                # Poll for commands
                commands = await poll_commands(client)
                for cmd in commands:
                    await process_command(client, cmd)
                
                # Monitor processes
                await monitor_processes(client)
                
                await asyncio.sleep(POLL_INTERVAL)
                
            except Exception as e:
                print(f"[ERROR] Main loop: {e}")
                await asyncio.sleep(5)
        
        # Cleanup
        print("[VPS] Shutting down...")
        stop_all()
        await send_log(client, "agent", "info", "VPS Agent stopped")


def signal_handler(sig, frame):
    global RUNNING
    print("\n[VPS] Received shutdown signal")
    RUNNING = False


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    asyncio.run(main_loop())
