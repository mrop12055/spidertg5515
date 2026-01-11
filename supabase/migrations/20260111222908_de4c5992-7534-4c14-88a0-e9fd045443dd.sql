-- Performance indexes for high-volume queries (20K+ accounts scale)

-- ============================================
-- TELEGRAM_ACCOUNTS indexes
-- ============================================
-- Status filtering (Active/Restricted/Inactive tabs)
CREATE INDEX IF NOT EXISTS idx_accounts_status ON telegram_accounts(status);

-- Proxy assignment lookups
CREATE INDEX IF NOT EXISTS idx_accounts_proxy_id ON telegram_accounts(proxy_id);

-- API credential grouping
CREATE INDEX IF NOT EXISTS idx_accounts_api_credential_id ON telegram_accounts(api_credential_id);

-- Created at for ordering
CREATE INDEX IF NOT EXISTS idx_accounts_created_at ON telegram_accounts(created_at DESC);

-- Composite index for active accounts with proxy (common filter)
CREATE INDEX IF NOT EXISTS idx_accounts_status_proxy ON telegram_accounts(status, proxy_id) WHERE status = 'active';

-- Warmup pair lookups
CREATE INDEX IF NOT EXISTS idx_accounts_warmup_pair ON telegram_accounts(warmup_pair_id) WHERE warmup_pair_id IS NOT NULL;

-- ============================================
-- CONVERSATIONS indexes
-- ============================================
-- Account-based conversation lookup
CREATE INDEX IF NOT EXISTS idx_conversations_account_id ON conversations(account_id);

-- Seat-based filtering (for SeatChat)
CREATE INDEX IF NOT EXISTS idx_conversations_seat_id ON conversations(seat_id) WHERE seat_id IS NOT NULL;

-- First message sent filter (outbound conversations)
CREATE INDEX IF NOT EXISTS idx_conversations_first_message ON conversations(first_message_sent) WHERE first_message_sent = true;

-- Has reply filter
CREATE INDEX IF NOT EXISTS idx_conversations_has_reply ON conversations(has_reply) WHERE has_reply = true;

-- Last message ordering
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at DESC) WHERE last_message_at IS NOT NULL;

-- Composite for common query: outbound conversations with activity
CREATE INDEX IF NOT EXISTS idx_conversations_outbound_active ON conversations(account_id, last_message_at DESC) 
  WHERE first_message_sent = true AND last_message_at IS NOT NULL;

-- ============================================
-- MESSAGES indexes
-- ============================================
-- Conversation-based message lookup
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

-- Account-based message lookup
CREATE INDEX IF NOT EXISTS idx_messages_account_id ON messages(account_id);

-- Direction filtering (incoming/outgoing)
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);

-- Status filtering (pending/sent/failed)
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

-- Created at for time-based queries
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

-- Composite for pending messages (task queue)
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(status, priority DESC, created_at) 
  WHERE status = 'pending';

-- Campaign recipient lookup
CREATE INDEX IF NOT EXISTS idx_messages_campaign_recipient ON messages(campaign_recipient_id) 
  WHERE campaign_recipient_id IS NOT NULL;

-- ============================================
-- PROXIES indexes
-- ============================================
-- Status filtering
CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);

-- Assigned account lookup
CREATE INDEX IF NOT EXISTS idx_proxies_assigned ON proxies(assigned_account_id) WHERE assigned_account_id IS NOT NULL;

-- ============================================
-- CAMPAIGN_RECIPIENTS indexes
-- ============================================
-- Campaign-based lookup
CREATE INDEX IF NOT EXISTS idx_recipients_campaign_id ON campaign_recipients(campaign_id);

-- Status filtering (pending/sent/failed)
CREATE INDEX IF NOT EXISTS idx_recipients_status ON campaign_recipients(status);

-- Seat-based filtering
CREATE INDEX IF NOT EXISTS idx_recipients_seat_id ON campaign_recipients(seat_id) WHERE seat_id IS NOT NULL;

-- Composite for pending recipients in campaign
CREATE INDEX IF NOT EXISTS idx_recipients_pending ON campaign_recipients(campaign_id, status) 
  WHERE status = 'pending';

-- Sent by account (for daily limit tracking)
CREATE INDEX IF NOT EXISTS idx_recipients_sent_by ON campaign_recipients(sent_by_account_id) 
  WHERE sent_by_account_id IS NOT NULL;