"""
TelegramCRM - Shared Configuration
===================================
All shared settings for Python runners
"""

# Backend Configuration
BACKEND_URL = "https://ismtbdcnbxyyvsacbeld.supabase.co/functions/v1"
# Base project URL (used for REST + Storage endpoints)
SUPABASE_URL = BACKEND_URL.split("/functions/v1")[0]

# API key used by runners for backend + storage calls
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzbXRiZGNuYnh5eXZzYWNiZWxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxMjM5NzksImV4cCI6MjA4MjY5OTk3OX0.j0PjzGtgTtyhRvuG_IqsCHzrNBB_tni67q2_3SVXwL0"

# Telegram API credentials
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"

