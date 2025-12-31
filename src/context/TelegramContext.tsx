import React, { createContext, useContext, useState, ReactNode, useCallback, useEffect } from 'react';
import { 
  TelegramAccount, 
  Proxy, 
  Conversation, 
  Message, 
  Campaign, 
  DashboardStats,
  UploadProgress 
} from '@/types/telegram';

// Minimal mock data - just 2 examples
const initialAccounts: TelegramAccount[] = [
  {
    id: 'acc-1',
    phoneNumber: '+14155551234',
    username: 'alex_demo',
    firstName: 'Alex',
    lastName: 'Johnson',
    status: 'active',
    proxyId: 'proxy-1',
    createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
    lastActive: new Date(),
    messagesSentToday: 5,
    dailyLimit: 25,
    maturityScore: 75,
    maturityDays: 15,
  },
  {
    id: 'acc-2',
    phoneNumber: '+14155559876',
    username: 'jordan_test',
    firstName: 'Jordan',
    lastName: 'Smith',
    status: 'restricted',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    lastActive: new Date(Date.now() - 2 * 60 * 60 * 1000),
    messagesSentToday: 12,
    dailyLimit: 25,
    maturityScore: 30,
    maturityDays: 5,
    restrictedUntil: new Date(Date.now() + 20 * 60 * 60 * 1000),
  }
];

const initialProxies: Proxy[] = [
  {
    id: 'proxy-1',
    host: '192.168.1.100',
    port: 8080,
    username: 'proxyuser',
    password: '********',
    type: 'socks5',
    status: 'active',
    assignedAccountId: 'acc-1',
    lastChecked: new Date(),
    responseTime: 120,
    country: 'US',
  },
  {
    id: 'proxy-2',
    host: '10.0.0.50',
    port: 1080,
    type: 'http',
    status: 'active',
    lastChecked: new Date(),
    responseTime: 85,
    country: 'DE',
  }
];

const initialConversations: Conversation[] = [
  {
    id: 'conv-1',
    accountId: 'acc-1',
    recipientPhone: '+14155550001',
    recipientName: 'John Doe',
    unreadCount: 2,
    isActive: true,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
  },
  {
    id: 'conv-2',
    accountId: 'acc-1',
    recipientPhone: '+14155550002',
    recipientName: 'Jane Smith',
    unreadCount: 0,
    isActive: false,
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  }
];

const initialMessages: Message[] = [
  {
    id: 'msg-1',
    accountId: 'acc-1',
    recipientId: '+14155550001',
    recipientPhone: '+14155550001',
    recipientName: 'John Doe',
    content: 'Hi! I wanted to reach out about our services.',
    direction: 'outgoing',
    status: 'read',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
    threadId: 'thread-1',
  },
  {
    id: 'msg-2',
    accountId: 'acc-1',
    recipientId: '+14155550001',
    recipientPhone: '+14155550001',
    recipientName: 'John Doe',
    content: 'Sure, tell me more about what you offer.',
    direction: 'incoming',
    status: 'read',
    timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000),
    threadId: 'thread-1',
  },
  {
    id: 'msg-3',
    accountId: 'acc-1',
    recipientId: '+14155550001',
    recipientPhone: '+14155550001',
    recipientName: 'John Doe',
    content: 'Great! We provide comprehensive solutions for businesses looking to scale their operations.',
    direction: 'outgoing',
    status: 'delivered',
    timestamp: new Date(Date.now() - 30 * 60 * 1000),
    threadId: 'thread-1',
  }
];

const initialCampaigns: Campaign[] = [
  {
    id: 'campaign-1',
    name: 'Welcome Campaign',
    messageTemplate: 'Hi {name}! We have exciting news for you...',
    status: 'draft',
    recipientCount: 100,
    sentCount: 0,
    failedCount: 0,
    replyCount: 0,
    accountIds: ['acc-1'],
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
  }
];

interface TelegramContextType {
  accounts: TelegramAccount[];
  proxies: Proxy[];
  conversations: Conversation[];
  messages: Message[];
  campaigns: Campaign[];
  stats: DashboardStats;
  uploadProgress: UploadProgress;
  typingUsers: Record<string, boolean>;
  
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
  markConversationAsRead: (conversationId: string) => void;
  startNewConversation: (accountId: string, recipientPhone: string, recipientName?: string) => string;
  
  // Campaign actions
  createCampaign: (campaign: Partial<Campaign>) => void;
  updateCampaign: (id: string, updates: Partial<Campaign>) => void;
  deleteCampaign: (id: string) => void;
  
  // Refresh
  refreshStats: () => void;
}

const TelegramContext = createContext<TelegramContextType | undefined>(undefined);

// Auto-reply messages for simulation
const autoReplies = [
  "That sounds interesting! Can you tell me more?",
  "Thanks for reaching out!",
  "I'll think about it and get back to you.",
  "Could you send me more details?",
  "Interesting! What's the pricing like?",
  "Let me check with my team first.",
];

export const TelegramProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [accounts, setAccounts] = useState<TelegramAccount[]>(initialAccounts);
  const [proxies, setProxies] = useState<Proxy[]>(initialProxies);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns);
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    total: 0,
    processed: 0,
    successful: 0,
    failed: 0,
    status: 'idle',
    errors: []
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
      total: files.length * 50,
      processed: 0,
      successful: 0,
      failed: 0,
      status: 'uploading',
      errors: []
    });

    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const success = Math.random() > 0.1;
      
      setUploadProgress(prev => ({
        ...prev,
        processed: i + 1,
        successful: prev.successful + (success ? 1 : 0),
        failed: prev.failed + (success ? 0 : 1),
        status: i === 9 ? 'completed' : 'processing',
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

  // Simulate typing and auto-reply
  const simulateReply = useCallback((recipientPhone: string, recipientName?: string, accountId?: string) => {
    // 50% chance of getting a reply
    if (Math.random() > 0.5) return;

    // Start typing indicator
    setTypingUsers(prev => ({ ...prev, [recipientPhone]: true }));

    // Reply after 2-4 seconds
    const replyDelay = 2000 + Math.random() * 2000;
    setTimeout(() => {
      setTypingUsers(prev => ({ ...prev, [recipientPhone]: false }));
      
      const replyContent = autoReplies[Math.floor(Math.random() * autoReplies.length)];
      const replyMessage: Message = {
        id: `msg-${Date.now()}`,
        accountId: accountId || 'acc-1',
        recipientId: recipientPhone,
        recipientPhone,
        recipientName,
        content: replyContent,
        direction: 'incoming',
        status: 'read',
        timestamp: new Date(),
        threadId: `thread-${recipientPhone}`
      };

      setMessages(prev => [...prev, replyMessage]);
      
      // Update conversation with unread count
      setConversations(prev => prev.map(c => 
        c.recipientPhone === recipientPhone 
          ? { ...c, unreadCount: c.unreadCount + 1, updatedAt: new Date(), isActive: true }
          : c
      ));
    }, replyDelay);
  }, []);

  const sendMessage = useCallback((accountId: string, recipientPhone: string, content: string) => {
    const conv = conversations.find(c => c.recipientPhone === recipientPhone);
    const newMessage: Message = {
      id: `msg-${Date.now()}`,
      accountId,
      recipientId: recipientPhone,
      recipientPhone,
      recipientName: conv?.recipientName,
      content,
      direction: 'outgoing',
      status: 'sent',
      timestamp: new Date(),
      threadId: `thread-${recipientPhone}`
    };
    setMessages(prev => [...prev, newMessage]);
    
    // Update message status after delays (simulating Telegram)
    setTimeout(() => {
      setMessages(prev => prev.map(m => 
        m.id === newMessage.id ? { ...m, status: 'delivered' } : m
      ));
    }, 1000);

    setTimeout(() => {
      setMessages(prev => prev.map(m => 
        m.id === newMessage.id ? { ...m, status: 'read' } : m
      ));
    }, 3000);
    
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

    // Trigger auto-reply simulation
    simulateReply(recipientPhone, conv?.recipientName, accountId);
  }, [conversations, simulateReply]);

  const getConversationMessages = useCallback((conversationId: string) => {
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv) return [];
    return messages.filter(m => m.recipientPhone === conv.recipientPhone);
  }, [conversations, messages]);

  const markConversationAsRead = useCallback((conversationId: string) => {
    setConversations(prev => prev.map(c => 
      c.id === conversationId ? { ...c, unreadCount: 0 } : c
    ));
  }, []);

  const startNewConversation = useCallback((accountId: string, recipientPhone: string, recipientName?: string) => {
    const existing = conversations.find(c => c.recipientPhone === recipientPhone);
    if (existing) return existing.id;

    const newConvId = `conv-${Date.now()}`;
    setConversations(prev => [...prev, {
      id: newConvId,
      accountId,
      recipientPhone,
      recipientName,
      unreadCount: 0,
      isActive: false,
      createdAt: new Date(),
      updatedAt: new Date()
    }]);
    return newConvId;
  }, [conversations]);

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

  const deleteCampaign = useCallback((id: string) => {
    setCampaigns(prev => prev.filter(c => c.id !== id));
  }, []);

  const refreshStats = useCallback(() => {}, []);

  const value: TelegramContextType = {
    accounts,
    proxies,
    conversations,
    messages,
    campaigns,
    stats,
    uploadProgress,
    typingUsers,
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
    markConversationAsRead,
    startNewConversation,
    createCampaign,
    updateCampaign,
    deleteCampaign,
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
