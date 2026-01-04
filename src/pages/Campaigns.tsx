import React, { useState, useCallback, useEffect, useRef } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CountdownTimer } from '@/components/ui/countdown-timer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Plus, Play, Pause, Trash2, Edit, Send, Users, CheckCircle, XCircle, 
  Upload, FileText, Loader2, Download, Clock, MessageSquare, Settings,
  AlertCircle, RotateCcw, Eye, TrendingUp, Database, Search
} from 'lucide-react';
import AccountScheduler from '@/components/campaigns/AccountScheduler';
import { format } from 'date-fns';
import { Campaign } from '@/types/telegram';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAppSettings } from '@/hooks/useAppSettings';
import { cn } from '@/lib/utils';

interface ContactData {
  id: string;
  phone_number: string;
  name: string | null;
  username: string | null;
  is_used: boolean;
  tag_id: string | null;
}

interface ContactTag {
  id: string;
  name: string;
}

interface BulkMessageTemplate {
  id: string;
  message: string;
  accountCount: number;
}

interface FailedRecipient {
  phone_number: string;
  name: string | null;
  failed_reason: string | null;
}

interface AccountRecipientStats {
  accountId: string;
  phoneNumber: string;
  firstName: string | null;
  uniqueRecipientsSent: number;  // Unique phone numbers this account has sent to (sent status)
  uniqueRecipientsFailed: number; // Unique phone numbers that failed
  uniqueRecipientsPending: number; // Unique phone numbers still pending
}

interface CampaignReport {
  successful: number;
  failed: number;
  pending: number;
  unused: number;  // Recipients that were never processed (still pending when campaign ended)
  total: number;
  failedRecipients: FailedRecipient[];
  accountStats: AccountRecipientStats[];  // Per-account unique recipient counts
}

interface Seat {
  id: string;
  name: string;
  is_active: boolean;
}

const Campaigns: React.FC = () => {
  const { campaigns, accounts, createCampaign, updateCampaign, deleteCampaign, uploadRecipients, startCampaign, isLoading, refreshData } = useTelegram();
  const { settings: appSettings, updateSettings: updateAppSettings, saveSetting, isLoading: isLoadingSettings } = useAppSettings();
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [recipientText, setRecipientText] = useState('');
  const [isStarting, setIsStarting] = useState<string | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [selectedReportCampaign, setSelectedReportCampaign] = useState<Campaign | null>(null);
  const [campaignReports, setCampaignReports] = useState<Map<string, CampaignReport>>(new Map());
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [accountUniqueRecipients, setAccountUniqueRecipients] = useState<Map<string, number>>(new Map());
  
  // Seats for campaign assignment
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
  
  // Data selection for campaigns
  const [isDataSelectOpen, setIsDataSelectOpen] = useState(false);
  const [contactsData, setContactsData] = useState<ContactData[]>([]);
  const [selectedDataContacts, setSelectedDataContacts] = useState<Set<string>>(new Set());
  const [dataSearchQuery, setDataSearchQuery] = useState('');
  const [dataFilter, setDataFilter] = useState<'all' | 'unused'>('unused');
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [contactTags, setContactTags] = useState<ContactTag[]>([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('all');
  
  // Bulk messaging settings - synced with database via useAppSettings
  const [messageTemplates, setMessageTemplates] = useState<BulkMessageTemplate[]>([
    { id: '1', message: '', accountCount: 10 }
  ]);
  
  // Local state for campaign settings (initialized from DB settings)
  const [messagesPerAccount, setMessagesPerAccount] = useState(10);
  const [messageInterval, setMessageInterval] = useState(5);
  const [accountSwitchDelay, setAccountSwitchDelay] = useState(30);
  const [showScheduler, setShowScheduler] = useState(false);
  const [schedulerSettings, setSchedulerSettings] = useState({
    enabled: true,
    maxMessagesBeforeRotation: 10,
    cooldownDuration: 300, // seconds
    prioritizeHighMaturity: true,
    autoSkipRestricted: true,
    balanceLoad: true
  });
  
  // Sync local settings with database settings when they load
  useEffect(() => {
    if (!isLoadingSettings) {
      setMessagesPerAccount(appSettings.account_limits.messagesPerAccount);
      setMessageInterval(appSettings.message_timing.minDelaySeconds);
      setAccountSwitchDelay(appSettings.message_timing.accountSwitchDelaySeconds);
      setSchedulerSettings({
        enabled: appSettings.scheduler.enabled,
        maxMessagesBeforeRotation: appSettings.scheduler.maxMessagesBeforeRotation,
        cooldownDuration: appSettings.scheduler.cooldownDuration,
        prioritizeHighMaturity: appSettings.scheduler.prioritizeHighMaturity,
        autoSkipRestricted: appSettings.scheduler.autoSkipRestricted,
        balanceLoad: appSettings.scheduler.balanceLoad,
      });
    }
  }, [isLoadingSettings, appSettings]);
  
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    messageTemplate: '',
    recipientCount: 0,
    accountIds: [] as string[],
    recipientsText: '' // Recipients input during creation
  });

  // Fetch campaign reports + auto-sync pending recipients based on already-sent messages
  // Use a ref to prevent stale closures and avoid re-creating the callback
  const campaignsRef = React.useRef(campaigns);
  campaignsRef.current = campaigns;
  
  const accountsRef = React.useRef(accounts);
  accountsRef.current = accounts;

  // FAST: Fetch only basic counts for all campaigns in parallel
  const fetchReports = useCallback(async () => {
    const currentCampaigns = campaignsRef.current;
    if (currentCampaigns.length === 0) return;
    
    const newReports = new Map<string, CampaignReport>();
    
    // Fetch all campaign recipients in PARALLEL (not sequentially!)
    const results = await Promise.all(
      currentCampaigns.map(async (campaign) => {
        const { data: recipients, error } = await supabase
          .from('campaign_recipients')
          .select('id, status, sent_by_account_id')
          .eq('campaign_id', campaign.id);

        if (!recipients || error) return { campaignId: campaign.id, report: null, campaign };

        const sentCount = recipients.filter((r) => r.status === 'sent').length;
        const failedCount = recipients.filter((r) => r.status === 'failed').length;
        const pendingCount = recipients.filter((r) => r.status === 'pending' || r.status === 'sending').length;

        // Basic report without detailed failure info (loaded on-demand)
        const report: CampaignReport = {
          successful: sentCount,
          failed: failedCount,
          pending: pendingCount,
          unused: pendingCount,
          total: recipients.length,
          failedRecipients: [],
          accountStats: []
        };

        return { campaignId: campaign.id, report, recipients, sentCount, failedCount, pendingCount, campaign };
      })
    );

    // Process results and update state
    let needsRefresh = false;
    const updatePromises: Promise<any>[] = [];
    
    for (const result of results) {
      if (!result.report) continue;
      newReports.set(result.campaignId, result.report);
      
      const campaign = result.campaign;
      if (campaign && result.recipients) {
        const countsMatch = 
          campaign.sentCount === result.sentCount && 
          campaign.failedCount === result.failedCount &&
          campaign.recipientCount === result.recipients.length;
        
        if (!countsMatch) {
          updatePromises.push(
            (async () => {
              await supabase
                .from('campaigns')
                .update({ 
                  sent_count: result.sentCount, 
                  failed_count: result.failedCount,
                  recipient_count: result.recipients.length,
                  updated_at: new Date().toISOString() 
                })
                .eq('id', result.campaignId);
            })()
          );
          needsRefresh = true;
        }
        
        // Auto-complete running campaigns with no pending
        if (campaign.status === 'running' && result.pendingCount === 0 && result.recipients.length > 0) {
          updatePromises.push(
            (async () => {
              await supabase
                .from('campaigns')
                .update({ status: 'completed', updated_at: new Date().toISOString() })
                .eq('id', result.campaignId);
            })()
          );
          needsRefresh = true;
        }
      }
    }
    
    // Execute all updates in parallel
    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }
    
    setCampaignReports(newReports);
    if (needsRefresh) refreshData();
  }, [refreshData]);

  // DETAILED: Fetch full report for a single campaign (on-demand when dialog opens)
  const fetchSingleCampaignReport = useCallback(async (campaignId: string) => {
    setIsLoadingReport(true);
    const currentAccounts = accountsRef.current;
    
    try {
      const { data: recipients, error } = await supabase
        .from('campaign_recipients')
        .select('id, status, phone_number, name, sent_by_account_id, failed_reason')
        .eq('campaign_id', campaignId);

      if (!recipients || error) {
        setIsLoadingReport(false);
        return;
      }

      // Fetch failed reasons from messages for failed recipients
      let failedRecipients: FailedRecipient[] = [];
      const failedRecipientsData = recipients.filter((r) => r.status === 'failed');
      
      if (failedRecipientsData.length > 0) {
        const { data: failedMessages } = await supabase
          .from('messages')
          .select('failed_reason, campaign_recipient_id')
          .eq('direction', 'outgoing')
          .in('status', ['failed', 'cancelled'])
          .in('campaign_recipient_id', failedRecipientsData.map(r => r.id))
          .limit(100);

        const reasonsByRecipientId = new Map<string, string>();
        (failedMessages || []).forEach((m: any) => {
          if (m.campaign_recipient_id && m.failed_reason) {
            reasonsByRecipientId.set(m.campaign_recipient_id, m.failed_reason);
          }
        });

        failedRecipients = failedRecipientsData.map((r) => ({
          phone_number: r.phone_number,
          name: r.name,
          failed_reason: reasonsByRecipientId.get(r.id) || (r as any).failed_reason || 'Unknown error'
        }));
      }

      const sentCount = recipients.filter((r) => r.status === 'sent').length;
      const failedCount = recipients.filter((r) => r.status === 'failed').length;
      const pendingCount = recipients.filter((r) => r.status === 'pending' || r.status === 'sending').length;
      
      // Calculate per-account stats
      const accountStatsMap = new Map<string, { sent: Set<string>; failed: Set<string>; pending: Set<string> }>();
      recipients.forEach((r) => {
        if (!r.sent_by_account_id) return;
        if (!accountStatsMap.has(r.sent_by_account_id)) {
          accountStatsMap.set(r.sent_by_account_id, { sent: new Set(), failed: new Set(), pending: new Set() });
        }
        const stats = accountStatsMap.get(r.sent_by_account_id)!;
        if (r.status === 'sent') stats.sent.add(r.phone_number);
        else if (r.status === 'failed') stats.failed.add(r.phone_number);
        else if (r.status === 'pending' || r.status === 'sending') stats.pending.add(r.phone_number);
      });
      
      const accountStats: AccountRecipientStats[] = Array.from(accountStatsMap.entries()).map(([accountId, stats]) => {
        const account = currentAccounts.find(a => a.id === accountId);
        return {
          accountId,
          phoneNumber: account?.phoneNumber || 'Unknown',
          firstName: account?.firstName || null,
          uniqueRecipientsSent: stats.sent.size,
          uniqueRecipientsFailed: stats.failed.size,
          uniqueRecipientsPending: stats.pending.size,
        };
      });

      const report: CampaignReport = {
        successful: sentCount,
        failed: failedCount,
        pending: pendingCount,
        unused: pendingCount,
        total: recipients.length,
        failedRecipients,
        accountStats
      };

      setCampaignReports(prev => new Map(prev).set(campaignId, report));
    } finally {
      setIsLoadingReport(false);
    }
  }, []);

  // Fetch reports on mount and when campaigns change
  const campaignsLength = campaigns.length;
  useEffect(() => {
    if (campaignsLength > 0) fetchReports();
  }, [campaignsLength, fetchReports]);

  // Debounced fetch to prevent too many updates
  const debounceTimerRef = useRef<number | null>(null);
  const debouncedFetchReports = useCallback(() => {
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      fetchReports();
    }, 500); // Wait 500ms before fetching to batch multiple updates
  }, [fetchReports]);

  // Real-time subscriptions for campaign_recipients and campaigns for live updates
  useEffect(() => {
    if (campaignsLength === 0) return;
    
    // Subscribe to campaign_recipients changes for instant progress updates
    // This is the primary source of truth for campaign progress
    const recipientsChannel = supabase
      .channel('campaign-recipients-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'campaign_recipients'
        },
        () => {
          debouncedFetchReports();
        }
      )
      .subscribe();

    // Subscribe to campaigns table for status changes only
    const campaignsChannel = supabase
      .channel('campaigns-page-realtime')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'campaigns'
        },
        () => {
          debouncedFetchReports();
        }
      )
      .subscribe();

    // Fallback polling every 30 seconds (reduced since realtime handles most updates)
    const interval = window.setInterval(() => {
      fetchReports();
    }, 30000);

    return () => {
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
      }
      supabase.removeChannel(recipientsChannel);
      supabase.removeChannel(campaignsChannel);
      window.clearInterval(interval);
    };
  }, [campaignsLength, debouncedFetchReports, fetchReports]);

  // Fetch unique recipients per account for today (for campaign account selection display)
  const fetchAccountUniqueRecipients = useCallback(async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get all outgoing messages sent today with their conversations (for recipient info)
    const { data: todayMessages } = await supabase
      .from('messages')
      .select('account_id, conversation_id, conversations!inner(recipient_phone)')
      .eq('direction', 'outgoing')
      .in('status', ['sent', 'failed', 'pending'])
      .gte('created_at', today.toISOString());
    
    if (!todayMessages) return;
    
    // Count unique recipients per account
    const accountRecipients = new Map<string, Set<string>>();
    todayMessages.forEach((msg: any) => {
      const phone = msg.conversations?.recipient_phone;
      if (!msg.account_id || !phone) return;
      
      if (!accountRecipients.has(msg.account_id)) {
        accountRecipients.set(msg.account_id, new Set());
      }
      accountRecipients.get(msg.account_id)!.add(phone);
    });
    
    // Convert to count map
    const countMap = new Map<string, number>();
    accountRecipients.forEach((phones, accountId) => {
      countMap.set(accountId, phones.size);
    });
    
    setAccountUniqueRecipients(countMap);
  }, []);

  useEffect(() => {
    fetchAccountUniqueRecipients();
    // Refresh every 30 seconds
    const interval = setInterval(fetchAccountUniqueRecipients, 30000);
    return () => clearInterval(interval);
  }, [fetchAccountUniqueRecipients]);

  // Fetch seats for campaign assignment
  const fetchSeats = useCallback(async () => {
    const { data } = await supabase.from('seats').select('id, name, is_active').eq('is_active', true);
    setSeats(data || []);
  }, []);

  useEffect(() => {
    fetchSeats();
  }, [fetchSeats]);

  // Fetch contact tags
  const fetchContactTags = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('contact_tags')
        .select('id, name')
        .order('name', { ascending: true });

      if (error) throw error;
      setContactTags(data || []);
    } catch (error) {
      console.error('Error fetching tags:', error);
    }
  }, []);

  // Fetch contacts data for selection
  const fetchContactsData = useCallback(async () => {
    setIsLoadingData(true);
    try {
      const { data, error } = await supabase
        .from('contacts_data')
        .select('id, phone_number, name, username, is_used, tag_id')
        .eq('is_blocked', false)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setContactsData(data || []);
    } catch (error) {
      console.error('Error fetching contacts:', error);
      toast.error('Failed to load contacts data');
    } finally {
      setIsLoadingData(false);
    }
  }, []);

  // Handle opening data selection dialog
  const handleOpenDataSelect = () => {
    fetchContactTags();
    fetchContactsData();
    setSelectedDataContacts(new Set());
    setDataSearchQuery('');
    setSelectedTagFilter('all');
    setIsDataSelectOpen(true);
  };

  // Add selected contacts from data to campaign recipients
  const handleAddFromData = () => {
    if (selectedDataContacts.size === 0) {
      toast.error('Please select at least one contact');
      return;
    }

    const selectedContacts = contactsData.filter(c => selectedDataContacts.has(c.id));
    const newLines = selectedContacts.map(c => {
      const identifier = c.username ? `@${c.username.replace('@', '')}` : c.phone_number;
      return c.name ? `${identifier},${c.name}` : identifier;
    });

    // Append to existing recipients
    const currentLines = newCampaign.recipientsText.split('\n').filter(l => l.trim());
    const allLines = [...currentLines, ...newLines];
    setNewCampaign(prev => ({ ...prev, recipientsText: allLines.join('\n') }));
    
    toast.success(`Added ${selectedContacts.length} contacts from Data`);
    setIsDataSelectOpen(false);
  };

  // Filter contacts for data selection
  const filteredDataContacts = contactsData.filter(c => {
    // First filter by tag
    if (selectedTagFilter !== 'all' && c.tag_id !== selectedTagFilter) {
      return false;
    }
    
    const matchesSearch = 
      c.phone_number.includes(dataSearchQuery) ||
      c.name?.toLowerCase().includes(dataSearchQuery.toLowerCase()) ||
      c.username?.toLowerCase().includes(dataSearchQuery.toLowerCase());
    
    if (dataFilter === 'unused') return matchesSearch && !c.is_used;
    return matchesSearch;
  });

  // Stats based on current tag filter
  const tagFilteredContacts = selectedTagFilter === 'all' 
    ? contactsData 
    : contactsData.filter(c => c.tag_id === selectedTagFilter);
  
  const dataStats = {
    total: tagFilteredContacts.length,
    unused: tagFilteredContacts.filter(c => !c.is_used).length
  };

  // Fetch data stats when create dialog opens
  useEffect(() => {
    if (isCreateOpen && contactsData.length === 0) {
      fetchContactsData();
    }
  }, [isCreateOpen, contactsData.length, fetchContactsData]);

  const handleCreateCampaign = async () => {
    if (!newCampaign.name) {
      toast.error('Please enter a campaign name');
      return;
    }
    
    // Collect all message templates
    const allMessages = messageTemplates.filter(t => t.message.trim()).map(t => t.message);
    if (allMessages.length === 0) {
      toast.error('Please enter at least one message');
      return;
    }
    
    // Parse recipients from the text input
    const recipientLines = newCampaign.recipientsText.split('\n').filter(l => l.trim());
    const parsedRecipients = recipientLines.map(line => {
      const parts = line.split(/[,\t]/).map(p => p.trim());
      const rawInput = parts[0];
      const { identifier, isUsername } = normalizeRecipient(rawInput);
      return {
        phone_number: identifier, // Can be phone or @username
        name: parts[1] || undefined
      };
    }).filter(r => r.phone_number && r.phone_number.length >= 3); // Min 3 chars for usernames

    if (parsedRecipients.length === 0) {
      toast.error('Please add at least one valid phone number or username');
      return;
    }

    // Use first message as main template, store others in metadata
    const mainMessage = allMessages[0];
    
    // Create the campaign first
    const createdCampaign = await createCampaign({
      name: newCampaign.name,
      messageTemplate: mainMessage,
      recipientCount: parsedRecipients.length,
      accountIds: newCampaign.accountIds
    });
    
    // Upload recipients and set seat_id immediately after campaign creation
    if (createdCampaign) {
      await uploadRecipients(createdCampaign.id, parsedRecipients);
      // Set seat_id on the campaign
      if (selectedSeatId) {
        await supabase.from('campaigns').update({ seat_id: selectedSeatId }).eq('id', createdCampaign.id);
      }
    }
    
    // Settings are now saved to the database when the campaign is started via handleStartCampaign
    // No need to save to localStorage anymore
    
    setNewCampaign({ name: '', messageTemplate: '', recipientCount: 0, accountIds: [], recipientsText: '' });
    setMessageTemplates([{ id: '1', message: '', accountCount: 10 }]);
    setIsCreateOpen(false);
    refreshData();
    
    toast.success('Campaign created! Start it to begin sending.');
  };

  // Normalize recipient - handles phone numbers OR usernames
  const normalizeRecipient = (input: string): { identifier: string; isUsername: boolean } => {
    const trimmed = input.trim();
    
    // Check if it's a username (starts with @ or contains only letters/numbers/underscores)
    if (trimmed.startsWith('@')) {
      return { identifier: trimmed.toLowerCase(), isUsername: true };
    }
    
    // Check if it looks like a username (no digits at start, contains letters)
    const isLikelyUsername = /^[a-zA-Z][a-zA-Z0-9_]{4,}$/.test(trimmed);
    if (isLikelyUsername && !/^\d+$/.test(trimmed)) {
      return { identifier: '@' + trimmed.toLowerCase(), isUsername: true };
    }
    
    // Otherwise treat as phone number - remove all non-digit characters except +
    let normalized = trimmed.replace(/[^\d+]/g, '');
    
    // If it doesn't start with +, add it
    if (normalized && !normalized.startsWith('+')) {
      normalized = '+' + normalized;
    }
    
    return { identifier: normalized, isUsername: false };
  };

  const handleUploadRecipients = useCallback(async () => {
    if (!selectedCampaignId || !recipientText.trim()) {
      toast.error('Please enter recipient phone numbers');
      return;
    }

    const lines = recipientText.split('\n').filter(l => l.trim());
    const recipients = lines.map(line => {
      // Support: phone, username, phone,name formats
      const parts = line.split(/[,\t]/).map(p => p.trim());
      const rawInput = parts[0];
      
      // Normalize - handles both phone numbers and usernames
      const { identifier } = normalizeRecipient(rawInput);
      
      return {
        phone_number: identifier,
        name: parts[1] || undefined // Name is optional - Python will auto-fetch from Telegram
      };
    }).filter(r => r.phone_number && r.phone_number.length >= 3); // Min 3 for usernames

    if (recipients.length === 0) {
      toast.error('No valid phone numbers found');
      return;
    }

    const result = await uploadRecipients(selectedCampaignId, recipients);
    
    // Toast is already shown by context, just close the dialog
    setRecipientText('');
    setIsUploadOpen(false);
    refreshData();
  }, [selectedCampaignId, recipientText, uploadRecipients, refreshData]);

  const handleStartCampaign = async (campaignId: string) => {
    setIsStarting(campaignId);
    
    // Save current settings to database BEFORE starting the campaign
    // This ensures the Python runner uses the exact settings shown in UI
    try {
      await saveSetting('message_timing', {
        minDelaySeconds: messageInterval,
        maxDelaySeconds: Math.max(messageInterval * 2, 15),
        accountSwitchDelaySeconds: accountSwitchDelay,
      });
      await saveSetting('account_limits', {
        ...appSettings.account_limits,
        messagesPerAccount,
      });
      await saveSetting('scheduler', {
        enabled: schedulerSettings.enabled,
        maxMessagesBeforeRotation: schedulerSettings.maxMessagesBeforeRotation,
        cooldownDuration: schedulerSettings.cooldownDuration,
        prioritizeHighMaturity: schedulerSettings.prioritizeHighMaturity,
        autoSkipRestricted: schedulerSettings.autoSkipRestricted,
        balanceLoad: schedulerSettings.balanceLoad,
      });
      console.log('Campaign settings saved to database');
    } catch (error) {
      console.error('Failed to save campaign settings:', error);
    }
    
    await startCampaign(campaignId);
    // Refresh counts quickly after queueing
    await fetchReports();
    setIsStarting(null);
  };

  const handleExportReport = async (campaign: Campaign) => {
    const report = campaignReports.get(campaign.id);
    if (!report) return;
    
    // Fetch detailed recipients
    const { data: recipients, error } = await supabase
      .from('campaign_recipients')
      .select('*')
      .eq('campaign_id', campaign.id);
    
    if (error) {
      toast.error('Failed to fetch report data');
      return;
    }
    
    // Create CSV
    const csvLines = ['Phone Number,Name,Status,Sent At,Sent By Account'];
    recipients?.forEach((r: any) => {
      csvLines.push(`${r.phone_number},${r.name || ''},${r.status},${r.sent_at || ''},${r.sent_by_account_id || ''}`);
    });
    
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign_${campaign.name}_report.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success('Report exported');
  };

  const getStatusColor = (status: Campaign['status']) => {
    switch (status) {
      case 'running': return 'bg-status-active text-status-active-foreground';
      case 'paused': return 'bg-status-warning text-status-warning-foreground';
      case 'completed': return 'bg-primary/20 text-primary';
      case 'failed': return 'bg-status-error text-status-error-foreground';
      case 'draft': return 'bg-muted text-muted-foreground';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const handleStatusToggle = (campaign: Campaign) => {
    if (campaign.status === 'running') {
      updateCampaign(campaign.id, { status: 'paused' });
    } else if (campaign.status === 'paused' || campaign.status === 'draft') {
      handleStartCampaign(campaign.id);
    }
  };

  const handleAccountToggle = (accountId: string) => {
    setNewCampaign(prev => ({
      ...prev,
      accountIds: prev.accountIds.includes(accountId)
        ? prev.accountIds.filter(id => id !== accountId)
        : [...prev.accountIds, accountId]
    }));
  };

  const addMessageTemplate = () => {
    if (messageTemplates.length >= 10) {
      toast.error('Maximum 10 message templates allowed');
      return;
    }
    setMessageTemplates(prev => [
      ...prev,
      { id: String(Date.now()), message: '', accountCount: 10 }
    ]);
  };

  const removeMessageTemplate = (id: string) => {
    if (messageTemplates.length <= 1) return;
    setMessageTemplates(prev => prev.filter(t => t.id !== id));
  };

  const updateMessageTemplate = (id: string, field: 'message' | 'accountCount', value: string | number) => {
    setMessageTemplates(prev => prev.map(t => 
      t.id === id ? { ...t, [field]: value } : t
    ));
  };

  // Auto-distribute accounts among message templates
  const distributeAccounts = () => {
    const totalAccounts = newCampaign.accountIds.length;
    const perTemplate = Math.ceil(totalAccounts / messageTemplates.length);
    
    setMessageTemplates(prev => prev.map((t, i) => ({
      ...t,
      accountCount: Math.min(perTemplate, totalAccounts - (i * perTemplate))
    })));
  };

  // Filter out accounts that have a future restricted_until (temporarily restricted)
  // These can still chat with existing contacts but CANNOT be used for campaigns (new contacts = ban risk)
  const now = new Date();
  const isTemporarilyRestricted = (account: typeof accounts[0]) => {
    return account.restrictedUntil && new Date(account.restrictedUntil) > now;
  };
  
  // Check if account is spambot limited (should not be used for campaigns)
  const isSpambotLimited = (account: typeof accounts[0]) => {
    return account.spambotStatus === 'limited' || account.spambotStatus === 'restricted';
  };

  // For campaigns: only active accounts that are NOT temporarily restricted AND NOT spambot limited
  const campaignEligibleAccounts = accounts.filter(
    (a) => a.status === 'active' && !isTemporarilyRestricted(a) && !isSpambotLimited(a)
  );
  
  // All restricted accounts combined into one list (for unified display)
  const allRestrictedAccounts = accounts.filter(
    (a) => 
      (a.status === 'active' && isTemporarilyRestricted(a)) || // Active with timer
      (a.status === 'active' && isSpambotLimited(a)) || // Active but spambot limited
      a.status === 'restricted' || // Status restricted
      a.status === 'cooldown' // Status cooldown
  );

  // Legacy naming kept for backward compat in UI
  const warmedUpAccounts = campaignEligibleAccounts;
  const warmingAccounts: typeof accounts = []; // No warmup restriction
  const activeAccounts = accounts.filter(a => a.status === 'active');

  return (
    <DashboardLayout>
      <PageHeader
        title="Bulk Messaging System"
        description="Create and manage bulk messaging campaigns with multiple message templates"
        action={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                New Campaign
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Bulk Messaging Campaign</DialogTitle>
                <DialogDescription>
                  Configure multiple message templates and distribute across accounts
                </DialogDescription>
              </DialogHeader>
              
              <Tabs defaultValue="recipients" className="mt-4">
                <TabsList className="grid w-full grid-cols-5">
                  <TabsTrigger value="recipients">1. Recipients</TabsTrigger>
                  <TabsTrigger value="messages">2. Messages</TabsTrigger>
                  <TabsTrigger value="accounts">3. Accounts</TabsTrigger>
                  <TabsTrigger value="scheduler">4. Scheduler</TabsTrigger>
                  <TabsTrigger value="settings">5. Settings</TabsTrigger>
                </TabsList>

                {/* STEP 1: Recipients - Ask for data FIRST */}
                <TabsContent value="recipients" className="space-y-4 mt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Campaign Name</Label>
                      <Input
                        placeholder="Enter campaign name"
                        value={newCampaign.name}
                        onChange={(e) => setNewCampaign(prev => ({ ...prev, name: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Assign to Seat (Worker)</Label>
                      <Select value={selectedSeatId || 'none'} onValueChange={(v) => setSelectedSeatId(v === 'none' ? null : v)}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a seat (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No seat (admin only)</SelectItem>
                          {seats.map(seat => (
                            <SelectItem key={seat.id} value={seat.id}>{seat.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">Conversations will appear in this seat's chat</p>
                    </div>
                  </div>
                  
                  <div className="p-4 rounded-lg bg-accent/30 border border-border">
                    <p className="text-xs font-semibold text-muted-foreground mb-2">Format (one per line) - Phone OR Username:</p>
                    <pre className="text-xs font-mono text-foreground">
{`+14155551234,John Doe
@telegram_user,Jane Smith
username123
14155550000`}
                    </pre>
                    <p className="text-xs text-muted-foreground mt-2">
                      • Phone numbers: + added automatically if missing<br/>
                      • Usernames: @ added automatically if missing
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Phone Numbers or Telegram Usernames</Label>
                      <Button variant="outline" size="sm" onClick={handleOpenDataSelect}>
                        <Database className="w-4 h-4 mr-2" />
                        Select from Data
                      </Button>
                    </div>
                    <Textarea
                      placeholder={`+14155551234,John Doe\n@telegram_user\nusername123\n14155550000`}
                      value={newCampaign.recipientsText}
                      onChange={(e) => setNewCampaign(prev => ({ ...prev, recipientsText: e.target.value }))}
                      rows={8}
                      className="font-mono text-sm"
                    />
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {newCampaign.recipientsText.split('\n').filter(l => l.trim()).length} recipients
                      </p>
                      {dataStats.unused > 0 && (
                        <p className="text-xs text-primary">
                          You have {dataStats.unused} unused contacts in Data
                        </p>
                      )}
                    </div>
                  </div>
                </TabsContent>
                
                {/* STEP 2: Messages */}
                <TabsContent value="messages" className="space-y-4 mt-4">
                  
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Label>Message Templates ({messageTemplates.length}/10)</Label>
                      <Button variant="outline" size="sm" onClick={addMessageTemplate}>
                        <Plus className="w-4 h-4 mr-1" />
                        Add Message
                      </Button>
                    </div>
                    
                    {messageTemplates.map((template, index) => (
                      <Card key={template.id} className="p-4">
                        <div className="flex items-start gap-4">
                          <Badge variant="outline" className="mt-2">#{index + 1}</Badge>
                          <div className="flex-1 space-y-3">
                            <Textarea
                              placeholder={`Message template ${index + 1}... Use {name} and {phone} for personalization`}
                              value={template.message}
                              onChange={(e) => updateMessageTemplate(template.id, 'message', e.target.value)}
                              rows={3}
                            />
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-2">
                                <Label className="text-xs">Accounts to use:</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  max={100}
                                  value={template.accountCount}
                                  onChange={(e) => updateMessageTemplate(template.id, 'accountCount', parseInt(e.target.value) || 10)}
                                  className="w-20 h-8"
                                />
                              </div>
                            </div>
                          </div>
                          {messageTemplates.length > 1 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeMessageTemplate(template.id)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </Card>
                    ))}
                    
                    <p className="text-xs text-muted-foreground">
                      Use {'{name}'} and {'{phone}'} for personalization. Each template will be sent by different accounts.
                    </p>
                  </div>
                </TabsContent>
                
                <TabsContent value="accounts" className="space-y-4 mt-4">
                  <div className="flex items-center justify-between">
                    <Label>Select Accounts ({newCampaign.accountIds.length} selected)</Label>
                    <Button variant="outline" size="sm" onClick={distributeAccounts}>
                      Auto-Distribute
                    </Button>
                  </div>
                  
                  {warmedUpAccounts.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground border rounded-lg">
                      <p className="font-medium">No active accounts available</p>
                      <p className="text-sm mt-2">Add accounts in the Accounts page first.</p>
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto space-y-2 p-2 border rounded-lg bg-accent/30">
                      <div className="flex items-center gap-2 mb-2">
                        <Checkbox
                          checked={newCampaign.accountIds.length === warmedUpAccounts.length && warmedUpAccounts.length > 0}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setNewCampaign(prev => ({ ...prev, accountIds: warmedUpAccounts.map(a => a.id) }));
                            } else {
                              setNewCampaign(prev => ({ ...prev, accountIds: [] }));
                            }
                          }}
                        />
                        <label className="text-sm font-medium">Select All Active ({warmedUpAccounts.length})</label>
                      </div>
                      {warmedUpAccounts.map(account => {
                        const daysSinceCreation = Math.floor((now.getTime() - new Date(account.createdAt).getTime()) / (1000 * 60 * 60 * 24));
                        const uniqueRecipientsToday = accountUniqueRecipients.get(account.id) || 0;
                        return (
                          <div key={account.id} className="flex items-center gap-2">
                            <Checkbox
                              id={account.id}
                              checked={newCampaign.accountIds.includes(account.id)}
                              onCheckedChange={() => handleAccountToggle(account.id)}
                            />
                            <label htmlFor={account.id} className="text-sm cursor-pointer flex-1">
                              {account.firstName || account.phoneNumber} 
                              <span className="text-muted-foreground ml-1">
                                ({account.phoneNumber}) - {uniqueRecipientsToday}/{account.dailyLimit} recipients today • {daysSinceCreation}d old
                              </span>
                            </label>
                          </div>
                        );
                      })}
                      
                    </div>
                  )}

                  {/* Show all restricted accounts in one unified section */}
                  {allRestrictedAccounts.length > 0 && (
                    <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5" />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-yellow-600">
                            {allRestrictedAccounts.length} Account(s) Restricted
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            These accounts cannot be used for new campaigns. They can still reply to existing conversations.
                          </p>
                          <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                            {allRestrictedAccounts.map((acc) => {
                              // Determine reason for restriction
                              const reason = acc.status === 'restricted' || acc.status === 'cooldown' 
                                ? acc.status 
                                : isSpambotLimited(acc) 
                                  ? acc.spambotStatus 
                                  : 'cooldown';
                              
                              return (
                                <div key={acc.id} className="flex items-center justify-between text-xs text-yellow-600 bg-yellow-500/5 rounded px-2 py-1">
                                  <span>• {acc.firstName || acc.phoneNumber} <span className="text-yellow-500/70">({reason})</span></span>
                                  {acc.restrictedUntil && new Date(acc.restrictedUntil) > now && (
                                    <CountdownTimer 
                                      targetDate={new Date(acc.restrictedUntil)} 
                                      className="text-yellow-600"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {newCampaign.accountIds.length > 0 && messageTemplates.length > 1 && (
                    <div className="p-4 rounded-lg bg-accent/50 border">
                      <h4 className="text-sm font-medium mb-2">Account Distribution</h4>
                      <p className="text-xs text-muted-foreground">
                        {newCampaign.accountIds.length} accounts will be distributed across {messageTemplates.length} message templates:
                      </p>
                      <ul className="mt-2 space-y-1">
                        {messageTemplates.map((t, i) => (
                          <li key={t.id} className="text-xs">
                            Message #{i + 1}: {t.accountCount} account(s)
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="scheduler" className="mt-4">
                  <AccountScheduler
                    accounts={accounts}
                    selectedAccountIds={newCampaign.accountIds}
                    onAccountRotation={(accountId) => {
                      console.log('Rotated to account:', accountId);
                    }}
                    onSettingsChange={(newSettings) => setSchedulerSettings(newSettings)}
                    accountUniqueRecipients={accountUniqueRecipients}
                    initialSettings={schedulerSettings}
                  />
                </TabsContent>
                
                <TabsContent value="settings" className="space-y-6 mt-4">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Messages per Account per Day</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          value={[messagesPerAccount]}
                          onValueChange={([v]) => setMessagesPerAccount(v)}
                          min={1}
                          max={25}
                          step={1}
                          className="flex-1"
                        />
                        <span className="w-12 text-center font-medium">{messagesPerAccount}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Recommended: 5-10 messages per account per day to avoid restrictions
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Delay Between Messages (seconds)</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          value={[messageInterval]}
                          onValueChange={([v]) => setMessageInterval(v)}
                          min={1}
                          max={120}
                          step={1}
                          className="flex-1"
                        />
                        <span className="w-12 text-center font-medium">{messageInterval}s</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Wait time between each message. Lower = faster but higher risk.
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Account Switch Delay (seconds)</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          value={[accountSwitchDelay]}
                          onValueChange={([v]) => setAccountSwitchDelay(v)}
                          min={1}
                          max={120}
                          step={1}
                          className="flex-1"
                        />
                        <span className="w-12 text-center font-medium">{accountSwitchDelay}s</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Wait time before switching to the next account
                      </p>
                    </div>
                  </div>
                  
                  <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-5 h-5 text-yellow-600 mt-0.5" />
                      <div>
                        <h4 className="text-sm font-medium text-yellow-600">Important</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                          These settings help avoid Telegram restrictions. Lower values = faster but higher risk.
                        </p>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              <div className="flex justify-end gap-2 pt-4 border-t mt-4">
                <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateCampaign} disabled={!newCampaign.name || !newCampaign.recipientsText.trim()}>
                  Create Campaign
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        }
      />

      {/* Upload Recipients Dialog */}
      <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Recipients</DialogTitle>
            <DialogDescription>
              Add phone numbers to your campaign
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="p-4 rounded-lg bg-accent/30 border border-border">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Format (one per line):</p>
              <pre className="text-xs font-mono text-foreground">
{`+14155551234,John Doe
+14155559876,Jane Smith
+14155550000`}
              </pre>
            </div>

            <div className="space-y-2">
              <Label>Phone Numbers</Label>
              <Textarea
                placeholder="+14155551234,Name (optional)&#10;+14155559876,Another Name&#10;..."
                value={recipientText}
                onChange={(e) => setRecipientText(e.target.value)}
                rows={8}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {recipientText.split('\n').filter(l => l.trim()).length} recipients
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsUploadOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleUploadRecipients}>
                <Upload className="w-4 h-4 mr-2" />
                Upload Recipients
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Report Dialog */}
      <Dialog open={isReportOpen} onOpenChange={setIsReportOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Campaign Report: {selectedReportCampaign?.name}</DialogTitle>
          </DialogHeader>
          {selectedReportCampaign && (
            <div className="space-y-4 pt-4">
              {(() => {
                const report = campaignReports.get(selectedReportCampaign.id);
                if (isLoadingReport || !report || report.failedRecipients.length === 0 && report.failed > 0) {
                  return (
                    <div className="flex items-center justify-center py-8 gap-3">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                      <p className="text-muted-foreground">Loading report details...</p>
                    </div>
                  );
                }
                
                return (
                  <>
                      <div className="grid grid-cols-4 gap-3">
                      <div className="text-center p-3 rounded-lg bg-muted">
                        <p className="text-2xl font-bold">{report.total}</p>
                        <p className="text-xs text-muted-foreground">Total</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-green-500/10">
                        <p className="text-2xl font-bold text-green-600">{report.successful}</p>
                        <p className="text-xs text-muted-foreground">Sent</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-destructive/10">
                        <p className="text-2xl font-bold text-destructive">{report.failed}</p>
                        <p className="text-xs text-muted-foreground">Failed</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-yellow-500/10">
                        <p className="text-2xl font-bold text-yellow-600">{report.pending}</p>
                        <p className="text-xs text-muted-foreground">Pending</p>
                      </div>
                    </div>
                    
                    {report.total > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span>Progress</span>
                          <span>{Math.round(((report.successful + report.failed) / report.total) * 100)}%</span>
                        </div>
                        <Progress value={((report.successful + report.failed) / report.total) * 100} />
                      </div>
                    )}
                    
                    {/* Failed Recipients List */}
                    {report.failedRecipients.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-sm font-medium flex items-center gap-2">
                          <XCircle className="w-4 h-4 text-destructive" />
                          Failed Recipients ({report.failedRecipients.length})
                        </h4>
                        <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
                          {report.failedRecipients.map((recipient, idx) => (
                            <div key={idx} className="p-3 text-sm">
                              <div className="flex justify-between items-start">
                                <div>
                                  <p className="font-medium">{recipient.name || recipient.phone_number}</p>
                                  {recipient.name && (
                                    <p className="text-xs text-muted-foreground">{recipient.phone_number}</p>
                                  )}
                                </div>
                              </div>
                              <p className="text-xs text-destructive mt-1 bg-destructive/10 px-2 py-1 rounded">
                                {recipient.failed_reason}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    <Button 
                      variant="outline" 
                      className="w-full"
                      onClick={() => handleExportReport(selectedReportCampaign)}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Export CSV Report
                    </Button>
                  </>
                );
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Data Selection Dialog */}
      <Dialog open={isDataSelectOpen} onOpenChange={setIsDataSelectOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Select Contacts from Data
            </DialogTitle>
            <DialogDescription>
              Choose contacts to add to your campaign. {dataStats.unused} unused contacts available.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Tag Filter - First Step */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">1. Select Tag</Label>
              <Select value={selectedTagFilter} onValueChange={setSelectedTagFilter}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a tag..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{contactsData.length}</Badge>
                      All Tags
                    </div>
                  </SelectItem>
                  {contactTags.map((tag) => {
                    const tagContacts = contactsData.filter(c => c.tag_id === tag.id);
                    const unusedCount = tagContacts.filter(c => !c.is_used).length;
                    return (
                      <SelectItem key={tag.id} value={tag.id}>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="bg-primary/20 text-primary">{unusedCount}</Badge>
                          {tag.name}
                          <span className="text-muted-foreground text-xs">({tagContacts.length} total)</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {/* Search and Status Filters */}
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search contacts..."
                  value={dataSearchQuery}
                  onChange={(e) => setDataSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={dataFilter} onValueChange={(v) => setDataFilter(v as 'all' | 'unused')}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unused">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="bg-primary/20 text-primary">{dataStats.unused}</Badge>
                      Unused
                    </div>
                  </SelectItem>
                  <SelectItem value="all">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{dataStats.total}</Badge>
                      All
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Selection actions */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={selectedDataContacts.size === filteredDataContacts.length && filteredDataContacts.length > 0}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSelectedDataContacts(new Set(filteredDataContacts.map(c => c.id)));
                    } else {
                      setSelectedDataContacts(new Set());
                    }
                  }}
                />
                <span className="text-sm text-muted-foreground">
                  Select All ({filteredDataContacts.length})
                </span>
              </div>
              <Badge variant="outline" className={cn(selectedDataContacts.size > 0 && "bg-primary/10 text-primary border-primary/30")}>
                {selectedDataContacts.size} selected
              </Badge>
            </div>

            {/* Contacts list */}
            <ScrollArea className="h-[300px] border rounded-lg">
              {isLoadingData ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : filteredDataContacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Database className="w-8 h-8 mb-2" />
                  <p className="text-sm">No contacts found</p>
                  <p className="text-xs">Add contacts in the Data page first</p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredDataContacts.map((contact) => (
                    <div
                      key={contact.id}
                      className={cn(
                        "flex items-center gap-3 p-3 hover:bg-accent/50 cursor-pointer transition-colors",
                        selectedDataContacts.has(contact.id) && "bg-primary/5"
                      )}
                      onClick={() => {
                        const newSet = new Set(selectedDataContacts);
                        if (newSet.has(contact.id)) {
                          newSet.delete(contact.id);
                        } else {
                          newSet.add(contact.id);
                        }
                        setSelectedDataContacts(newSet);
                      }}
                    >
                      <Checkbox
                        checked={selectedDataContacts.has(contact.id)}
                        onCheckedChange={() => {}}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {contact.name || contact.phone_number}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {contact.username ? `@${contact.username.replace('@', '')}` : contact.phone_number}
                          {contact.name && ` • ${contact.phone_number}`}
                        </p>
                      </div>
                      {contact.is_used ? (
                        <Badge variant="secondary" className="text-xs">Used</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs bg-primary/10 text-primary">Unused</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDataSelectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddFromData} disabled={selectedDataContacts.size === 0}>
              <Plus className="w-4 h-4 mr-2" />
              Add {selectedDataContacts.size} Contact{selectedDataContacts.size !== 1 ? 's' : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Send className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-medium mb-2">No Campaigns Yet</h3>
                <p className="text-muted-foreground mb-4">
                  Create your first campaign to start bulk messaging
                </p>
                <Button onClick={() => setIsCreateOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Campaign
                </Button>
              </CardContent>
            </Card>
          ) : (
            campaigns.map((campaign) => {
              const report = campaignReports.get(campaign.id);

              // Check if this campaign has usable accounts (not temp restricted, under daily limit)
              const assignedAccountIds = campaign.accountIds || [];
              const usableAssigned = assignedAccountIds.filter((accId) => {
                const acc = accounts.find((a) => a.id === accId);
                if (!acc) return false;
                if (acc.status !== 'active') return false;
                if (acc.restrictedUntil && new Date(acc.restrictedUntil) > now) return false;
                if ((acc.messagesSentToday ?? 0) >= (acc.dailyLimit ?? 25)) return false;
                return true;
              });

              const hasPending = (report?.pending ?? 0) > 0;
              const noUsableAccounts = usableAssigned.length === 0 && assignedAccountIds.length > 0;
              const campaignStuck = campaign.status === 'running' && hasPending && noUsableAccounts;
              
              // Check if campaign failed due to no usable accounts (has pending but failed status)
              const campaignFailedDueToAccounts = campaign.status === 'failed' && hasPending;
              
              // Get seat name for this campaign
              const campaignSeat = seats.find(s => s.id === campaign.seatId);
              const seatName = campaignSeat?.name;
              
              return (
                <Card
                  key={campaign.id}
                  className={cn(
                    "group relative overflow-hidden transition-all duration-300 hover:shadow-lg hover:shadow-primary/5",
                    campaignStuck || campaignFailedDueToAccounts
                      ? "border-border/60 bg-card"
                      : "hover:border-primary/40",
                  )}
                >
                  {/* Status indicator line at top */}
                  <div
                    className={cn(
                      "absolute top-0 left-0 right-0 h-1",
                      campaign.status === "running"
                        ? "bg-gradient-to-r from-primary via-primary/80 to-primary animate-pulse"
                        : campaign.status === "completed"
                          ? "bg-gradient-to-r from-primary/70 to-primary/40"
                          : campaign.status === "failed"
                            ? "bg-gradient-to-r from-destructive/80 to-destructive/50"
                            : campaign.status === "paused"
                              ? "bg-gradient-to-r from-muted-foreground/40 to-muted-foreground/20"
                              : "bg-gradient-to-r from-muted to-muted-foreground/20",
                    )}
                  />
                  
                  <CardContent className="p-5 pt-6">
                    <div className="flex items-center justify-between gap-4">
                      {/* Left Section - Name & Status */}
                      <div className="flex items-center gap-4 min-w-0 flex-1">
                        {/* Status Icon */}
                        <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${
                          campaign.status === 'running' 
                            ? 'bg-primary/15 text-primary' 
                            : campaign.status === 'completed' 
                              ? 'bg-green-500/15 text-green-600' 
                              : campaign.status === 'failed' 
                                ? 'bg-destructive/15 text-destructive' 
                                : campaign.status === 'paused'
                                  ? 'bg-yellow-500/15 text-yellow-600'
                                  : 'bg-muted text-muted-foreground'
                        }`}>
                          {campaign.status === 'running' && <Play className="w-5 h-5" />}
                          {campaign.status === 'completed' && <CheckCircle className="w-5 h-5" />}
                          {campaign.status === 'failed' && <XCircle className="w-5 h-5" />}
                          {campaign.status === 'paused' && <Pause className="w-5 h-5" />}
                          {campaign.status === 'draft' && <FileText className="w-5 h-5" />}
                        </div>
                        
                        <div className="min-w-0 flex-1">
                          <h3 className="font-semibold text-base group-hover:text-primary transition-colors break-words">{campaign.name}</h3>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className={`text-xs font-medium uppercase tracking-wider ${
                              campaign.status === 'running' 
                                ? 'text-primary' 
                                : campaign.status === 'completed' 
                                  ? 'text-green-600' 
                                  : campaign.status === 'failed' 
                                    ? 'text-destructive' 
                                    : campaign.status === 'paused'
                                      ? 'text-yellow-600'
                                      : 'text-muted-foreground'
                            }`}>
                              {campaign.status}
                            </span>
                            {seatName && (
                              <>
                                <span className="text-muted-foreground">•</span>
                                <span className="text-xs text-muted-foreground">{seatName}</span>
                              </>
                            )}
                            {campaignStuck && (
                              <span className="text-xs text-destructive flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" />
                                Stuck
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      {/* Center Section - Stats */}
                      <div className="hidden md:flex items-center gap-6 shrink-0">
                        {(() => {
                          const total = report?.total || campaign.recipientCount || 0;
                          const sent = report?.successful ?? campaign.sentCount ?? 0;
                          const failed = report?.failed ?? campaign.failedCount ?? 0;
                          const percent = total > 0 ? Math.round((sent / total) * 100) : 0;
                          
                          return (
                            <>
                              <div className="text-center px-3">
                                <p className="text-lg font-bold text-foreground">{total}</p>
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</p>
                              </div>
                              <div className="w-px h-8 bg-border" />
                              <div className="text-center px-3">
                                <p className="text-lg font-bold text-primary">{sent}</p>
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sent</p>
                              </div>
                              <div className="w-px h-8 bg-border" />
                              <div className="text-center px-3">
                                <p className="text-lg font-bold text-destructive">{failed}</p>
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Failed</p>
                              </div>
                              <div className="w-px h-8 bg-border" />
                              <div className="text-center px-4 py-1 rounded-lg bg-muted/50">
                                <p className="text-xl font-bold text-foreground">{percent}%</p>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                      
                      {/* Right Section - Actions */}
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-9 px-3 gap-2 text-muted-foreground hover:text-foreground">
                              <Eye className="w-4 h-4" />
                              <span className="hidden lg:inline text-xs">Details</span>
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                            <DialogHeader className="pb-4 border-b">
                              <div className="flex items-center gap-3">
                                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                                  campaign.status === 'running' 
                                    ? 'bg-primary/15 text-primary' 
                                    : campaign.status === 'completed' 
                                      ? 'bg-green-500/15 text-green-600' 
                                      : campaign.status === 'failed' 
                                        ? 'bg-destructive/15 text-destructive' 
                                        : 'bg-muted text-muted-foreground'
                                }`}>
                                  {campaign.status === 'running' && <Play className="w-6 h-6" />}
                                  {campaign.status === 'completed' && <CheckCircle className="w-6 h-6" />}
                                  {campaign.status === 'failed' && <XCircle className="w-6 h-6" />}
                                  {campaign.status === 'paused' && <Pause className="w-6 h-6" />}
                                  {campaign.status === 'draft' && <FileText className="w-6 h-6" />}
                                </div>
                                <div>
                                  <DialogTitle className="text-xl">{campaign.name}</DialogTitle>
                                  <DialogDescription className="flex items-center gap-2 mt-1">
                                    <span className={`text-xs font-semibold uppercase tracking-wider ${
                                      campaign.status === 'running' ? 'text-primary' 
                                        : campaign.status === 'completed' ? 'text-green-600' 
                                        : campaign.status === 'failed' ? 'text-destructive' 
                                        : 'text-muted-foreground'
                                    }`}>
                                      {campaign.status}
                                    </span>
                                    <span className="text-muted-foreground">•</span>
                                    <span>Campaign Performance</span>
                                  </DialogDescription>
                                </div>
                              </div>
                            </DialogHeader>
                            
                            <div className="space-y-6 pt-4">
                              {/* Stats Summary */}
                              {(() => {
                                const total = report?.total || campaign.recipientCount || 0;
                                const sent = report?.successful ?? campaign.sentCount ?? 0;
                                const failed = report?.failed ?? campaign.failedCount ?? 0;
                                const pending = report?.pending ?? Math.max(0, total - sent - failed);
                                const successRate = total > 0 ? Math.round((sent / total) * 100) : 0;
                                
                                return (
                                  <div className="grid grid-cols-5 gap-3">
                                    <div className="bg-muted/40 rounded-xl p-4 text-center border border-border/50">
                                      <Users className="w-5 h-5 mx-auto mb-2 text-muted-foreground" />
                                      <p className="text-2xl font-bold">{total}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Total</p>
                                    </div>
                                    <div className="bg-primary/10 rounded-xl p-4 text-center border border-primary/20">
                                      <Send className="w-5 h-5 mx-auto mb-2 text-primary" />
                                      <p className="text-2xl font-bold text-primary">{sent}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Sent</p>
                                    </div>
                                    <div className="bg-destructive/10 rounded-xl p-4 text-center border border-destructive/20">
                                      <XCircle className="w-5 h-5 mx-auto mb-2 text-destructive" />
                                      <p className="text-2xl font-bold text-destructive">{failed}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Failed</p>
                                    </div>
                                    <div className="bg-muted/30 rounded-xl p-4 text-center border border-border/50">
                                      <Clock className="w-5 h-5 mx-auto mb-2 text-muted-foreground" />
                                      <p className="text-2xl font-bold">{pending > 0 ? pending : 0}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Pending</p>
                                    </div>
                                    <div className="bg-muted/50 rounded-xl p-4 text-center border border-border/50">
                                      <TrendingUp className="w-5 h-5 mx-auto mb-2 text-muted-foreground" />
                                      <p className="text-2xl font-bold">{successRate}%</p>
                                      <p className="text-xs text-muted-foreground mt-1">Success Rate</p>
                                    </div>
                                  </div>
                                );
                              })()}
                              
                              {/* Stop Reason if failed/stuck */}
                              {(campaignStuck || campaignFailedDueToAccounts || campaign.status === 'failed') && (
                                <div className="bg-destructive/10 rounded-xl p-4 border border-destructive/30">
                                  <div className="flex items-start gap-3">
                                    <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                                    <div>
                                      <h4 className="text-sm font-semibold text-destructive mb-1">Campaign Stopped</h4>
                                      <p className="text-sm text-muted-foreground">
                                        {campaignFailedDueToAccounts || campaignStuck 
                                          ? `No usable accounts available. ${report?.pending || 0} messages still pending.`
                                          : 'Campaign failed due to errors during message sending.'
                                        }
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* Message Template */}
                              <div>
                                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                                  <MessageSquare className="w-4 h-4 text-muted-foreground" />
                                  Message Template
                                </h4>
                                <div className="bg-muted/30 px-4 py-3 rounded-xl text-sm whitespace-pre-wrap break-words border border-border/50 max-h-40 overflow-y-auto">
                                  {campaign.messageTemplate}
                                </div>
                              </div>
                              
                              {/* Campaign Settings */}
                              <div>
                                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                                  <Settings className="w-4 h-4 text-muted-foreground" />
                                  Campaign Settings
                                </h4>
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="bg-muted/30 rounded-xl p-3 border border-border/50">
                                    <p className="text-xs text-muted-foreground">Assigned Seat</p>
                                    <p className="font-medium mt-1">{seatName || 'Not assigned'}</p>
                                  </div>
                                  <div className="bg-muted/30 rounded-xl p-3 border border-border/50">
                                    <p className="text-xs text-muted-foreground">Message Delay</p>
                                    <p className="font-medium mt-1">{appSettings.message_timing.minDelaySeconds}s - {appSettings.message_timing.maxDelaySeconds}s</p>
                                  </div>
                                  <div className="bg-muted/30 rounded-xl p-3 border border-border/50">
                                    <p className="text-xs text-muted-foreground">Account Rotation</p>
                                    <p className="font-medium mt-1">Every {appSettings.scheduler.maxMessagesBeforeRotation} msgs</p>
                                  </div>
                                  <div className="bg-muted/30 rounded-xl p-3 border border-border/50">
                                    <p className="text-xs text-muted-foreground">Switch Delay</p>
                                    <p className="font-medium mt-1">{appSettings.message_timing.accountSwitchDelaySeconds}s</p>
                                  </div>
                                </div>
                              </div>
                              
                              {/* Account Performance */}
                              {report?.accountStats && report.accountStats.length > 0 && (
                                <div>
                                  <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                                    <Users className="w-4 h-4 text-muted-foreground" />
                                    Account Performance
                                  </h4>
                                  <div className="space-y-2">
                                    {report.accountStats.map((stat) => (
                                      <div key={stat.accountId} className="flex items-center justify-between bg-muted/30 rounded-xl px-4 py-3 border border-border/50">
                                        <div>
                                          <span className="font-medium">{stat.firstName || 'Unknown'}</span>
                                          <span className="text-xs text-muted-foreground ml-2">{stat.phoneNumber}</span>
                                        </div>
                                        <div className="flex items-center gap-4">
                                          <div className="flex items-center gap-2 text-primary">
                                            <Send className="w-4 h-4" />
                                            <span className="font-semibold">{stat.uniqueRecipientsSent}</span>
                                          </div>
                                          {stat.uniqueRecipientsFailed > 0 && (
                                            <div className="flex items-center gap-2 text-destructive">
                                              <XCircle className="w-4 h-4" />
                                              <span className="font-semibold">{stat.uniqueRecipientsFailed}</span>
                                            </div>
                                          )}
                                          {stat.uniqueRecipientsPending > 0 && (
                                            <div className="flex items-center gap-2 text-muted-foreground">
                                              <Clock className="w-4 h-4" />
                                              <span className="font-semibold">{stat.uniqueRecipientsPending}</span>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              
                              {/* Failed Recipients with Reasons */}
                              {report?.failedRecipients && report.failedRecipients.length > 0 && (
                                <div>
                                  <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                                    <XCircle className="w-4 h-4 text-destructive" />
                                    Failed Recipients ({report.failedRecipients.length})
                                  </h4>
                                  <ScrollArea className="h-[200px] border rounded-xl">
                                    <div className="divide-y">
                                      {report.failedRecipients.map((recipient, idx) => (
                                        <div key={idx} className="p-3">
                                          <div className="flex justify-between items-start">
                                            <div>
                                              <span className="font-medium text-sm">{recipient.name || recipient.phone_number}</span>
                                              {recipient.name && (
                                                <span className="text-xs text-muted-foreground ml-2">{recipient.phone_number}</span>
                                              )}
                                            </div>
                                          </div>
                                          <p className="text-xs text-destructive mt-1 truncate" title={recipient.failed_reason || 'Unknown error'}>
                                            {recipient.failed_reason || 'Unknown error'}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  </ScrollArea>
                                </div>
                              )}
                            </div>
                          </DialogContent>
                        </Dialog>
                        
                        <div className="w-px h-6 bg-border mx-1" />
                        
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => { setSelectedReportCampaign(campaign); setIsReportOpen(true); fetchSingleCampaignReport(campaign.id); }} title="View Report">
                          <MessageSquare className="w-4 h-4" />
                        </Button>
                        
                        <div className="w-px h-6 bg-border mx-1" />
                        
                        <Button 
                          variant={campaign.status === 'running' ? 'secondary' : 'default'}
                          size="sm" 
                          className="h-9 px-3 gap-2"
                          onClick={() => handleStatusToggle(campaign)} 
                          disabled={campaign.status === 'completed' || isStarting === campaign.id}
                        >
                          {isStarting === campaign.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : campaign.status === 'running' ? (
                            <>
                              <Pause className="w-4 h-4" />
                              <span className="hidden lg:inline text-xs">Pause</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-4 h-4" />
                              <span className="hidden lg:inline text-xs">Start</span>
                            </>
                          )}
                        </Button>
                        
                        <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => deleteCampaign(campaign.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Campaigns;
