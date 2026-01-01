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
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import JSZip from 'jszip';

// Minimal mock data - just 2 examples
const initialAccounts: TelegramAccount[] = [];
const initialProxies: Proxy[] = [];
const initialConversations: Conversation[] = [];
const initialMessages: Message[] = [];
const initialCampaigns: Campaign[] = [];

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
  uploadRecipients: (campaignId: string, recipients: { phone_number: string; name?: string }[]) => Promise<{ inserted: number; duplicates: number; duplicateNumbers?: string[] } | undefined>;
  startCampaign: (campaignId: string) => Promise<void>;
  
  // Refresh
  refreshStats: () => void;
  refreshData: () => Promise<void>;
}

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

  // Fetch data from Supabase
  const refreshData = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Fetch accounts
      const { data: accountsData } = await supabase
        .from('telegram_accounts')
        .select('*')
        .order('created_at', { ascending: false });

      if (accountsData) {
        setAccounts(accountsData.map(acc => ({
          id: acc.id,
          phoneNumber: acc.phone_number,
          username: acc.username || undefined,
          firstName: acc.first_name || undefined,
          lastName: acc.last_name || undefined,
          status: acc.status as TelegramAccount['status'],
          proxyId: acc.proxy_id || undefined,
          sessionFile: acc.session_data || undefined,
          createdAt: new Date(acc.created_at),
          lastActive: acc.last_active ? new Date(acc.last_active) : undefined,
          messagesSentToday: acc.messages_sent_today || 0,
          dailyLimit: acc.daily_limit || 25,
          maturityScore: acc.maturity_score || 0,
          maturityDays: acc.maturity_days || 0,
          restrictedUntil: acc.restricted_until ? new Date(acc.restricted_until) : undefined,
          banReason: acc.ban_reason || undefined,
          avatar: acc.avatar_url || undefined,
          // Device fingerprint
          deviceModel: acc.device_model || undefined,
          systemVersion: acc.system_version || undefined,
          appVersion: acc.app_version || undefined,
          langCode: acc.lang_code || undefined,
          systemLangCode: acc.system_lang_code || undefined,
          // Anti-ban features
          warmupPhase: (acc as any).warmup_phase ?? 0,
          warmupStartedAt: (acc as any).warmup_started_at ? new Date((acc as any).warmup_started_at) : undefined,
          spambotStatus: (acc as any).spambot_status || 'unknown',
          phoneCountry: (acc as any).phone_country || undefined,
          geoMismatch: (acc as any).geo_mismatch || false,
          apiCredentialId: (acc as any).api_credential_id || undefined,
        })));
      }

      // Fetch proxies
      const { data: proxiesData } = await supabase
        .from('proxies')
        .select('*')
        .order('created_at', { ascending: false });

      if (proxiesData) {
        setProxies(proxiesData.map(p => ({
          id: p.id,
          host: p.host,
          port: p.port,
          username: p.username || undefined,
          password: p.password || undefined,
          type: p.proxy_type as Proxy['type'],
          status: p.status as Proxy['status'],
          assignedAccountId: p.assigned_account_id || undefined,
          lastChecked: p.last_checked ? new Date(p.last_checked) : undefined,
          responseTime: p.response_time || undefined,
          country: p.country || undefined,
        })));
      }

      // Fetch campaigns
      const { data: campaignsData } = await supabase
        .from('campaigns')
        .select('*, campaign_accounts(account_id)')
        .order('created_at', { ascending: false });

      if (campaignsData) {
        setCampaigns(campaignsData.map(c => ({
          id: c.id,
          name: c.name,
          messageTemplate: c.message_template,
          status: c.status as Campaign['status'],
          scheduledAt: c.scheduled_at ? new Date(c.scheduled_at) : undefined,
          recipientCount: c.recipient_count || 0,
          sentCount: c.sent_count || 0,
          failedCount: c.failed_count || 0,
          replyCount: c.reply_count || 0,
          accountIds: c.campaign_accounts?.map((ca: any) => ca.account_id) || [],
          createdAt: new Date(c.created_at),
          updatedAt: new Date(c.updated_at),
        })));
      }

      // Fetch conversations
      const { data: conversationsData } = await supabase
        .from('conversations')
        .select('*')
        .order('updated_at', { ascending: false });

      if (conversationsData) {
        setConversations(conversationsData.map(c => ({
          id: c.id,
          accountId: c.account_id,
          recipientPhone: c.recipient_phone || '',
          recipientName: c.recipient_name || undefined,
          recipientAvatar: c.recipient_avatar || undefined,
          unreadCount: c.unread_count || 0,
          isActive: c.is_active || false,
          createdAt: new Date(c.created_at),
          updatedAt: new Date(c.updated_at),
          blockedByRecipient: (c as any).blocked_by_recipient || false,
        })));
      }

      // Fetch messages
      const { data: messagesData } = await supabase
        .from('messages')
        .select('*, conversations(recipient_phone)')
        .order('created_at', { ascending: false })
        .limit(500);

      if (messagesData) {
        setMessages(messagesData.map(m => ({
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
          console.log('Message change:', payload);
          
          if (payload.eventType === 'INSERT') {
            const m = payload.new as any;
            // Fetch the conversation to get recipient_phone
            const { data: convData } = await supabase
              .from('conversations')
              .select('recipient_phone')
              .eq('id', m.conversation_id)
              .single();

            const newMessage: Message = {
              id: m.id,
              conversationId: m.conversation_id,
              accountId: m.account_id,
              recipientPhone: convData?.recipient_phone || '',
              content: m.content,
              direction: m.direction as Message['direction'],
              status: m.status as Message['status'],
              timestamp: new Date(m.created_at),
              telegramMessageId: m.telegram_message_id || undefined,
              failedReason: m.failed_reason || undefined,
              mediaUrl: m.media_url || undefined,
              mediaType: m.media_type || undefined,
            };

            setMessages(prev => {
              if (prev.some(msg => msg.id === m.id)) {
                return prev.map(msg => (msg.id === m.id ? newMessage : msg));
              }
              return [newMessage, ...prev];
            });

            // Play notification sound for incoming messages
            if (m.direction === 'incoming') {
              try {
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
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
                }, 100);

                // Show toast notification
                toast.info('New reply received!', {
                  description: m.content?.substring(0, 50) || 'You have a new message',
                });
              } catch (e) {
                console.log('Could not play notification:', e);
              }
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
          console.log('Conversation change:', payload);
          
          if (payload.eventType === 'INSERT') {
            const c = payload.new as any;
            const newConv: Conversation = {
              id: c.id,
              accountId: c.account_id,
              recipientPhone: c.recipient_phone || '',
              recipientName: c.recipient_name || undefined,
              recipientAvatar: c.recipient_avatar || undefined,
              unreadCount: c.unread_count || 0,
              isActive: c.is_active || false,
              createdAt: new Date(c.created_at),
              updatedAt: new Date(c.updated_at || c.created_at),
              blockedByRecipient: c.blocked_by_recipient || false,
            };

            setConversations(prev => {
              if (prev.some(conv => conv.id === c.id)) {
                return prev.map(conv => (conv.id === c.id ? newConv : conv));
              }
              return [newConv, ...prev];
            });
          } else if (payload.eventType === 'UPDATE') {
            const c = payload.new as any;
            setConversations(prev =>
              prev
                .map(conv =>
                  conv.id === c.id
                    ? {
                        ...conv,
                        unreadCount: c.unread_count || 0,
                        updatedAt: new Date(c.updated_at || c.last_message_at || conv.updatedAt),
                        recipientName: c.recipient_name || conv.recipientName,
                        isActive: c.is_active ?? conv.isActive,
                        blockedByRecipient: c.blocked_by_recipient ?? conv.blockedByRecipient,
                      }
                    : conv
                )
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
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
      supabase.removeChannel(campaignsChannel);
    };
  }, [refreshData]);

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

      setUploadProgress(prev => ({
        ...prev,
        total: accountsToUpload.length,
        status: 'processing'
      }));

      if (accountsToUpload.length === 0) {
        setUploadProgress(prev => ({
          ...prev,
          status: 'error',
          errors: ['No valid accounts found in uploaded files']
        }));
        toast.error('No valid accounts found in files');
        return;
      }

      // Send to edge function
      const { data, error } = await supabase.functions.invoke('process-account-upload', {
        body: { accounts: accountsToUpload }
      });

      if (error) throw error;

      setUploadProgress({
        total: accountsToUpload.length,
        processed: accountsToUpload.length,
        successful: data.successful || 0,
        failed: data.failed || 0,
        status: 'completed',
        errors: data.errors || []
      });

      if (data.successful > 0) {
        toast.success(`Successfully uploaded ${data.successful} accounts`);
      }
      if (data.failed > 0) {
        toast.error(`Failed to upload ${data.failed} accounts`);
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
          proxy_type: proxy.type || 'http',
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
      const { data: msgData, error: msgError } = await supabase
        .from('messages')
        .insert({
          account_id: accountId,
          conversation_id: conversationId,
          content,
          direction: 'outgoing',
          status: 'pending', // Python script will pick this up
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
      setMessages(prev => [...prev, newMessage]);
      
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
      // First, get all campaign_recipient IDs for this campaign
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

      // Delete campaign
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

  const uploadRecipients = useCallback(async (campaignId: string, recipients: { phone_number: string; name?: string }[]): Promise<{ inserted: number; duplicates: number; duplicateNumbers?: string[] } | undefined> => {
    try {
      const { data, error } = await supabase.functions.invoke('send-bulk-messages/upload-recipients', {
        body: { campaign_id: campaignId, recipients }
      });

      if (error) throw error;
      
      const result = data as { success: boolean; inserted: number; duplicates: number; duplicateNumbers?: string[]; message?: string };
      
      if (result.duplicates > 0) {
        toast.success(result.message || `Uploaded ${result.inserted} recipients. ${result.duplicates} duplicates skipped.`);
      } else {
        toast.success(`Uploaded ${result.inserted} recipients`);
      }
      
      refreshData();
      return { inserted: result.inserted, duplicates: result.duplicates, duplicateNumbers: result.duplicateNumbers };
    } catch (error) {
      console.error('Error uploading recipients:', error);
      toast.error('Failed to upload recipients');
      return undefined;
    }
  }, [refreshData]);

  const startCampaign = useCallback(async (campaignId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('send-bulk-messages/start-campaign', {
        body: { campaign_id: campaignId }
      });

      if (error) throw error;
      toast.success(data.message || 'Campaign started');
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
      // Mark conversation as blocked (we'll use is_active = false and add to a blocklist)
      const conv = conversations.find(c => c.id === conversationId);
      if (!conv) return;

      // Delete the conversation and its messages (blocking = removing from chat)
      await supabase
        .from('messages')
        .delete()
        .eq('conversation_id', conversationId);

      await supabase
        .from('conversations')
        .delete()
        .eq('id', conversationId);

      toast.success(`Blocked ${conv.recipientName || conv.recipientPhone}`);
      refreshData();
    } catch (error) {
      console.error('Error blocking contact:', error);
      toast.error('Failed to block contact');
    }
  }, [conversations, refreshData]);

  const blockContacts = useCallback(async (conversationIds: string[]) => {
    try {
      // Delete messages first
      await supabase
        .from('messages')
        .delete()
        .in('conversation_id', conversationIds);

      // Delete conversations
      const { error } = await supabase
        .from('conversations')
        .delete()
        .in('id', conversationIds);

      if (error) throw error;
      toast.success(`Blocked ${conversationIds.length} contacts`);
      refreshData();
    } catch (error) {
      console.error('Error blocking contacts:', error);
      toast.error('Failed to block contacts');
    }
  }, [refreshData]);

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
