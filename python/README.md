# TelegramCRM - Python Scripts

## FIRST TIME SETUP

1. Make sure Python 3.8+ is installed
2. Double-click `INSTALL_REQUIREMENTS.bat` (Windows) or run:
   ```bash
   pip install -r requirements.txt
   ```

## RUNNING THE BOT

### Option 1: Run ALL tasks at once
Double-click: `RUN_TELEGRAM_CRM.bat`

### Option 2: Run specific runners (recommended)
- `RUN_CAMPAIGN.bat` - Send campaigns
- `RUN_LIVECHAT.bat` - Listen for messages  
- `RUN_WARMUP.bat` - Mature new accounts
- `RUN_ACCOUNT.bat` - Account management

## STOPPING
Press `Ctrl+C` in the terminal window, or close the window.

## FILES

| File | Description |
|------|-------------|
| `config.py` | Configuration settings |
| `client_manager.py` | Shared Telegram client logic |
| `campaign_runner.py` | Campaign sending |
| `live_chat_listener.py` | Incoming messages |
| `account_manager.py` | Account tasks |
| `warmup_runner.py` | New account warmup |
| `main_runner.py` | All-in-one runner |

## RECOMMENDED SETUP

- Keep `RUN_LIVECHAT.bat` always running for live chat
- Run `RUN_CAMPAIGN.bat` only when sending campaigns

## UPDATING

When code is updated, just run:
```bash
git pull
```
That's it! New code automatically downloaded.

## For support, visit your TelegramCRM dashboard.
