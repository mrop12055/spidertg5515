import React, { createContext, useContext, useState, ReactNode, useCallback, useEffect, useRef } from 'react';
import { 
  TelegramAccount, 
  Proxy, 
  Conversation, 
  Message, 
  Campaign, 
  DashboardStats,
  UploadProgress 
} from '@/types/telegram';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import JSZip from 'jszip';

// Minimal mock data - just 2 examples
const initialAccounts: TelegramAccount[] = [];
const initialProxies: Proxy[] = [];
const initialConversations: Conversation[] = [];
const initialMessages: Message[] = [];
const initialCampaigns: Campaign[] = [];

export interface AccountTaskLog {
  id: string;
  taskType: string;
  accountPhone: string;
  status: 'pending' | 'completed' | 'failed';
  result?: string;
  timestamp: Date;
}

export interface AccountTasksProgress {
  total: number;
  completed: number;
  failed: number;
  taskType: string;
  logs: AccountTaskLog[];
  /** Internal task key used by the runner (e.g. sync_profile) */
  internalTaskType?: string;
  /** ISO timestamp when the UI started tracking this run */
  startedAt?: string;
  /** ISO timestamp of the last task status update received */
  lastUpdateAt?: string;
}

interface TelegramContextType {
  accounts: TelegramAccount[];
  proxies: Proxy[];
  conversations: Conversation[];
  messages: Message[];
  campaigns: Campaign[];
  stats: DashboardStats;
  uploadProgress: UploadProgress;
  typingUsers: Record<string, boolean>;
  isLoading: boolean;
  
  // Account tasks progress (persisted across navigation)
  accountTasksProgress: AccountTasksProgress;
  setAccountTasksProgress: React.Dispatch<React.SetStateAction<AccountTasksProgress>>;
  isAccountTaskRunning: boolean;
  setIsAccountTaskRunning: React.Dispatch<React.SetStateAction<boolean>>;
  showAccountTaskLogs: boolean;
  setShowAccountTaskLogs: React.Dispatch<React.SetStateAction<boolean>>;
  accountTaskHistory: AccountTaskLog[];
  setAccountTaskHistory: React.Dispatch<React.SetStateAction<AccountTaskLog[]>>;
  
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
  sendMessage: (accountId: string, recipientPhone: string, content: string, mediaUrl?: string, mediaType?: string) => Promise<void>;
  sendMediaMessage: (accountId: string, recipientPhone: string, file: File, caption?: string) => Promise<void>;
  getConversationMessages: (conversationId: string) => Message[];
  markConversationAsRead: (conversationId: string) => Promise<void>;
  startNewConversation: (accountId: string, recipientPhone: string, recipientName?: string) => Promise<string>;
  deleteConversation: (conversationId: string) => Promise<void>;
  deleteConversations: (conversationIds: string[]) => Promise<void>;
  blockContact: (conversationId: string) => Promise<void>;
  blockContacts: (conversationIds: string[]) => Promise<void>;
  
  // Campaign actions
  createCampaign: (campaign: Partial<Campaign>) => Promise<Campaign | null>;
  updateCampaign: (id: string, updates: Partial<Campaign>) => void;
  deleteCampaign: (id: string) => void;
  uploadRecipients: (campaignId: string, recipients: { phone_number: string; name?: string; seat_id?: string }[]) => Promise<{ inserted: number; duplicates: number; duplicateNumbers?: string[] } | undefined>;
  startCampaign: (campaignId: string) => Promise<void>;
  
  // Refresh
  refreshStats: () => void;
  refreshData: () => Promise<void>;
}

// Context for Telegram functionality
const TelegramContext = createContext<TelegramContextType | undefined>(undefined);

export const TelegramProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [accounts, setAccounts] = useState<TelegramAccount[]>(initialAccounts);
  const [proxies, setProxies] = useState<Proxy[]>(initialProxies);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns);
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    total: 0,
    processed: 0,
    successful: 0,
    failed: 0,
    status: 'idle',
    errors: []
  });

  // Keep a ref for realtime handlers (avoid extra DB lookups per message)
  const conversationsRef = useRef<Conversation[]>(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Prevent duplicate reply notifications using message DB id (most unique identifier)
  // We use a Set of processed message IDs to guarantee exactly-once notification
  const processedMessageIdsRef = useRef<Set<string>>(new Set());
  const PROCESSED_MESSAGE_IDS_LIMIT = 2000;
  
  // Account tasks progress (persisted across navigation)
  const [accountTasksProgress, setAccountTasksProgress] = useState<AccountTasksProgress>({
    total: 0,
    completed: 0,
    failed: 0,
    taskType: '',
    logs: [],
    internalTaskType: undefined,
    startedAt: undefined,
    lastUpdateAt: undefined,
  });
  const [isAccountTaskRunning, setIsAccountTaskRunning] = useState(false);
  const [showAccountTaskLogs, setShowAccountTaskLogs] = useState(false);
  const [accountTaskHistory, setAccountTaskHistory] = useState<AccountTaskLog[]>([]);

  // Fetch data from Supabase
  // OPTIMIZED: Accounts and Proxies are now handled by dedicated cached hooks (useAccounts, useProxies)
  // This only fetches campaigns, conversations, and messages
  const refreshData = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Only fetch what's NOT handled by cached hooks
      // Fetch campaigns
      const campaignsResult = await supabase
        .from('campaigns')
        .select('*, campaign_accounts(account_id)')
        .order('created_at', { ascending: false });

      // Fetch conversations with PARALLEL pagination to bypass 1000 limit (up to 50k)
      const PAGE_SIZE = 1000;
      const MAX_CONVERSATIONS = 50000;
      
      // Get total count first
      const { count: totalConvCount } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .not('last_message_at', 'is', null);
      
      const effectiveConvCount = Math.min(totalConvCount || 0, MAX_CONVERSATIONS);
      const totalConvPages = Math.ceil(effectiveConvCount / PAGE_SIZE);
      const allConversations: any[] = [];
      
      // Build all page requests for PARALLEL fetching
      const pagePromises = Array.from({ length: totalConvPages }, (_, page) => {
        const from = page * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        
        return supabase
          .from('conversations')
          .select('id,account_id,recipient_phone,recipient_telegram_id,recipient_name,recipient_username,recipient_avatar,unread_count,is_active,last_message_at,last_message_content,last_message_direction,created_at,updated_at,blocked_by_recipient,first_message_sent,has_reply,seat_id')
          .not('last_message_at', 'is', null)
          .order('last_message_at', { ascending: false })
          .range(from, to);
      });
      
      // Execute all page requests in parallel
      const results = await Promise.all(pagePromises);
      
      // Combine all results
      for (const result of results) {
        if (result.error) {
          console.error('Error fetching conversations page', result.error);
          break;
        }
        if (result.data) allConversations.push(...result.data);
      }
      
      console.log('[TelegramContext] Fetched', allConversations.length, 'of', totalConvCount, 'conversations (parallel)');
      
      const conversationsResult = { data: allConversations, error: null };

      // Fetch messages - LIMIT to last 3 days for performance
      const messagesResult = await supabase
        .from('messages')
        .select('*, conversations(recipient_phone)')
        .gte('created_at', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(5000);

      // Process campaigns
      if (campaignsResult.data) {
        setCampaigns(campaignsResult.data.map(c => ({
          id: c.id,
          name: c.name,
          messageTemplate: c.message_template,
          status: c.status as Campaign['status'],
          scheduledAt: c.scheduled_at ? new Date(c.scheduled_at) : undefined,
          recipientCount: c.recipient_count || 0,
          sentCount: c.sent_count || 0,
          failedCount: c.failed_count || 0,
          pendingCount: (c as any).pending_count || 0,
          replyCount: c.reply_count || 0,
          accountIds: c.campaign_accounts?.map((ca: any) => ca.account_id) || [],
          createdAt: new Date(c.created_at),
          updatedAt: new Date(c.updated_at),
          seatId: c.seat_id || undefined,
        })));
      }

      // Process conversations
      if (conversationsResult.error) {
        console.error('Error fetching conversations:', conversationsResult.error);
      }
      if (conversationsResult.data) {
        setConversations(
          conversationsResult.data.map((c: any) => ({
            id: c.id,
            accountId: c.account_id,
            recipientPhone: c.recipient_phone || '',
            recipientName: c.recipient_name || undefined,
            recipientUsername: c.recipient_username || undefined,
            recipientAvatar: c.recipient_avatar || undefined,
            unreadCount: c.unread_count || 0,
            isActive: c.is_active || false,
            createdAt: new Date(c.created_at),
            updatedAt: new Date(c.updated_at || c.created_at),
            lastMessageAt: c.last_message_at ? new Date(c.last_message_at) : undefined,
            lastMessageContent: c.last_message_content || undefined,
            lastMessageDirection: c.last_message_direction as 'incoming' | 'outgoing' | undefined,
            blockedByRecipient: (c as any).blocked_by_recipient || false,
            firstMessageSent: (c as any).first_message_sent ?? false,
            hasReply: (c as any).has_reply ?? false,
            seatId: c.seat_id || undefined,
          }))
        );
      }

      // Process messages
      if (messagesResult.data) {
        setMessages(messagesResult.data.map(m => ({
          id: m.id,
          conversationId: m.conversation_id,
          accountId: m.account_id,
          recipientPhone: m.conversations?.recipient_phone || '',
          content: m.content,
          direction: m.direction as Message['direction'],
          status: m.status as Message['status'],
          timestamp: new Date(m.created_at),
          telegramMessageId: m.telegram_message_id || undefined,
          failedReason: (m as any).failed_reason || undefined,
          mediaUrl: (m as any).media_url || undefined,
          mediaType: (m as any).media_type || undefined,
          campaignRecipientId: (m as any).campaign_recipient_id || undefined,
        })));
      }

    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial data fetch
  useEffect(() => {
    refreshData();
  }, [refreshData]);

  // Real-time subscriptions for messages and conversations
  useEffect(() => {
    // Subscribe to new messages
    const messagesChannel = supabase
      .channel('messages-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages'
        },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            const m = payload.new as any;

            const recipientPhone =
              conversationsRef.current.find(c => c.id === m.conversation_id)?.recipientPhone || '';

            const newMessage: Message = {
              id: m.id,
              conversationId: m.conversation_id,
              accountId: m.account_id,
              recipientPhone,
              content: m.content,
              direction: m.direction as Message['direction'],
              status: m.status as Message['status'],
              timestamp: new Date(m.created_at),
              telegramMessageId: m.telegram_message_id || undefined,
              failedReason: m.failed_reason || undefined,
              mediaUrl: m.media_url || undefined,
              mediaType: m.media_type || undefined,
              campaignRecipientId: m.campaign_recipient_id || undefined,
            };

            setMessages(prev => {
              const MAX_MESSAGES = 1000;

              if (prev.some(msg => msg.id === m.id)) {
                const next = prev.map(msg => (msg.id === m.id ? newMessage : msg));
                return next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
              }

              const next = [newMessage, ...prev];
              return next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
            });

            // Play notification sound for incoming messages - ONLY for campaign conversations
            if (m.direction === 'incoming') {
              // IMPORTANT: SeatChat (/seat/:token) has its own notifications.
              // If we also notify from the global context, users see duplicates.
              const isSeatRoute =
                typeof window !== 'undefined' && window.location.pathname.startsWith('/seat/');
              if (isSeatRoute) return;

              // Check if this is from a campaign conversation (where we messaged first)
              const conversation = conversationsRef.current.find(c => c.id === m.conversation_id);
              
              // Only notify for campaign conversations
              if (!conversation?.firstMessageSent) {
                console.log('Skipping notification - not a campaign conversation');
                return;
              }

              // Dedupe by message DB id (most unique identifier)
              // This guarantees exactly-once notification even if realtime sends duplicates
              if (processedMessageIdsRef.current.has(m.id)) {
                console.log('Skipping notification - already processed message ID:', m.id);
                return;
              }
              
              // Add to processed set FIRST to prevent races
              processedMessageIdsRef.current.add(m.id);
              
              // Prune old entries to prevent memory growth (keep last N)
              if (processedMessageIdsRef.current.size > PROCESSED_MESSAGE_IDS_LIMIT) {
                const idsArray = Array.from(processedMessageIdsRef.current);
                const toRemove = idsArray.slice(0, idsArray.length - PROCESSED_MESSAGE_IDS_LIMIT);
                toRemove.forEach(id => processedMessageIdsRef.current.delete(id));
              }

              // Use message DB id for stable toast id (Sonner will collapse duplicates)
              const toastId = `reply-${m.id}`;
              
              try {
                // Check if AudioContext is available
                const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
                if (!AudioContextClass) {
                  console.log('AudioContext not available');
                } else {
                  const audioContext = new AudioContextClass();
                  const oscillator = audioContext.createOscillator();
                  const gainNode = audioContext.createGain();
                  oscillator.connect(gainNode);
                  gainNode.connect(audioContext.destination);
                  oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
                  oscillator.type = 'sine';
                  gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
                  gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
                  oscillator.start(audioContext.currentTime);
                  oscillator.stop(audioContext.currentTime + 0.3);
                  
                  // Second chime
                  setTimeout(() => {
                    try {
                      const osc2 = audioContext.createOscillator();
                      const gain2 = audioContext.createGain();
                      osc2.connect(gain2);
                      gain2.connect(audioContext.destination);
                      osc2.frequency.setValueAtTime(1320, audioContext.currentTime);
                      osc2.type = 'sine';
                      gain2.gain.setValueAtTime(0.2, audioContext.currentTime);
                      gain2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
                      osc2.start(audioContext.currentTime);
                      osc2.stop(audioContext.currentTime + 0.2);
                    } catch (e) {
                      // Ignore secondary chime errors
                    }
                  }, 100);
                }
              } catch (e) {
                console.log('Could not play notification:', e);
              }

              // Show toast notification ONCE (deduped via id)
              toast.info('New reply received!', {
                id: toastId,
                description: m.content?.substring(0, 50) || 'You have a new message',
              });
            }
          } else if (payload.eventType === 'UPDATE') {
            const m = payload.new as any;
            setMessages(prev =>
              prev.map(msg =>
                msg.id === m.id
                  ? {
                      ...msg,
                      status: m.status as Message['status'],
                      failedReason: m.failed_reason || undefined,
                    }
                  : msg
              )
            );
            
            // Also update the conversation's lastMessageAt if the message is now sent/delivered
            if (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') {
              setConversations(prev =>
                prev.map(conv =>
                  conv.id === m.conversation_id
                    ? { ...conv, lastMessageAt: new Date(m.created_at), updatedAt: new Date() }
                    : conv
                )
              );
            }
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as any;
            const deletedId = oldRow?.id;
            if (!deletedId) return;
            setMessages(prev => prev.filter(msg => msg.id !== deletedId));
          }
        }
      )
      .subscribe();

    // Subscribe to conversation changes
    const conversationsChannel = supabase
      .channel('conversations-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversations'
        },
          (payload) => {
            // (avoid verbose logging here; it can slow down long-running sessions)
            
            if (payload.eventType === 'INSERT') {
            const c = payload.new as any;
            // Include all conversations with messages (last_message_at set)
            const newConv: Conversation = {
              id: c.id,
              accountId: c.account_id,
              recipientPhone: c.recipient_phone || '',
              recipientName: c.recipient_name || undefined,
              recipientUsername: c.recipient_username || undefined,
              recipientAvatar: c.recipient_avatar || undefined,
              unreadCount: c.unread_count || 0,
              isActive: c.is_active || false,
              createdAt: new Date(c.created_at),
              updatedAt: new Date(c.updated_at || c.created_at),
              lastMessageAt: c.last_message_at ? new Date(c.last_message_at) : undefined,
              lastMessageContent: c.last_message_content || undefined,
              blockedByRecipient: c.blocked_by_recipient || false,
              firstMessageSent: c.first_message_sent ?? false,
              hasReply: c.has_reply ?? false,
              seatId: c.seat_id || undefined,
            };

            // Add conversation if it has messages (last_message_at is set)
            if (newConv.lastMessageAt) {
              setConversations(prev => {
                if (prev.some(conv => conv.id === c.id)) {
                  return prev.map(conv => (conv.id === c.id ? newConv : conv));
                }
                return [newConv, ...prev];
              });
            }
          } else if (payload.eventType === 'UPDATE') {
            const c = payload.new as any;
            setConversations(prev =>
              prev
                .map(conv =>
                  conv.id === c.id
                    ? {
                        ...conv,
                        unreadCount: c.unread_count ?? conv.unreadCount,
                        updatedAt: new Date(c.updated_at || c.last_message_at || conv.updatedAt),
                        lastMessageAt: c.last_message_at ? new Date(c.last_message_at) : conv.lastMessageAt,
                        lastMessageContent: c.last_message_content ?? conv.lastMessageContent,
                        recipientName: c.recipient_name || conv.recipientName,
                        recipientUsername: c.recipient_username || conv.recipientUsername,
                        isActive: c.is_active ?? conv.isActive,
                        blockedByRecipient: c.blocked_by_recipient ?? conv.blockedByRecipient,
                        firstMessageSent: c.first_message_sent ?? conv.firstMessageSent,
                        hasReply: c.has_reply ?? conv.hasReply,
                      }
                    : conv
                )
                .sort((a, b) => {
                  const aTime = a.lastMessageAt?.getTime() || a.updatedAt.getTime();
                  const bTime = b.lastMessageAt?.getTime() || b.updatedAt.getTime();
                  return bTime - aTime;
                })
            );
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as any;
            const deletedId = oldRow?.id;
            if (!deletedId) return;
            setConversations(prev => prev.filter(conv => conv.id !== deletedId));
            // Also remove orphaned messages for that conversation
            setMessages(prev => prev.filter(m => m.conversationId !== deletedId));
          }
        }
      )
      .subscribe();

    // Subscribe to telegram_accounts changes (for profile sync updates)
    const accountsChannel = supabase
      .channel('accounts-realtime')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'telegram_accounts'
        },
        (payload) => {
          const acc = payload.new as any;
          setAccounts(prev =>
            prev.map(account =>
              account.id === acc.id
                ? {
                    ...account,
                    firstName: acc.first_name || account.firstName,
                    lastName: acc.last_name || account.lastName,
                    username: acc.username || account.username,
                    avatar: acc.avatar_url || account.avatar,
                    status: acc.status as TelegramAccount['status'] || account.status,
                    lastActive: acc.last_active ? new Date(acc.last_active) : account.lastActive,
                    spambotStatus: acc.spambot_status || account.spambotStatus,
                    banReason: acc.ban_reason || account.banReason,
                  }
                : account
            )
          );
        }
      )
      .subscribe();

    // Subscribe to campaign changes
    const campaignsChannel = supabase
      .channel('campaigns-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'campaigns'
        },
        (payload) => {
          console.log('Campaign change:', payload);
          
          if (payload.eventType === 'UPDATE') {
            const c = payload.new as any;
            setCampaigns(prev =>
              prev.map(camp =>
                camp.id === c.id
                  ? {
                      ...camp,
                      status: c.status as Campaign['status'],
                      sentCount: c.sent_count || camp.sentCount,
                      failedCount: c.failed_count || camp.failedCount,
                      recipientCount: c.recipient_count || camp.recipientCount,
                      updatedAt: new Date(c.updated_at || camp.updatedAt),
                      seatId: c.seat_id || camp.seatId,
                    }
                  : camp
              )
            );
          } else if (payload.eventType === 'INSERT') {
            // Refresh to get full campaign data with relations
            refreshData();
          } else if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as any;
            const deletedId = oldRow?.id;
            if (!deletedId) return;
            setCampaigns(prev => prev.filter(c => c.id !== deletedId));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(messagesChannel);
      supabase.removeChannel(conversationsChannel);
      supabase.removeChannel(accountsChannel);
      supabase.removeChannel(campaignsChannel);
    };
  }, [refreshData]);

  const stats: DashboardStats = {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter(a => a.status === 'active').length,
    bannedAccounts: accounts.filter(a => a.status === 'banned').length,
    // Count accounts with status = 'restricted' OR with restrictedUntil in the future
    restrictedAccounts: accounts.filter(a => 
      a.status === 'restricted' || 
      a.status === 'cooldown' ||
      (a.restrictedUntil && new Date(a.restrictedUntil) > new Date())
    ).length,
    totalProxies: proxies.length,
    activeProxies: proxies.filter(p => p.status === 'active').length,
    messagesToday: accounts.reduce((sum, a) => sum + a.messagesSentToday, 0),
    repliesReceived: conversations.filter(c => c.unreadCount > 0).length,
    campaignsRunning: campaigns.filter(c => c.status === 'running').length,
  };

  const addAccount = useCallback(async (account: Partial<TelegramAccount>) => {
    try {
      const { data, error } = await supabase
        .from('telegram_accounts')
        .insert({
          phone_number: account.phoneNumber || '',
          first_name: account.firstName,
          last_name: account.lastName,
          username: account.username,
          status: 'active',
          maturity_score: 0,
          maturity_days: 0,
          daily_limit: 25,
          messages_sent_today: 0,
        })
        .select()
        .single();

      if (error) throw error;
      toast.success('Account added successfully');
      refreshData();
    } catch (error) {
      console.error('Error adding account:', error);
      toast.error('Failed to add account');
    }
  }, [refreshData]);

  const updateAccount = useCallback(async (id: string, updates: Partial<TelegramAccount>) => {
    try {
      const { error } = await supabase
        .from('telegram_accounts')
        .update({
          phone_number: updates.phoneNumber,
          first_name: updates.firstName,
          last_name: updates.lastName,
          username: updates.username,
          status: updates.status,
          proxy_id: updates.proxyId,
        })
        .eq('id', id);

      if (error) throw error;
      refreshData();
    } catch (error) {
      console.error('Error updating account:', error);
      toast.error('Failed to update account');
    }
  }, [refreshData]);

  const deleteAccount = useCallback(async (id: string) => {
    try {
      const { error } = await supabase
        .from('telegram_accounts')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Account deleted');
      refreshData();
    } catch (error) {
      console.error('Error deleting account:', error);
      toast.error('Failed to delete account');
    }
  }, [refreshData]);

  // Real ZIP file processing
  const uploadAccounts = useCallback(async (files: File[]) => {
    setUploadProgress({
      total: 0,
      processed: 0,
      successful: 0,
      failed: 0,
      status: 'uploading',
      errors: []
    });

    const accountsToUpload: any[] = [];

    try {
      for (const file of files) {
        if (file.name.endsWith('.zip')) {
          // Process ZIP file
          const zip = new JSZip();
          const contents = await zip.loadAsync(file);
          
          const jsonFiles: Record<string, any> = {};
          const sessionFiles: Record<string, string> = {};

          // First pass: read all files
          for (const [filename, zipEntry] of Object.entries(contents.files)) {
            if (zipEntry.dir) continue;
            
            const basename = filename.replace(/\.[^/.]+$/, '');
            
            if (filename.endsWith('.json')) {
              const content = await zipEntry.async('string');
              try {
                jsonFiles[basename] = JSON.parse(content);
              } catch {
                console.warn(`Invalid JSON: ${filename}`);
              }
            } else if (filename.endsWith('.session')) {
              const content = await zipEntry.async('base64');
              sessionFiles[basename] = content;
            }
          }

          // Second pass: match session files with JSON metadata
          for (const [basename, sessionData] of Object.entries(sessionFiles)) {
            const metadata = jsonFiles[basename] || {};
            
            accountsToUpload.push({
              phone_number: metadata.phone_number || basename.replace(/[^0-9+]/g, ''),
              first_name: metadata.first_name || metadata.firstName,
              last_name: metadata.last_name || metadata.lastName,
              username: metadata.username,
              session_data: sessionData,
              api_id: metadata.api_id,
              api_hash: metadata.api_hash,
            });
          }

          // Also process standalone JSON files (in case they contain session_string)
          for (const [basename, metadata] of Object.entries(jsonFiles)) {
            if (sessionFiles[basename]) continue; // Already processed
            
            if (metadata.session_string || metadata.session_data) {
              accountsToUpload.push({
                phone_number: metadata.phone_number || basename.replace(/[^0-9+]/g, ''),
                first_name: metadata.first_name || metadata.firstName,
                last_name: metadata.last_name || metadata.lastName,
                username: metadata.username,
                session_data: metadata.session_string || metadata.session_data,
                api_id: metadata.api_id,
                api_hash: metadata.api_hash,
              });
            }
          }
        } else if (file.name.endsWith('.json')) {
          // Single JSON file
          const content = await file.text();
          try {
            const data = JSON.parse(content);
            
            // Handle array of accounts
            const accountsArray = Array.isArray(data) ? data : [data];
            
            for (const acc of accountsArray) {
              if (acc.session_string || acc.session_data) {
                accountsToUpload.push({
                  phone_number: acc.phone_number,
                  first_name: acc.first_name || acc.firstName,
                  last_name: acc.last_name || acc.lastName,
                  username: acc.username,
                  session_data: acc.session_string || acc.session_data,
                  api_id: acc.api_id,
                  api_hash: acc.api_hash,
                });
              }
            }
          } catch {
            console.warn(`Invalid JSON file: ${file.name}`);
          }
        } else if (file.name.endsWith('.session')) {
          // Single session file - use filename as phone number
          const content = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(btoa(reader.result as string));
            reader.readAsBinaryString(file);
          });
          
          const phoneNumber = file.name.replace('.session', '').replace(/[^0-9+]/g, '');
          accountsToUpload.push({
            phone_number: phoneNumber || `+unknown_${Date.now()}`,
            session_data: content,
          });
        }
      }

      if (accountsToUpload.length === 0) {
        setUploadProgress(prev => ({
          ...prev,
          status: 'error',
          errors: ['No valid accounts found in uploaded files']
        }));
        toast.error('No valid accounts found in files');
        return;
      }

      // Process in chunks of 300 for speed and reliability
      const CHUNK_SIZE = 300;
      const totalAccounts = accountsToUpload.length;
      let totalSuccessful = 0;
      let totalFailed = 0;
      const allErrors: string[] = [];

      setUploadProgress({
        total: totalAccounts,
        processed: 0,
        successful: 0,
        failed: 0,
        status: 'processing',
        errors: []
      });

      for (let i = 0; i < totalAccounts; i += CHUNK_SIZE) {
        const chunk = accountsToUpload.slice(i, i + CHUNK_SIZE);
        const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1;
        const totalChunks = Math.ceil(totalAccounts / CHUNK_SIZE);

        try {
          const { data, error } = await supabase.functions.invoke('admin-api', {
            body: { path: '/upload-accounts', accounts: chunk }
          });

          if (error) {
            console.error(`Chunk ${chunkNumber} error:`, error);
            totalFailed += chunk.length;
            allErrors.push(`Chunk ${chunkNumber}: ${error.message}`);
          } else {
            totalSuccessful += data.successful || 0;
            totalFailed += data.failed || 0;
            if (data.errors?.length) {
              allErrors.push(...data.errors.slice(0, 5)); // Limit errors per chunk
            }
          }
        } catch (err) {
          console.error(`Chunk ${chunkNumber} exception:`, err);
          totalFailed += chunk.length;
          allErrors.push(`Chunk ${chunkNumber}: ${(err as Error).message}`);
        }

        // Update progress after each chunk
        setUploadProgress({
          total: totalAccounts,
          processed: Math.min(i + CHUNK_SIZE, totalAccounts),
          successful: totalSuccessful,
          failed: totalFailed,
          status: 'processing',
          errors: allErrors.slice(0, 20) // Keep last 20 errors
        });
      }

      // Final status
      setUploadProgress({
        total: totalAccounts,
        processed: totalAccounts,
        successful: totalSuccessful,
        failed: totalFailed,
        status: 'completed',
        errors: allErrors.slice(0, 20)
      });

      if (totalSuccessful > 0) {
        toast.success(`Successfully uploaded ${totalSuccessful} accounts`);
      }
      if (totalFailed > 0 && totalFailed < totalAccounts) {
        toast.warning(`${totalFailed} accounts skipped (duplicates or errors)`);
      } else if (totalFailed === totalAccounts) {
        toast.error(`All ${totalFailed} accounts failed or already exist`);
      }

      refreshData();
    } catch (error) {
      console.error('Error uploading accounts:', error);
      setUploadProgress(prev => ({
        ...prev,
        status: 'error',
        errors: [...prev.errors, (error as Error).message]
      }));
      toast.error('Failed to upload accounts');
    }
  }, [refreshData]);

  const addProxy = useCallback(async (proxy: Partial<Proxy>) => {
    try {
      const { error } = await supabase
        .from('proxies')
        .insert({
          host: proxy.host || '',
          port: proxy.port || 8080,
          username: proxy.username,
          password: proxy.password,
          proxy_type: proxy.type || 'socks5',
          status: 'active',
        });

      if (error) throw error;
      toast.success('Proxy added');
      refreshData();
    } catch (error) {
      console.error('Error adding proxy:', error);
      toast.error('Failed to add proxy');
    }
  }, [refreshData]);

  const addProxiesBulk = useCallback(async (proxyText: string) => {
    const lines = proxyText.split('\n').filter(l => l.trim());
    const newProxies = lines.map(line => {
      const parts = line.split(':');
      return {
        host: parts[0] || '',
        port: parseInt(parts[1]) || 8080,
        username: parts[2] || null,
        password: parts[3] || null,
        proxy_type: 'http' as const,
        status: 'active' as const,
      };
    });

    try {
      const { error } = await supabase
        .from('proxies')
        .insert(newProxies);

      if (error) throw error;
      toast.success(`Added ${newProxies.length} proxies`);
      refreshData();
    } catch (error) {
      console.error('Error adding proxies:', error);
      toast.error('Failed to add proxies');
    }
  }, [refreshData]);

  const updateProxy = useCallback(async (id: string, updates: Partial<Proxy>) => {
    try {
      const { error } = await supabase
        .from('proxies')
        .update({
          host: updates.host,
          port: updates.port,
          username: updates.username,
          password: updates.password,
          proxy_type: updates.type,
          status: updates.status,
        })
        .eq('id', id);

      if (error) throw error;
      refreshData();
    } catch (error) {
      console.error('Error updating proxy:', error);
      toast.error('Failed to update proxy');
    }
  }, [refreshData]);

  const deleteProxy = useCallback(async (id: string) => {
    try {
      const { error } = await supabase
        .from('proxies')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Proxy deleted');
      refreshData();
    } catch (error) {
      console.error('Error deleting proxy:', error);
      toast.error('Failed to delete proxy');
    }
  }, [refreshData]);

  const assignProxy = useCallback(async (accountId: string, proxyId: string) => {
    try {
      const { error } = await supabase
        .from('telegram_accounts')
        .update({ proxy_id: proxyId })
        .eq('id', accountId);

      if (error) throw error;
      
      await supabase
        .from('proxies')
        .update({ assigned_account_id: accountId })
        .eq('id', proxyId);

      refreshData();
    } catch (error) {
      console.error('Error assigning proxy:', error);
      toast.error('Failed to assign proxy');
    }
  }, [refreshData]);

  const sendMessage = useCallback(async (accountId: string, recipientPhone: string, content: string, mediaUrl?: string, mediaType?: string) => {
    try {
      // Find or create conversation
      let conv = conversations.find(c => c.recipientPhone === recipientPhone && c.accountId === accountId);
      let conversationId = conv?.id;
      
      if (!conversationId) {
        // Create conversation in database
        const { data: newConv, error: convError } = await supabase
          .from('conversations')
          .insert({
            account_id: accountId,
            recipient_phone: recipientPhone,
            is_active: true,
            unread_count: 0,
          })
          .select()
          .single();
        
        if (convError) throw convError;
        conversationId = newConv.id;
      }

      // Insert message to database with 'pending' status for Python to pick up
      // Priority 10 = instant delivery (same as seat chat)
      const { data: msgData, error: msgError } = await supabase
        .from('messages')
        .insert({
          account_id: accountId,
          conversation_id: conversationId,
          content,
          direction: 'outgoing',
          status: 'pending', // Python script will pick this up
          priority: 10, // High priority for instant delivery
          media_url: mediaUrl,
          media_type: mediaType,
        })
        .select()
        .single();

      if (msgError) throw msgError;

      // Update local state immediately for UI responsiveness
      const newMessage: Message = {
        id: msgData.id,
        accountId,
        conversationId: msgData.conversation_id,
        recipientPhone,
        recipientName: conv?.recipientName,
        content,
        direction: 'outgoing',
        status: 'pending',
        timestamp: new Date(),
        mediaUrl,
        mediaType,
      };
      setMessages(prev => {
        const MAX_MESSAGES = 1000;
        const next = [...prev, newMessage];
        return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
      });
      
      toast.success('Message queued for sending');
      refreshData();
    } catch (error) {
      console.error('Error sending message:', error);
      toast.error('Failed to send message');
    }
  }, [conversations, refreshData]);

  const sendMediaMessage = useCallback(async (accountId: string, recipientPhone: string, file: File, caption?: string) => {
    try {
      // Upload file to storage
      const fileName = `${Date.now()}_${file.name}`;
      const filePath = `${accountId}/${fileName}`;
      
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('message-attachments')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('message-attachments')
        .getPublicUrl(filePath);

      // Determine media type
      const mediaType = file.type.startsWith('image/') ? 'image' : 
                        file.type.startsWith('video/') ? 'video' : 
                        file.type.startsWith('audio/') ? 'audio' : 'document';

      // Send message with media
      await sendMessage(accountId, recipientPhone, caption || '', publicUrl, mediaType);
      
    } catch (error) {
      console.error('Error sending media message:', error);
      toast.error('Failed to send media');
    }
  }, [sendMessage]);

  const getConversationMessages = useCallback((conversationId: string) => {
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv) return [];
    return messages.filter(m => m.recipientPhone === conv.recipientPhone);
  }, [conversations, messages]);

  const markConversationAsRead = useCallback(async (conversationId: string) => {
    // Update local state immediately
    setConversations(prev => prev.map(c => 
      c.id === conversationId ? { ...c, unreadCount: 0 } : c
    ));
    
    // Mark messages as read
    setMessages(prev => prev.map(m => 
      m.conversationId === conversationId && m.direction === 'incoming' && m.status !== 'read'
        ? { ...m, status: 'read' }
        : m
    ));
    
    // Update database - conversation
    await supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId);
    
    // Update database - mark incoming messages as read
    await supabase
      .from('messages')
      .update({ read_at: new Date().toISOString(), status: 'read' })
      .eq('conversation_id', conversationId)
      .eq('direction', 'incoming')
      .is('read_at', null);
  }, []);

  const startNewConversation = useCallback(async (accountId: string, recipientPhone: string, recipientName?: string) => {
    // Check if it's a username (starts with @)
    const isUsername = recipientPhone.startsWith('@');
    
    // Check if conversation exists
    const existing = conversations.find(c => 
      (isUsername ? c.recipientPhone === recipientPhone : c.recipientPhone === recipientPhone) && 
      c.accountId === accountId
    );
    if (existing) return existing.id;

    try {
      const insertData: any = {
        account_id: accountId,
        recipient_name: recipientName,
        is_active: false,
        unread_count: 0,
      };
      
      // Store username in recipient_username field, phone in recipient_phone
      if (isUsername) {
        insertData.recipient_username = recipientPhone;
        insertData.recipient_phone = recipientPhone; // Also store in phone for display
      } else {
        insertData.recipient_phone = recipientPhone;
      }
      
      const { data, error } = await supabase
        .from('conversations')
        .insert(insertData)
        .select()
        .single();

      if (error) throw error;
      
      refreshData();
      return data.id;
    } catch (error) {
      console.error('Error creating conversation:', error);
      toast.error('Failed to create conversation');
      return '';
    }
  }, [conversations, refreshData]);

  const createCampaign = useCallback(async (campaign: Partial<Campaign>): Promise<Campaign | null> => {
    try {
      const { data, error } = await supabase
        .from('campaigns')
        .insert({
          name: campaign.name || 'New Campaign',
          message_template: campaign.messageTemplate || '',
          recipient_count: campaign.recipientCount || 0,
          status: 'draft',
        })
        .select()
        .single();

      if (error) throw error;

      // Link accounts if provided
      if (campaign.accountIds?.length && data) {
        await supabase
          .from('campaign_accounts')
          .insert(campaign.accountIds.map(aid => ({
            campaign_id: data.id,
            account_id: aid
          })));
      }

      toast.success('Campaign created');
      refreshData();
      
      // Return the created campaign
      if (data) {
        return {
          id: data.id,
          name: data.name,
          messageTemplate: data.message_template,
          recipientCount: data.recipient_count || 0,
          sentCount: data.sent_count || 0,
          failedCount: data.failed_count || 0,
          pendingCount: (data as any).pending_count || 0,
          replyCount: data.reply_count || 0,
          status: data.status as Campaign['status'],
          scheduledAt: data.scheduled_at ? new Date(data.scheduled_at) : undefined,
          createdAt: new Date(data.created_at || Date.now()),
          updatedAt: new Date(data.updated_at || Date.now()),
          accountIds: campaign.accountIds || [],
        };
      }
      return null;
    } catch (error) {
      console.error('Error creating campaign:', error);
      toast.error('Failed to create campaign');
      return null;
    }
  }, [refreshData]);

  const updateCampaign = useCallback(async (id: string, updates: Partial<Campaign>) => {
    try {
      const { error } = await supabase
        .from('campaigns')
        .update({
          name: updates.name,
          message_template: updates.messageTemplate,
          status: updates.status,
          recipient_count: updates.recipientCount,
        })
        .eq('id', id);

      if (error) throw error;
      refreshData();
    } catch (error) {
      console.error('Error updating campaign:', error);
      toast.error('Failed to update campaign');
    }
  }, [refreshData]);

  const deleteCampaign = useCallback(async (id: string) => {
    try {
      // First get the campaign name for preservation
      const { data: campaignData } = await supabase
        .from('campaigns')
        .select('name')
        .eq('id', id)
        .single();
      
      const campaignName = campaignData?.name || 'Deleted Campaign';

      // Get all campaign_recipient IDs for this campaign
      const { data: recipientIds } = await supabase
        .from('campaign_recipients')
        .select('id')
        .eq('campaign_id', id);

      // Cancel all pending messages linked to these recipients
      if (recipientIds?.length) {
        await supabase
          .from('messages')
          .update({ status: 'cancelled', failed_reason: 'Campaign deleted' })
          .in('campaign_recipient_id', recipientIds.map(r => r.id))
          .eq('status', 'pending');
      }

      // Preserve campaign name on conversations before deleting
      // This ensures conversations keep the campaign name even after campaign is deleted
      await supabase
        .from('conversations')
        .update({ campaign_name: campaignName })
        .eq('campaign_id', id);

      // Delete campaign accounts
      await supabase
        .from('campaign_accounts')
        .delete()
        .eq('campaign_id', id);

      // Delete campaign recipients (trigger will also cancel any remaining messages)
      await supabase
        .from('campaign_recipients')
        .delete()
        .eq('campaign_id', id);

      // Delete campaign (conversations.campaign_id will be set to NULL via ON DELETE SET NULL)
      const { error } = await supabase
        .from('campaigns')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Campaign deleted');
      refreshData();
    } catch (error) {
      console.error('Error deleting campaign:', error);
      toast.error('Failed to delete campaign');
    }
  }, [refreshData]);

  const uploadRecipients = useCallback(async (campaignId: string, recipients: { phone_number: string; name?: string; seat_id?: string }[]): Promise<{ inserted: number; duplicates: number; duplicateNumbers?: string[] } | undefined> => {
    try {
      // STEP 1: Get ALL phone numbers that have EVER been successfully messaged or are pending/sending
      // This prevents sending to the same person from ANY campaign
      const { data: allSentRecipients } = await supabase
        .from('campaign_recipients')
        .select('phone_number')
        .in('status', ['sent', 'pending', 'sending']);
      
      // Also check conversations where we sent the first message (outreach conversations)
      const { data: existingConversations } = await supabase
        .from('conversations')
        .select('recipient_phone')
        .eq('first_message_sent', true)
        .not('recipient_phone', 'is', null);
      
      // Build a set of all already-messaged phone numbers
      const alreadyMessaged = new Set<string>();
      
      // Add from campaign_recipients (sent/pending/sending)
      (allSentRecipients || []).forEach(r => {
        if (r.phone_number) alreadyMessaged.add(r.phone_number);
      });
      
      // Add from conversations (first_message_sent = true means we already reached out)
      (existingConversations || []).forEach(c => {
        if (c.recipient_phone) alreadyMessaged.add(c.recipient_phone);
      });
      
      // Filter out duplicates
      const duplicateNumbers: string[] = [];
      const newRecipients: { campaign_id: string; phone_number: string; name: string | null; seat_id: string | null; status: string }[] = [];
      const seenInBatch = new Set<string>();
      
      for (const recipient of recipients) {
        // Skip if already messaged in ANY campaign or conversation
        if (alreadyMessaged.has(recipient.phone_number)) {
          duplicateNumbers.push(recipient.phone_number);
          continue;
        }
        // Skip duplicates within this batch
        if (seenInBatch.has(recipient.phone_number)) {
          duplicateNumbers.push(recipient.phone_number);
          continue;
        }
        
        newRecipients.push({
          campaign_id: campaignId,
          phone_number: recipient.phone_number,
          name: recipient.name || null,
          seat_id: recipient.seat_id || null,
          status: 'pending'
        });
        seenInBatch.add(recipient.phone_number);
      }
      
      let inserted = 0;
      if (newRecipients.length > 0) {
        const { error } = await supabase
          .from('campaign_recipients')
          .insert(newRecipients);
        
        if (error) throw error;
        inserted = newRecipients.length;
      }
      
      // NOTE: recipient_count, pending_count, etc. are now managed by database trigger
      // sync_campaign_counts - no manual update needed here
      
      if (duplicateNumbers.length > 0) {
        toast.success(`Uploaded ${inserted} recipients. ${duplicateNumbers.length} already messaged (skipped).`);
      } else {
        toast.success(`Uploaded ${inserted} recipients`);
      }
      
      refreshData();
      return { inserted, duplicates: duplicateNumbers.length, duplicateNumbers };
    } catch (error) {
      console.error('Error uploading recipients:', error);
      toast.error('Failed to upload recipients');
      return undefined;
    }
  }, [refreshData]);

  const startCampaign = useCallback(async (campaignId: string) => {
    try {
      // Update campaign status to running
      const { error } = await supabase
        .from('campaigns')
        .update({ status: 'running' })
        .eq('id', campaignId);

      if (error) throw error;
      
      // The unified runner will pick up pending recipients automatically
      toast.success('Campaign started - runner will process recipients');
      refreshData();
    } catch (error) {
      console.error('Error starting campaign:', error);
      toast.error('Failed to start campaign');
    }
  }, [refreshData]);

  const refreshStats = useCallback(() => {
    refreshData();
  }, [refreshData]);

  const deleteConversation = useCallback(async (conversationId: string) => {
    try {
      // First delete all messages in this conversation
      await supabase
        .from('messages')
        .delete()
        .eq('conversation_id', conversationId);

      // Then delete the conversation
      const { error } = await supabase
        .from('conversations')
        .delete()
        .eq('id', conversationId);

      if (error) throw error;
      toast.success('Chat deleted');
      refreshData();
    } catch (error) {
      console.error('Error deleting conversation:', error);
      toast.error('Failed to delete chat');
    }
  }, [refreshData]);

  const deleteConversations = useCallback(async (conversationIds: string[]) => {
    try {
      // First delete all messages in these conversations
      await supabase
        .from('messages')
        .delete()
        .in('conversation_id', conversationIds);

      // Then delete the conversations
      const { error } = await supabase
        .from('conversations')
        .delete()
        .in('id', conversationIds);

      if (error) throw error;
      toast.success(`Deleted ${conversationIds.length} chats`);
      refreshData();
    } catch (error) {
      console.error('Error deleting conversations:', error);
      toast.error('Failed to delete chats');
    }
  }, [refreshData]);

  const blockContact = useCallback(async (conversationId: string) => {
    try {
      const conv = conversations.find(c => c.id === conversationId);
      if (!conv) {
        console.error('Conversation not found:', conversationId);
        return;
      }

      // Add to blocked_contacts table (for UI list & filtering)
      const { error: blockErr } = await supabase.from('blocked_contacts').insert({
        phone_number: conv.recipientPhone || conv.recipientName || 'unknown',
        name: conv.recipientName || null,
        blocked_by_account_id: conv.accountId,
        reason: 'Hidden from chat',
      });

      if (blockErr) {
        // If duplicate, that's fine - contact already blocked
        if (!blockErr.message?.includes('duplicate')) {
          console.error('Error adding to blocked_contacts:', blockErr);
        }
      }

      // NOTE: Local-only block = just hide from UI. Do NOT delete conversation/messages.
      toast.success(`Blocked (hidden) ${conv.recipientName || conv.recipientPhone}`);
      refreshData();
    } catch (error) {
      console.error('Error blocking contact:', error);
      toast.error('Failed to block contact');
    }
  }, [conversations, refreshData]);

  const blockContacts = useCallback(async (conversationIds: string[]) => {
    try {
      const convsToBlock = conversations.filter(c => conversationIds.includes(c.id));

      // Bulk insert into blocked_contacts
      const blockedRows = convsToBlock.map(conv => ({
        phone_number: conv.recipientPhone || conv.recipientName || 'unknown',
        name: conv.recipientName || null,
        blocked_by_account_id: conv.accountId,
        reason: 'Hidden from chat',
      }));
      if (blockedRows.length > 0) {
        const { error: blockErr } = await supabase
          .from('blocked_contacts')
          .upsert(blockedRows, { onConflict: 'phone_number' });
        if (blockErr && !blockErr.message?.includes('duplicate')) {
          console.error('Error adding to blocked_contacts:', blockErr);
        }
      }

      // NOTE: Local-only block = just hide from UI. Do NOT delete conversations/messages.
      toast.success(`Blocked (hidden) ${conversationIds.length} contacts`);
      refreshData();
    } catch (error) {
      console.error('Error blocking contacts:', error);
      toast.error('Failed to block contacts');
    }
  }, [conversations, refreshData]);

  const value: TelegramContextType = {
    accounts,
    proxies,
    conversations,
    messages,
    campaigns,
    stats,
    uploadProgress,
    typingUsers,
    isLoading,
    accountTasksProgress,
    setAccountTasksProgress,
    isAccountTaskRunning,
    setIsAccountTaskRunning,
    showAccountTaskLogs,
    setShowAccountTaskLogs,
    accountTaskHistory,
    setAccountTaskHistory,
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
    sendMediaMessage,
    getConversationMessages,
    markConversationAsRead,
    startNewConversation,
    deleteConversation,
    deleteConversations,
    blockContact,
    blockContacts,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    uploadRecipients,
    startCampaign,
    refreshStats,
    refreshData,
  };

  return (
    <TelegramContext.Provider value={value}>
      {children}
    </TelegramContext.Provider>
  );
};

export const useTelegram = () => {
  const context = useContext(TelegramContext);
  if (!context) {
    throw new Error('useTelegram must be used within a TelegramProvider');
  }
  return context;
};
