# TelegramCRM Python Scripts

## Quick Start

1. Install Python 3.8+
2. Double-click `INSTALL.bat` to install dependencies
3. Edit `config.py` with your Supabase credentials
4. Double-click `RUN.bat` to start

## Files

```
RUN.bat              - Start the runner (double-click)
INSTALL.bat          - Install dependencies (run once)
config.py            - Your Supabase credentials (edit this)
master_runner.py     - UNIFIED runner (handles ALL tasks)
fingerprint_generator.py - Device fingerprint generation
requirements.txt     - Python dependencies
```

## Master Runner Features

The `master_runner.py` is a **UNIFIED** runner that handles everything:

- **Campaigns** - Sends bulk messages with pacing
- **Live Chat** - Receives replies from contacts
- **Warmup** - Channel joins, reactions, paired messaging
- **Account Management** - SpamBot checks, name/photo changes, privacy

### Benefits:
- **Single session per account** - connects once, reuses connection
- **Faster** - no reconnection overhead between task types
- **Efficient** - shared client pool across all features
- **Parallel processing** - batch tasks run concurrently

## Important

- Only messages from contacts are received
- Messages from random people are filtered out
- All accounts use their assigned proxies
- Connections are kept alive automatically

## Stop

Press `Ctrl+C` in the terminal window
