import React, { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { 
  TelegramAccount, 
  Proxy, 
  Conversation, 
  Message, 
  Campaign, 
  DashboardStats,
  UploadProgress 
} from '@/types/telegram';

// Generate mock data
const generateMockAccounts = (count: number): TelegramAccount[] => {
  const statuses: TelegramAccount['status'][] = ['active', 'active', 'active', 'banned', 'restricted', 'disconnected', 'cooldown'];
  
  return Array.from({ length: count }, (_, i) => ({
    id: `acc-${i + 1}`,
    phoneNumber: `+1${Math.floor(1000000000 + Math.random() * 9000000000)}`,
    username: Math.random() > 0.3 ? `user_${i + 1}` : undefined,
    firstName: ['Alex', 'Jordan', 'Morgan', 'Taylor', 'Casey', 'Riley', 'Quinn', 'Avery'][i % 8],
    lastName: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'][i % 8],
    status: statuses[Math.floor(Math.random() * statuses.length)],
    proxyId: Math.random() > 0.2 ? `proxy-${Math.floor(Math.random() * 50) + 1}` : undefined,
    createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
    lastActive: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000),
    messagesSentToday: Math.floor(Math.random() * 20),
    dailyLimit: 25,
    maturityScore: Math.floor(Math.random() * 100),
    maturityDays: Math.floor(Math.random() * 30),
    restrictedUntil: Math.random() > 0.8 ? new Date(Date.now() + 24 * 60 * 60 * 1000) : undefined,
  }));
};

const generateMockProxies = (count: number): Proxy[] => {
  const types: Proxy['type'][] = ['http', 'https', 'socks4', 'socks5'];
  const countries = ['US', 'UK', 'DE', 'NL', 'FR', 'CA', 'AU', 'JP'];
  
  return Array.from({ length: count }, (_, i) => ({
    id: `proxy-${i + 1}`,
    host: `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
    port: [8080, 3128, 1080, 9050, 8888][Math.floor(Math.random() * 5)],
    username: Math.random() > 0.5 ? `user_${i}` : undefined,
    password: Math.random() > 0.5 ? '********' : undefined,
    type: types[Math.floor(Math.random() * types.length)],
    status: ['active', 'active', 'active', 'inactive', 'error'][Math.floor(Math.random() * 5)] as Proxy['status'],
    lastChecked: new Date(Date.now() - Math.random() * 60 * 60 * 1000),
    responseTime: Math.floor(Math.random() * 500) + 50,
    country: countries[Math.floor(Math.random() * countries.length)],
  }));
};

const generateMockConversations = (accounts: TelegramAccount[]): Conversation[] => {
  const names = ['John Doe', 'Jane Smith', 'Mike Wilson', 'Sarah Connor', 'Tom Hardy', 'Emma Watson'];
  
  return Array.from({ length: 50 }, (_, i) => ({
    id: `conv-${i + 1}`,
    accountId: accounts[Math.floor(Math.random() * accounts.length)]?.id || 'acc-1',
    recipientPhone: `+1${Math.floor(1000000000 + Math.random() * 9000000000)}`,
    recipientName: names[Math.floor(Math.random() * names.length)],
    unreadCount: Math.floor(Math.random() * 5),
    isActive: Math.random() > 0.3,
    createdAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000),
  }));
};

interface TelegramContextType {
  accounts: TelegramAccount[];
  proxies: Proxy[];
  conversations: Conversation[];
  messages: Message[];
  campaigns: Campaign[];
  stats: DashboardStats;
  uploadProgress: UploadProgress;
  
  // Account actions
  addAccount: (account: Partial<TelegramAccount>) => void;
  updateAccount: (id: string, updates: Partial<TelegramAccount>) => void;
  deleteAccount: (id: string) => void;
  uploadAccounts: (files: File[]) => Promise<void>;
  
  // Proxy actions
  addProxy: (proxy: Partial<Proxy>) => void;
  addProxiesBulk: (proxies: string) => void;
  updateProxy: (id: string, updates: Partial<Proxy>) => void;
  deleteProxy: (id: string) => void;
  assignProxy: (accountId: string, proxyId: string) => void;
  
  // Message actions
  sendMessage: (accountId: string, recipientPhone: string, content: string) => void;
  getConversationMessages: (conversationId: string) => Message[];
  
  // Campaign actions
  createCampaign: (campaign: Partial<Campaign>) => void;
  updateCampaign: (id: string, updates: Partial<Campaign>) => void;
  
  // Refresh
  refreshStats: () => void;
}

const TelegramContext = createContext<TelegramContextType | undefined>(undefined);

export const TelegramProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [accounts, setAccounts] = useState<TelegramAccount[]>(() => generateMockAccounts(150));
  const [proxies, setProxies] = useState<Proxy[]>(() => generateMockProxies(80));
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    total: 0,
    processed: 0,
    successful: 0,
    failed: 0,
    status: 'idle',
    errors: []
  });

  // Initialize conversations after accounts
  useState(() => {
    setConversations(generateMockConversations(accounts));
  });

  const stats: DashboardStats = {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter(a => a.status === 'active').length,
    bannedAccounts: accounts.filter(a => a.status === 'banned').length,
    restrictedAccounts: accounts.filter(a => a.status === 'restricted' || a.status === 'cooldown').length,
    totalProxies: proxies.length,
    activeProxies: proxies.filter(p => p.status === 'active').length,
    messagesToday: accounts.reduce((sum, a) => sum + a.messagesSentToday, 0),
    repliesReceived: conversations.filter(c => c.unreadCount > 0).length,
    campaignsRunning: campaigns.filter(c => c.status === 'running').length,
  };

  const addAccount = useCallback((account: Partial<TelegramAccount>) => {
    const newAccount: TelegramAccount = {
      id: `acc-${Date.now()}`,
      phoneNumber: account.phoneNumber || '',
      status: 'active',
      createdAt: new Date(),
      messagesSentToday: 0,
      dailyLimit: 25,
      maturityScore: 0,
      maturityDays: 0,
      ...account
    };
    setAccounts(prev => [...prev, newAccount]);
  }, []);

  const updateAccount = useCallback((id: string, updates: Partial<TelegramAccount>) => {
    setAccounts(prev => prev.map(acc => 
      acc.id === id ? { ...acc, ...updates } : acc
    ));
  }, []);

  const deleteAccount = useCallback((id: string) => {
    setAccounts(prev => prev.filter(acc => acc.id !== id));
  }, []);

  const uploadAccounts = useCallback(async (files: File[]) => {
    setUploadProgress({
      total: files.length * 50, // Assume ~50 accounts per file
      processed: 0,
      successful: 0,
      failed: 0,
      status: 'uploading',
      errors: []
    });

    // Simulate upload processing
    for (let i = 0; i < 150; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const success = Math.random() > 0.05;
      
      setUploadProgress(prev => ({
        ...prev,
        processed: i + 1,
        successful: prev.successful + (success ? 1 : 0),
        failed: prev.failed + (success ? 0 : 1),
        status: i === 149 ? 'completed' : 'processing',
        errors: success ? prev.errors : [...prev.errors, `Account ${i + 1}: Invalid session file`]
      }));
    }
  }, []);

  const addProxy = useCallback((proxy: Partial<Proxy>) => {
    const newProxy: Proxy = {
      id: `proxy-${Date.now()}`,
      host: proxy.host || '',
      port: proxy.port || 8080,
      type: proxy.type || 'http',
      status: 'active',
      lastChecked: new Date(),
      ...proxy
    };
    setProxies(prev => [...prev, newProxy]);
  }, []);

  const addProxiesBulk = useCallback((proxyText: string) => {
    const lines = proxyText.split('\n').filter(l => l.trim());
    const newProxies: Proxy[] = lines.map((line, i) => {
      const parts = line.split(':');
      return {
        id: `proxy-${Date.now()}-${i}`,
        host: parts[0] || '',
        port: parseInt(parts[1]) || 8080,
        username: parts[2],
        password: parts[3],
        type: 'http' as const,
        status: 'active' as const,
        lastChecked: new Date(),
      };
    });
    setProxies(prev => [...prev, ...newProxies]);
  }, []);

  const updateProxy = useCallback((id: string, updates: Partial<Proxy>) => {
    setProxies(prev => prev.map(p => 
      p.id === id ? { ...p, ...updates } : p
    ));
  }, []);

  const deleteProxy = useCallback((id: string) => {
    setProxies(prev => prev.filter(p => p.id !== id));
  }, []);

  const assignProxy = useCallback((accountId: string, proxyId: string) => {
    setAccounts(prev => prev.map(acc => 
      acc.id === accountId ? { ...acc, proxyId } : acc
    ));
    setProxies(prev => prev.map(p => 
      p.id === proxyId ? { ...p, assignedAccountId: accountId } : p
    ));
  }, []);

  const sendMessage = useCallback((accountId: string, recipientPhone: string, content: string) => {
    const newMessage: Message = {
      id: `msg-${Date.now()}`,
      accountId,
      recipientId: recipientPhone,
      recipientPhone,
      content,
      direction: 'outgoing',
      status: 'sent',
      timestamp: new Date(),
      threadId: `thread-${recipientPhone}`
    };
    setMessages(prev => [...prev, newMessage]);
    
    // Update conversation
    setConversations(prev => {
      const existing = prev.find(c => c.recipientPhone === recipientPhone);
      if (existing) {
        return prev.map(c => 
          c.recipientPhone === recipientPhone 
            ? { ...c, lastMessage: newMessage, updatedAt: new Date() }
            : c
        );
      }
      return [...prev, {
        id: `conv-${Date.now()}`,
        accountId,
        recipientPhone,
        lastMessage: newMessage,
        unreadCount: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }];
    });
  }, []);

  const getConversationMessages = useCallback((conversationId: string) => {
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv) return [];
    return messages.filter(m => m.recipientPhone === conv.recipientPhone);
  }, [conversations, messages]);

  const createCampaign = useCallback((campaign: Partial<Campaign>) => {
    const newCampaign: Campaign = {
      id: `campaign-${Date.now()}`,
      name: campaign.name || 'New Campaign',
      messageTemplate: campaign.messageTemplate || '',
      status: 'draft',
      recipientCount: campaign.recipientCount || 0,
      sentCount: 0,
      failedCount: 0,
      replyCount: 0,
      accountIds: campaign.accountIds || [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...campaign
    };
    setCampaigns(prev => [...prev, newCampaign]);
  }, []);

  const updateCampaign = useCallback((id: string, updates: Partial<Campaign>) => {
    setCampaigns(prev => prev.map(c => 
      c.id === id ? { ...c, ...updates, updatedAt: new Date() } : c
    ));
  }, []);

  const refreshStats = useCallback(() => {
    // Trigger re-render with updated stats
  }, []);

  const value: TelegramContextType = {
    accounts,
    proxies,
    conversations,
    messages,
    campaigns,
    stats,
    uploadProgress,
    addAccount,
    updateAccount,
    deleteAccount,
    uploadAccounts,
    addProxy,
    addProxiesBulk,
    updateProxy,
    deleteProxy,
    assignProxy,
    sendMessage,
    getConversationMessages,
    createCampaign,
    updateCampaign,
    refreshStats
  };

  return (
    <TelegramContext.Provider value={value}>
      {children}
    </TelegramContext.Provider>
  );
};

export const useTelegram = (): TelegramContextType => {
  const context = useContext(TelegramContext);
  if (!context) {
    throw new Error('useTelegram must be used within a TelegramProvider');
  }
  return context;
};
