// Account status types
export type AccountStatus = 'active' | 'banned' | 'restricted' | 'disconnected' | 'cooldown';

export interface TelegramAccount {
  id: string;
  phoneNumber: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  status: AccountStatus;
  proxyId?: string;
  sessionFile?: string;
  createdAt: Date;
  lastActive?: Date;
  messagesSentToday: number;
  dailyLimit: number;
  maturityScore: number; // 0-100
  maturityDays: number;
  restrictedUntil?: Date;
  banReason?: string;
  avatar?: string;
  // Device fingerprint
  deviceModel?: string;
  systemVersion?: string;
  appVersion?: string;
  langCode?: string;
  systemLangCode?: string;
  // Anti-ban features
  warmupPhase?: number; // 0-4 (0 = new, 4 = fully warmed)
  warmupStartedAt?: Date;
  spambotStatus?: 'unknown' | 'clean' | 'limited' | 'restricted';
  phoneCountry?: string;
  geoMismatch?: boolean;
  apiCredentialId?: string;
}

export interface Proxy {
  id: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  type: 'http' | 'https' | 'socks4' | 'socks5';
  status: 'active' | 'inactive' | 'error';
  assignedAccountId?: string;
  lastChecked?: Date;
  responseTime?: number;
  country?: string;
}

export interface Message {
  id: string;
  accountId: string;
  conversationId: string;
  recipientId?: string;
  recipientPhone: string;
  recipientName?: string;
  content: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  threadId?: string;
  telegramMessageId?: number;
  failedReason?: string;
  mediaUrl?: string;
  mediaType?: string;
  campaignRecipientId?: string; // If set, this message was sent via a campaign
}

export interface Conversation {
  id: string;
  accountId: string;
  recipientPhone: string;
  recipientName?: string;
  recipientAvatar?: string;
  lastMessage?: Message;
  unreadCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  blockedByRecipient?: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  messageTemplate: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed';
  scheduledAt?: Date;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  replyCount: number;
  accountIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Admin {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin';
  status: 'active' | 'suspended';
  createdAt: Date;
  lastLogin?: Date;
  accountsManaged: number;
}

export interface MaturationTask {
  id: string;
  accountId: string;
  type: 'join_channel' | 'send_message' | 'view_content' | 'add_contact' | 'profile_update';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  scheduledAt: Date;
  completedAt?: Date;
  description: string;
}

export interface DashboardStats {
  totalAccounts: number;
  activeAccounts: number;
  bannedAccounts: number;
  restrictedAccounts: number;
  totalProxies: number;
  activeProxies: number;
  messagesToday: number;
  repliesReceived: number;
  campaignsRunning: number;
}

export interface UploadProgress {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  status: 'idle' | 'uploading' | 'processing' | 'completed' | 'error';
  errors: string[];
}
