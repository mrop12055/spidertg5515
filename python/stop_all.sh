#!/bin/bash
echo "============================================"
echo "  Stopping All TelegramCRM Processes"
echo "============================================"
echo ""

# Kill all Python processes running our scripts
pkill -f "live_chat_listener.py" 2>/dev/null
pkill -f "campaign_runner.py" 2>/dev/null
pkill -f "account_manager.py" 2>/dev/null
pkill -f "main_runner.py" 2>/dev/null

echo "All TelegramCRM processes stopped."
