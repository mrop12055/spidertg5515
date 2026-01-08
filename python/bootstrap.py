"""
TelegramCRM - Bootstrap Launcher
Downloads latest Python files from cloud and runs all runners
"""

import os
import sys
import subprocess
import urllib.request
import json

SUPABASE_URL = "https://ismtbdcnbxyyvsacbeld.supabase.co"
STORAGE_BUCKET = "python-scripts"

PYTHON_FILES = [
    "config.py",
    "requirements.txt",
    "account_manager.py",
    "campaign_runner.py", 
    "client_manager.py",
    "fingerprint_generator.py",
    "live_chat_listener.py",
    "warmup_runner.py",
]

def download_file(filename: str, dest_folder: str = ".") -> bool:
    """Download a file from Supabase storage"""
    url = f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{filename}"
    dest_path = os.path.join(dest_folder, filename)
    
    try:
        print(f"  Downloading {filename}...", end=" ")
        urllib.request.urlretrieve(url, dest_path)
        print("OK")
        return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False

def install_requirements():
    """Install Python requirements"""
    print("\n[2/3] Installing requirements...")
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-r", "requirements.txt", "-q"],
            check=True,
            capture_output=True
        )
        print("  Done!")
    except subprocess.CalledProcessError as e:
        print(f"  Warning: {e}")

def run_all_runners():
    """Start all runner scripts in separate processes"""
    print("\n[3/3] Starting runners...\n")
    
    runners = [
        ("Campaign Runner", "campaign_runner.py"),
        ("LiveChat Listener", "live_chat_listener.py"),
        ("Account Manager", "account_manager.py"),
        ("Warmup Runner", "warmup_runner.py"),
    ]
    
    processes = []
    for name, script in runners:
        if os.path.exists(script):
            print(f"  Starting {name}...")
            if sys.platform == "win32":
                # Windows: open in new window
                proc = subprocess.Popen(
                    ["start", "cmd", "/k", f"title {name} && py {script}"],
                    shell=True
                )
            else:
                # Linux/Mac: run in background
                proc = subprocess.Popen(
                    [sys.executable, script],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
            processes.append((name, proc))
        else:
            print(f"  Skipping {name} (not found)")
    
    print("\n" + "=" * 50)
    print("  All runners started!")
    print("=" * 50)
    print("\nPress Ctrl+C to stop this launcher")
    print("(Runners will continue in their own windows)\n")
    
    return processes

def main():
    print("\n" + "=" * 50)
    print("    TelegramCRM - Bootstrap Launcher")
    print("=" * 50)
    
    # Step 1: Download latest files
    print("\n[1/3] Downloading latest files from cloud...")
    
    success_count = 0
    for filename in PYTHON_FILES:
        if download_file(filename):
            success_count += 1
    
    print(f"\n  Downloaded {success_count}/{len(PYTHON_FILES)} files")
    
    if success_count == 0:
        print("\nERROR: No files downloaded. Check your internet connection.")
        print("Or upload files first using the dashboard.")
        input("\nPress Enter to exit...")
        return
    
    # Step 2: Install requirements
    install_requirements()
    
    # Step 3: Run all runners
    processes = run_all_runners()
    
    # Keep running
    try:
        while True:
            input()
    except KeyboardInterrupt:
        print("\nShutting down...")

if __name__ == "__main__":
    main()
