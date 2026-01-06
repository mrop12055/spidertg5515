# TelegramCRM Python Scripts

## Quick Start

1. Install Python 3.8+
2. Double-click `INSTALL.bat` to install dependencies
3. Edit `config.py` with your Supabase credentials
4. Double-click `RUN.bat` to start

## Files

```
RUN.bat              - Start the unified runner (recommended)
INSTALL.bat          - Install dependencies (run once)
config.py            - Your Supabase credentials (edit this)
unified_runner.py    - UNIFIED RUNNER (handles everything)
client_manager.py    - Telegram client management
requirements.txt     - Python dependencies
```

### Legacy Runners (optional, for advanced use)

```
live_chat_listener.py - Only livechat (incoming/replies)
campaign_runner.py    - Only campaign messages
account_manager.py    - Only account management
warmup_runner.py      - Only warmup tasks
```

⚠️ **Warning**: Running multiple legacy runners simultaneously can cause SQLite "database locked" errors. Use `unified_runner.py` instead.

## Unified Runner Benefits

✅ **NO session file conflicts** - One process = one client per account
✅ **Shared client pool** - Already-connected clients are reused
✅ **Simpler to run** - Just one script handles everything
✅ **Same performance** - asyncio handles all tasks concurrently

## Features

- **Live Chat** - Receives messages from campaign contacts, sends replies
- **Campaigns** - Sends bulk messages with pacing and parallel execution
- **Account Management** - SpamBot checks, sync profile, name changes, privacy
- **Warmup** - Pair chat, channel joins, reactions

## Important

- Only messages from campaign contacts are received
- Messages from random people are filtered out
- All accounts use their assigned proxies
- Connected clients are reused for all operations

## Stop

Press `Ctrl+C` in the terminal window