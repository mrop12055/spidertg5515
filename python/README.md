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
main_runner.py       - Main runner (handles everything)
client_manager.py    - Telegram client management
requirements.txt     - Python dependencies
```

## Features

- **Campaigns** - Sends bulk messages with pacing
- **Live Chat** - Receives replies from campaign contacts only
- **Accounts** - SpamBot checks, name changes, privacy settings
- **Warmup** - Channel joins, content viewing

## Important

- Only messages from campaign contacts are received
- Messages from random people are filtered out
- All accounts use their assigned proxies

## Stop

Press `Ctrl+C` in the terminal window
