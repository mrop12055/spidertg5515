import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { useAccounts } from '@/hooks/useAccounts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CountdownTimer } from '@/components/ui/countdown-timer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CreateCampaignDialog } from '@/components/campaigns/CreateCampaignDialog';
import { 
  Plus, Play, Pause, Trash2, Edit, Send, Users, CheckCircle, XCircle, 
  Upload, FileText, Loader2, Download, Clock, MessageSquare, Settings,
  AlertCircle, RotateCcw, Eye, TrendingUp, Database, Search, Megaphone
} from 'lucide-react';

import { format } from 'date-fns';
import * as XLSX from 'xlsx';
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
  sent_by_account_id: string | null;
  sender_phone: string | null;
  sender_name: string | null;
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
  const { campaigns, createCampaign, updateCampaign, deleteCampaign, uploadRecipients, startCampaign, isLoading, refreshData } = useTelegram();
  const { accounts, isLoading: isLoadingAccounts } = useAccounts();
  const { settings: appSettings, updateSettings: updateAppSettings, saveSetting, fetchSettings, isLoading: isLoadingSettings, isSaving } = useAppSettings();
  
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
  
  // Bulk selection state
  const [selectedCampaigns, setSelectedCampaigns] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deletingCampaignId, setDeletingCampaignId] = useState<string | null>(null);
  
  // Track which campaign detail dialogs have loaded their reports
  const [loadedReportIds, setLoadedReportIds] = useState<Set<string>>(new Set());
  
  // Seats for campaign assignment (supports multiple seats)
  const [seats, setSeats] = useState<Seat[]>([]);
  const [seatsLoaded, setSeatsLoaded] = useState(false);
  
  // Memoized seats lookup map to prevent re-renders
  const seatsMap = useMemo(() => {
    const map = new Map<string, string>();
    seats.forEach(s => map.set(s.id, s.name));
    return map;
  }, [seats]);
  
  // Data selection for campaigns
  const [isDataSelectOpen, setIsDataSelectOpen] = useState(false);
  const [contactsData, setContactsData] = useState<ContactData[]>([]);
  const [selectedDataContacts, setSelectedDataContacts] = useState<Set<string>>(new Set());
  const [dataSearchQuery, setDataSearchQuery] = useState('');
  const [dataFilter, setDataFilter] = useState<'all' | 'unused'>('unused');
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [contactTags, setContactTags] = useState<ContactTag[]>([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('all');
  
  // Local state for UI
  const [showSpeedSettings, setShowSpeedSettings] = useState(false);
  
  // Campaign speed settings (local state synced from DB)
  const [campaignSpeed, setCampaignSpeed] = useState({
    staggerMin: 0.3,
    staggerMax: 1.5,
    pollingInterval: 3,
    batchSize: 100,
    messagesPerAccountPerDay: 10,
  });
  
  // Sync campaign speed settings with database settings when they load
  useEffect(() => {
    if (!isLoadingSettings && appSettings.campaign_speed) {
      setCampaignSpeed({
        staggerMin: appSettings.campaign_speed.staggerMin ?? 0.3,
        staggerMax: appSettings.campaign_speed.staggerMax ?? 1.5,
        pollingInterval: appSettings.campaign_speed.pollingInterval ?? 3,
        batchSize: appSettings.campaign_speed.batchSize ?? 100,
        messagesPerAccountPerDay: appSettings.campaign_speed.messagesPerAccountPerDay ?? 10,
      });
    }
  }, [isLoadingSettings, appSettings]);
  
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    messageTemplate: '',
    recipientCount: 0,
    accountIds: [] as string[],
    recipientsText: '', // Recipients input during creation
    batchSize: 50, // Batch size for parallel sends
  });

  // Fetch campaign reports + auto-sync pending recipients based on already-sent messages
  // Use a ref to prevent stale closures and avoid re-creating the callback
  const campaignsRef = React.useRef(campaigns);
  campaignsRef.current = campaigns;
  
  const accountsRef = React.useRef(accounts);
  accountsRef.current = accounts;

  // FAST: Fetch only basic counts for RUNNING campaigns (lightweight refresh every second)
  // This avoids refreshing completed/paused/draft campaigns unnecessarily
  const fetchRunningCampaignStats = useCallback(async () => {
    const currentCampaigns = campaignsRef.current;
    const runningCampaigns = currentCampaigns.filter(c => c.status === 'running');
    
    if (runningCampaigns.length === 0) return;

    const results = await Promise.all(
      runningCampaigns.map(async (campaign) => {
        const [totalRes, sentRes, failedRes, pendingSendingRes, queuedRes] = await Promise.all([
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id),
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', 'sent'),
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', 'failed'),
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).in('status', ['pending', 'sending']),
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', 'queued'),
        ]);

        if (totalRes.error || sentRes.error || failedRes.error) return null;

        const total = totalRes.count || 0;
        const sentCount = sentRes.count || 0;
        const failedCount = failedRes.count || 0;
        const pendingSendingCount = pendingSendingRes.count || 0;
        const queuedCount = queuedRes.count || 0;

        return { campaignId: campaign.id, total, sentCount, failedCount, pendingSendingCount, queuedCount, campaign };
      })
    );

    // Update only the running campaign reports in state
    setCampaignReports((prev) => {
      const updated = new Map(prev);
      for (const result of results) {
        if (!result) continue;
        const existing = updated.get(result.campaignId);
        updated.set(result.campaignId, {
          successful: result.sentCount,
          failed: result.failedCount,
          pending: result.pendingSendingCount,
          unused: result.pendingSendingCount,
          total: result.total,
          failedRecipients: existing?.failedRecipients || [],
          accountStats: existing?.accountStats || [],
        });

        // Auto-complete if no pending/queued left
        const remainingNotDone = result.pendingSendingCount + result.queuedCount;
        if (remainingNotDone === 0 && result.total > 0) {
          supabase.from('campaigns').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', result.campaignId);
        }
      }
      return updated;
    });
  }, []);

  // FULL: Fetch counts for ALL campaigns (used on mount and after campaign changes)
  const fetchAllCampaignReports = useCallback(async () => {
    const currentCampaigns = campaignsRef.current;
    if (currentCampaigns.length === 0) return;

    const results = await Promise.all(
      currentCampaigns.map(async (campaign) => {
        const [totalRes, sentRes, failedRes, pendingSendingRes] = await Promise.all([
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id),
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', 'sent'),
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('status', 'failed'),
          supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).in('status', ['pending', 'sending']),
        ]);

        if (totalRes.error) return null;

        return {
          campaignId: campaign.id,
          total: totalRes.count || 0,
          sentCount: sentRes.count || 0,
          failedCount: failedRes.count || 0,
          pendingSendingCount: pendingSendingRes.count || 0,
        };
      })
    );

    setCampaignReports((prev) => {
      const updated = new Map(prev);
      for (const result of results) {
        if (!result) continue;
        const existing = updated.get(result.campaignId);
        updated.set(result.campaignId, {
          successful: result.sentCount,
          failed: result.failedCount,
          pending: result.pendingSendingCount,
          unused: result.pendingSendingCount,
          total: result.total,
          failedRecipients: existing?.failedRecipients || [],
          accountStats: existing?.accountStats || [],
        });
      }
      return updated;
    });
  }, []);

  // DETAILED: Fetch full report for a single campaign (on-demand when dialog opens)
  const fetchSingleCampaignReport = useCallback(async (campaignId: string) => {
    setIsLoadingReport(true);
    const currentAccounts = accountsRef.current;
    
    try {
      // NOTE: PostgREST caps rows per request (~1000). We must page for accurate reports.
      const PAGE_SIZE = 1000;
      const MAX_PAGES = 200; // safety cap
      const allRecipients: any[] = [];

      for (let page = 0; page < MAX_PAGES; page++) {
        const from = page * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        const { data, error } = await supabase
          .from('campaign_recipients')
          .select('id, status, phone_number, name, sent_by_account_id, failed_reason')
          .eq('campaign_id', campaignId)
          .range(from, to);

        if (error) throw error;
        if (!data || data.length === 0) break;

        allRecipients.push(...data);
        if (data.length < PAGE_SIZE) break; // last page
      }

      const recipients = allRecipients;

      if (!recipients || recipients.length === 0) {
        setIsLoadingReport(false);
        setLoadedReportIds((prev) => new Set(prev).add(campaignId));
        return;
      }

      // Fetch failed reasons from messages for failed recipients
      let failedRecipients: FailedRecipient[] = [];
      const failedRecipientsData = recipients.filter((r) => r.status === 'failed');
      
      if (failedRecipientsData.length > 0) {
        const { data: failedMessages } = await supabase
          .from('messages')
          .select('failed_reason, campaign_recipient_id, account_id')
          .eq('direction', 'outgoing')
          .in('status', ['failed', 'cancelled'])
          .in('campaign_recipient_id', failedRecipientsData.map(r => r.id))
          .limit(200);

        const messageInfoByRecipientId = new Map<string, { reason: string; accountId: string | null }>();
        (failedMessages || []).forEach((m: any) => {
          if (m.campaign_recipient_id && m.failed_reason) {
            messageInfoByRecipientId.set(m.campaign_recipient_id, {
              reason: m.failed_reason,
              accountId: m.account_id || null
            });
          }
        });

        failedRecipients = failedRecipientsData.map((r) => {
          const messageInfo = messageInfoByRecipientId.get(r.id);
          const senderAccountId = messageInfo?.accountId || r.sent_by_account_id;
          const senderAccount = senderAccountId ? currentAccounts.find(a => a.id === senderAccountId) : null;
          
          return {
            phone_number: r.phone_number,
            name: r.name,
            failed_reason: messageInfo?.reason || (r as any).failed_reason || 'Unknown error',
            sent_by_account_id: senderAccountId || null,
            sender_phone: senderAccount?.phoneNumber || null,
            sender_name: senderAccount?.firstName || null
          };
        });
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
      setLoadedReportIds(prev => new Set(prev).add(campaignId));
    } finally {
      setIsLoadingReport(false);
    }
  }, []);

  // Fetch all reports on mount and when campaigns length changes
  const campaignsLength = campaigns.length;
  const hasRunningCampaigns = campaigns.some(c => c.status === 'running');
  
  useEffect(() => {
    if (campaignsLength > 0) fetchAllCampaignReports();
  }, [campaignsLength, fetchAllCampaignReports]);

  // Realtime subscription for running campaign stats instead of polling
  useEffect(() => {
    if (!hasRunningCampaigns) return;

    let debounceTimer: NodeJS.Timeout | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchRunningCampaignStats(), 3000);
    };

    const channel = supabase
      .channel('campaign-recipients-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_recipients' }, debouncedFetch)
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [hasRunningCampaigns, fetchRunningCampaignStats]);

  // Listen for campaign status changes only (not recipient changes - too noisy)
  // Debounced to prevent UI flickering when switching pages
  const campaignRealtimeDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const campaignInitialMountRef = useRef(true);
  
  useEffect(() => {
    if (campaignsLength === 0) return;

    const channel = supabase
      .channel('campaigns-status-updates')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'campaigns' },
        () => {
          // Skip on initial mount
          if (campaignInitialMountRef.current) {
            campaignInitialMountRef.current = false;
            return;
          }
          
          // Debounce refresh calls
          if (campaignRealtimeDebounceRef.current) {
            clearTimeout(campaignRealtimeDebounceRef.current);
          }
          campaignRealtimeDebounceRef.current = setTimeout(() => {
            fetchAllCampaignReports();
          }, 300);
        }
      )
      .subscribe();

    // Mark initial mount complete after a short delay
    setTimeout(() => {
      campaignInitialMountRef.current = false;
    }, 1000);

    return () => {
      if (campaignRealtimeDebounceRef.current) {
        clearTimeout(campaignRealtimeDebounceRef.current);
      }
      supabase.removeChannel(channel);
    };
  }, [campaignsLength, fetchAllCampaignReports]);

  // Fetch unique recipients per account for today (for campaign account selection display)
  // Uses campaign_recipients table for accurate campaign send counts (not chat replies)
  const fetchAccountUniqueRecipients = useCallback(async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get all campaign recipients sent today - this is the accurate source for campaign messaging
    const { data: todaySends } = await supabase
      .from('campaign_recipients')
      .select('sent_by_account_id, phone_number')
      .eq('status', 'sent')
      .gte('sent_at', today.toISOString());
    
    if (!todaySends) return;
    
    // Count unique recipients per account
    const accountRecipients = new Map<string, Set<string>>();
    todaySends.forEach((send: any) => {
      if (!send.sent_by_account_id || !send.phone_number) return;
      
      if (!accountRecipients.has(send.sent_by_account_id)) {
        accountRecipients.set(send.sent_by_account_id, new Set());
      }
      accountRecipients.get(send.sent_by_account_id)!.add(send.phone_number);
    });
    
    // Convert to count map
    const countMap = new Map<string, number>();
    accountRecipients.forEach((phones, accountId) => {
      countMap.set(accountId, phones.size);
    });
    
    console.log('[Campaigns] Account unique recipients today:', Object.fromEntries(countMap));
    setAccountUniqueRecipients(countMap);
  }, []);

  // Only fetch account unique recipients once on mount - no interval needed
  useEffect(() => {
    fetchAccountUniqueRecipients();
  }, [fetchAccountUniqueRecipients]);

  // Fetch seats for campaign assignment
  const fetchSeats = useCallback(async () => {
    const { data } = await supabase.from('seats').select('id, name, is_active').eq('is_active', true);
    setSeats(data || []);
    setSeatsLoaded(true);
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

  // Handler for the new CreateCampaignDialog component
  const handleCreateCampaignFromDialog = useCallback(async (data: {
    name: string;
    recipientsText: string;
    batchSize: number;
    accountIds: string[];
    messageTemplates: { id: string; message: string; accountCount: number }[];
    selectedSeatIds: string[];
  }) => {
    const allMessages = data.messageTemplates.filter(t => t.message.trim()).map(t => t.message);
    if (allMessages.length === 0) {
      toast.error('Please enter at least one message');
      return;
    }
    
    // Parse recipients
    const recipientLines = data.recipientsText.split('\n').filter(l => l.trim());
    const parsedRecipients = recipientLines.map(line => {
      const parts = line.split(/[,\t]/).map(p => p.trim());
      const rawInput = parts[0];
      const { identifier } = normalizeRecipient(rawInput);
      return { phone_number: identifier, name: parts[1] || undefined };
    }).filter(r => r.phone_number && r.phone_number.length >= 3);

    if (parsedRecipients.length === 0) {
      toast.error('Please add at least one valid phone number or username');
      return;
    }

    const mainMessage = allMessages[0];
    
    const shuffleArray = <T,>(array: T[]): T[] => {
      const shuffled = [...array];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    };

    // Always create ONE campaign, assign seats to recipients via round-robin
    const createdCampaign = await createCampaign({
      name: data.name,
      messageTemplate: mainMessage,
      recipientCount: parsedRecipients.length,
      accountIds: data.accountIds
    });
    
    if (createdCampaign) {
      // If multiple seats selected, shuffle and assign seat_id to each recipient
      if (data.selectedSeatIds.length > 1) {
        const shuffledRecipients = shuffleArray(parsedRecipients);
        const seatCount = data.selectedSeatIds.length;
        
        // Assign seat_id to each recipient using round-robin
        const recipientsWithSeats = shuffledRecipients.map((recipient, index) => ({
          ...recipient,
          seat_id: data.selectedSeatIds[index % seatCount]
        }));
        
        const result = await uploadRecipients(createdCampaign.id, recipientsWithSeats);
        
        // Validate that recipients were actually inserted
        if (!result || result.inserted === 0) {
          await supabase.from('campaigns').delete().eq('id', createdCampaign.id);
          const dupCount = result?.duplicates || parsedRecipients.length;
          toast.error(`All ${dupCount} recipients are already contacted or pending in other campaigns. Campaign was not created.`);
          return;
        }
        
        // Update campaign with batch size (no single seat_id since multiple seats)
        await supabase.from('campaigns').update({ 
          batch_size: data.batchSize 
        }).eq('id', createdCampaign.id);
        
        toast.success(`Campaign created with ${result.inserted} recipients distributed across ${data.selectedSeatIds.length} seats!`);
      } else {
        // Single seat or no seat
        const result = await uploadRecipients(createdCampaign.id, parsedRecipients);
        
        // Validate that recipients were actually inserted
        if (!result || result.inserted === 0) {
          await supabase.from('campaigns').delete().eq('id', createdCampaign.id);
          const dupCount = result?.duplicates || parsedRecipients.length;
          toast.error(`All ${dupCount} recipients are already contacted or pending in other campaigns. Campaign was not created.`);
          return;
        }
        
        const updateData: any = { batch_size: data.batchSize };
        if (data.selectedSeatIds.length === 1) {
          updateData.seat_id = data.selectedSeatIds[0];
        }
        await supabase.from('campaigns').update(updateData).eq('id', createdCampaign.id);
        
        toast.success(`Campaign created with ${result.inserted} recipients! Start it to begin sending.`);
      }
    }
    
    refreshData();
  }, [createCampaign, uploadRecipients, refreshData]);

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
    
    if (result && result.inserted === 0 && result.duplicates > 0) {
      toast.error(`All ${result.duplicates} recipients are already contacted or pending in other campaigns. No new recipients added.`);
    }
    
    setRecipientText('');
    setIsUploadOpen(false);
    refreshData();
  }, [selectedCampaignId, recipientText, uploadRecipients, refreshData]);

  const handleStartCampaign = async (campaignId: string) => {
    setIsStarting(campaignId);
    
    await startCampaign(campaignId);
    // Refresh all counts after starting (the fast polling will take over for running campaigns)
    await fetchAllCampaignReports();
    setIsStarting(null);
  };

  // Helper function to fetch all recipients with pagination (bypasses 1000 row limit)
  const fetchAllRecipientsPaginated = async (campaignId: string) => {
    const PAGE_SIZE = 1000;
    let allData: any[] = [];
    let offset = 0;
    let hasMore = true;
    
    while (hasMore) {
      const { data, error } = await supabase
        .from('campaign_recipients')
        .select('*')
        .eq('campaign_id', campaignId)
        .range(offset, offset + PAGE_SIZE - 1);
      
      if (error) throw error;
      
      allData = [...allData, ...(data || [])];
      hasMore = (data?.length || 0) === PAGE_SIZE;
      offset += PAGE_SIZE;
    }
    
    return allData;
  };

  const handleExportReport = async (campaign: Campaign) => {
    const report = campaignReports.get(campaign.id);
    if (!report) return;
    
    toast.info('Fetching all recipients...');
    
    try {
      // Fetch ALL recipients with pagination (no 1000 limit)
      const recipients = await fetchAllRecipientsPaginated(campaign.id);
      
      // Fetch failed reasons from messages (also paginated, chunked to avoid URL limits)
      const failedRecipientIds = recipients?.filter(r => r.status === 'failed').map(r => r.id) || [];
      let failedReasons = new Map<string, string>();
      
      if (failedRecipientIds.length > 0) {
        // Chunk IDs to avoid URL length limits (max ~200 per query)
        const CHUNK_SIZE = 200;
        for (let i = 0; i < failedRecipientIds.length; i += CHUNK_SIZE) {
          const chunk = failedRecipientIds.slice(i, i + CHUNK_SIZE);
          
          const { data: failedMessages } = await supabase
            .from('messages')
            .select('failed_reason, campaign_recipient_id')
            .eq('direction', 'outgoing')
            .in('status', ['failed', 'cancelled'])
            .in('campaign_recipient_id', chunk);
          
          (failedMessages || []).forEach((m: any) => {
            if (m.campaign_recipient_id && m.failed_reason) {
              failedReasons.set(m.campaign_recipient_id, m.failed_reason);
            }
          });
        }
      }

      // Get sender account details
      const accountIds = [...new Set(recipients?.map(r => r.sent_by_account_id).filter(Boolean) || [])];
      const accountsMap = new Map<string, { phone: string; name: string }>();
      accounts.forEach(a => {
        accountsMap.set(a.id, { phone: a.phoneNumber, name: a.firstName || '' });
      });

      // Filter recipients by status
      const allRecipients = recipients || [];
      const successfulRecipients = allRecipients.filter((r: any) => r.status === 'sent');
      const failedRecipientsList = allRecipients.filter((r: any) => r.status === 'failed');
      const pendingRecipients = allRecipients.filter((r: any) => r.status === 'pending');

      // Helper to remove + from phone numbers
      const cleanPhone = (phone: string | null) => (phone || '').replace(/^\+/, '');

      // Prepare data for each sheet
      const allData = allRecipients.map((r: any) => ({
        'Phone Number': cleanPhone(r.phone_number),
        'Name': r.name || '',
        'Status': r.status === 'sent' ? 'Successful' : r.status === 'failed' ? 'Failed' : 'Pending',
        'Error Reason': r.status === 'failed' ? (failedReasons.get(r.id) || r.failed_reason || 'Unknown error') : ''
      }));

      const successfulData = successfulRecipients.map((r: any) => ({
        'Phone Number': cleanPhone(r.phone_number),
        'Name': r.name || ''
      }));

      const failedData = failedRecipientsList.map((r: any) => ({
        'Phone Number': cleanPhone(r.phone_number),
        'Name': r.name || '',
        'Error Reason': failedReasons.get(r.id) || r.failed_reason || 'Unknown error'
      }));

      const pendingData = pendingRecipients.map((r: any) => ({
        'Phone Number': cleanPhone(r.phone_number),
        'Name': r.name || ''
      }));

      // Create workbook with multiple sheets
      const workbook = XLSX.utils.book_new();
      
      const allSheet = XLSX.utils.json_to_sheet(allData);
      const successSheet = XLSX.utils.json_to_sheet(successfulData);
      const failedSheet = XLSX.utils.json_to_sheet(failedData);
      const pendingSheet = XLSX.utils.json_to_sheet(pendingData);

      // Set column widths for better readability
      const setColumnWidths = (sheet: XLSX.WorkSheet, widths: number[]) => {
        sheet['!cols'] = widths.map(w => ({ wch: w }));
      };
      
      setColumnWidths(allSheet, [18, 20, 12, 40]);
      setColumnWidths(successSheet, [18, 20]);
      setColumnWidths(failedSheet, [18, 20, 40]);
      setColumnWidths(pendingSheet, [18, 20]);

      XLSX.utils.book_append_sheet(workbook, allSheet, 'All');
      XLSX.utils.book_append_sheet(workbook, successSheet, 'Successful');
      XLSX.utils.book_append_sheet(workbook, failedSheet, 'Failed');
      XLSX.utils.book_append_sheet(workbook, pendingSheet, 'Pending');

      // Generate and download Excel file
      const campaignNameClean = campaign.name.replace(/[^a-zA-Z0-9]/g, '_');
      XLSX.writeFile(workbook, `Campaign_${campaignNameClean}_${format(new Date(), 'yyyyMMdd_HHmmss')}.xlsx`);
      
      toast.success(`Exported ${allRecipients.length} recipients (${successfulRecipients.length} success, ${failedRecipientsList.length} failed, ${pendingRecipients.length} pending)`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export report data');
    }
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

  const handleStatusToggle = async (campaign: Campaign) => {
    if (campaign.status === 'running') {
      // Optimistically update UI immediately
      updateCampaign(campaign.id, { status: 'paused' });
      toast.success('Campaign paused');
      
      // Call pause-campaign function in background (don't block UI)
      supabase.functions.invoke('admin-api', {
        body: { path: '/campaigns/pause', campaign_id: campaign.id }
      }).then(({ error }) => {
        if (error) {
          console.error('Pause campaign error:', error);
          // Revert on error
          updateCampaign(campaign.id, { status: 'running' });
          toast.error('Failed to pause campaign');
        }
        // Refresh stats in background
        fetchAllCampaignReports();
      }).catch((err) => {
        console.error('Pause campaign error:', err);
        updateCampaign(campaign.id, { status: 'running' });
        toast.error('Failed to pause campaign');
      });
    } else if (campaign.status === 'paused' || campaign.status === 'draft') {
      handleStartCampaign(campaign.id);
    }
  };

  // Toggle campaign selection for bulk operations
  const toggleCampaignSelection = (campaignId: string) => {
    setSelectedCampaigns(prev => {
      const newSet = new Set(prev);
      if (newSet.has(campaignId)) {
        newSet.delete(campaignId);
      } else {
        newSet.add(campaignId);
      }
      return newSet;
    });
  };

  // Select all campaigns
  const selectAllCampaigns = () => {
    if (selectedCampaigns.size === campaigns.length) {
      setSelectedCampaigns(new Set());
    } else {
      setSelectedCampaigns(new Set(campaigns.map(c => c.id)));
    }
  };

  // Bulk delete campaigns
  const handleBulkDelete = async () => {
    if (selectedCampaigns.size === 0) return;
    
    setIsDeleting(true);
    try {
      const deletePromises = Array.from(selectedCampaigns).map(id => deleteCampaign(id));
      await Promise.all(deletePromises);
      setSelectedCampaigns(new Set());
      toast.success(`Deleted ${selectedCampaigns.size} campaign(s)`);
    } catch (error) {
      toast.error('Failed to delete some campaigns');
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  // Save campaign speed settings to database
  const handleSaveSpeedSettings = async () => {
    const success = await saveSetting('campaign_speed', campaignSpeed);
    if (success) {
      toast.success('Campaign speed settings saved');
    }
  };

  // Single delete campaign
  const handleSingleDelete = async () => {
    if (!deletingCampaignId) return;
    
    setIsDeleting(true);
    try {
      await deleteCampaign(deletingCampaignId);
      toast.success('Campaign deleted');
    } catch (error) {
      toast.error('Failed to delete campaign');
    } finally {
      setIsDeleting(false);
      setDeletingCampaignId(null);
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

  // Message template functions moved to CreateCampaignDialog component

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
        icon={Megaphone}
        action={
          <>
            <Button className="gap-2" onClick={() => setIsCreateOpen(true)}>
              <Plus className="w-4 h-4" />
              New Campaign
            </Button>
            <CreateCampaignDialog
              open={isCreateOpen}
              onOpenChange={setIsCreateOpen}
              seats={seats}
              accounts={accounts}
              dataStats={dataStats}
              accountUniqueRecipients={accountUniqueRecipients}
              onOpenDataSelect={handleOpenDataSelect}
              onCreateCampaign={handleCreateCampaignFromDialog}
            />
          </>
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

      {/* Report Dialog - Professional with Tabs */}
      <Dialog open={isReportOpen} onOpenChange={setIsReportOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader className="border-b pb-4">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-xl font-semibold flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-primary" />
                  Campaign Report
                </DialogTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {selectedReportCampaign?.name}
                </p>
              </div>
              {selectedReportCampaign && campaignReports.get(selectedReportCampaign.id) && (
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => handleExportReport(selectedReportCampaign)}
                  className="gap-2"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </Button>
              )}
            </div>
          </DialogHeader>
          
          {selectedReportCampaign && (
            <div className="flex-1 overflow-hidden">
              {(() => {
                const report = campaignReports.get(selectedReportCampaign.id);
                
                if (isLoadingReport) {
                  return (
                    <div className="flex items-center justify-center py-16 gap-3">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      <p className="text-muted-foreground">Loading report details...</p>
                    </div>
                  );
                }
                
                if (!report || (report.total === 0 && selectedReportCampaign.recipientCount === 0)) {
                  return (
                    <div className="text-center py-16">
                      <AlertCircle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                      <p className="text-lg font-medium text-muted-foreground">No recipients in this campaign</p>
                      <p className="text-sm text-muted-foreground mt-2">
                        Add recipients before starting the campaign
                      </p>
                    </div>
                  );
                }
                
                const successRate = report.total > 0 ? Math.round((report.successful / report.total) * 100) : 0;
                const completionRate = report.total > 0 ? Math.round(((report.successful + report.failed) / report.total) * 100) : 0;
                
                return (
                  <Tabs defaultValue="overview" className="h-full flex flex-col">
                    <TabsList className="grid w-full grid-cols-3 mx-0 mt-4">
                      <TabsTrigger value="overview" className="gap-2">
                        <TrendingUp className="w-4 h-4" />
                        Overview
                      </TabsTrigger>
                      <TabsTrigger value="failed" className="gap-2">
                        <XCircle className="w-4 h-4" />
                        Failed ({report.failed})
                      </TabsTrigger>
                      <TabsTrigger value="accounts" className="gap-2">
                        <Users className="w-4 h-4" />
                        Accounts ({report.accountStats.length})
                      </TabsTrigger>
                    </TabsList>
                    
                    <div className="flex-1 overflow-y-auto mt-4">
                      {/* Overview Tab */}
                      <TabsContent value="overview" className="m-0 space-y-6">
                        {/* Summary Cards */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <Card className="bg-gradient-to-br from-muted/50 to-muted border-0">
                            <CardContent className="p-4 text-center">
                              <p className="text-3xl font-bold">{report.total.toLocaleString()}</p>
                              <p className="text-sm text-muted-foreground mt-1">Total Recipients</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-gradient-to-br from-green-500/10 to-green-500/5 border-green-500/20">
                            <CardContent className="p-4 text-center">
                              <p className="text-3xl font-bold text-green-600">{report.successful.toLocaleString()}</p>
                              <p className="text-sm text-muted-foreground mt-1">Sent Successfully</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-gradient-to-br from-destructive/10 to-destructive/5 border-destructive/20">
                            <CardContent className="p-4 text-center">
                              <p className="text-3xl font-bold text-destructive">{report.failed.toLocaleString()}</p>
                              <p className="text-sm text-muted-foreground mt-1">Failed</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-gradient-to-br from-yellow-500/10 to-yellow-500/5 border-yellow-500/20">
                            <CardContent className="p-4 text-center">
                              <p className="text-3xl font-bold text-yellow-600">{report.pending.toLocaleString()}</p>
                              <p className="text-sm text-muted-foreground mt-1">Pending</p>
                            </CardContent>
                          </Card>
                        </div>
                        
                        {/* Progress Section */}
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Campaign Progress</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-4">
                            <div className="space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Completion</span>
                                <span className="font-medium">{completionRate}%</span>
                              </div>
                              <Progress value={completionRate} className="h-2" />
                            </div>
                            <div className="space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Success Rate</span>
                                <span className={cn("font-medium", successRate >= 80 ? "text-green-600" : successRate >= 50 ? "text-yellow-600" : "text-destructive")}>
                                  {successRate}%
                                </span>
                              </div>
                              <Progress 
                                value={successRate} 
                                className={cn("h-2", successRate >= 80 ? "[&>div]:bg-green-500" : successRate >= 50 ? "[&>div]:bg-yellow-500" : "[&>div]:bg-destructive")} 
                              />
                            </div>
                          </CardContent>
                        </Card>
                        
                        {/* Campaign Details */}
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Campaign Details</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="grid grid-cols-2 gap-4 text-sm">
                              <div>
                                <p className="text-muted-foreground">Status</p>
                                <Badge className={cn("mt-1", getStatusColor(selectedReportCampaign.status))}>
                                  {selectedReportCampaign.status}
                                </Badge>
                              </div>
                              <div>
                                <p className="text-muted-foreground">Created</p>
                                <p className="font-medium mt-1">{format(selectedReportCampaign.createdAt, 'MMM d, yyyy')}</p>
                              </div>
                              <div className="col-span-2">
                                <p className="text-muted-foreground">Message Template</p>
                                <p className="font-medium mt-1 p-2 bg-muted rounded-md text-xs">
                                  {selectedReportCampaign.messageTemplate}
                                </p>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </TabsContent>
                      
                      {/* Failed Recipients Tab */}
                      <TabsContent value="failed" className="m-0">
                        {report.failedRecipients.length === 0 ? (
                          <div className="text-center py-12">
                            <CheckCircle className="w-12 h-12 mx-auto text-green-500 mb-4" />
                            <p className="text-lg font-medium">No Failed Recipients</p>
                            <p className="text-sm text-muted-foreground mt-2">
                              All messages were sent successfully!
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between text-sm text-muted-foreground px-1">
                              <span>Showing {report.failedRecipients.length} failed recipients</span>
                            </div>
                            <ScrollArea className="h-[400px]">
                              <div className="space-y-2 pr-4">
                                {report.failedRecipients.map((recipient, idx) => (
                                  <Card key={idx} className="border-destructive/20">
                                    <CardContent className="p-3">
                                      <div className="flex justify-between items-start">
                                        <div className="flex-1">
                                          <p className="font-medium">{recipient.name || 'Unknown'}</p>
                                          <p className="text-sm text-muted-foreground">{recipient.phone_number}</p>
                                          {recipient.sender_phone && (
                                            <p className="text-xs text-muted-foreground mt-1">
                                              Sent by: {recipient.sender_name || recipient.sender_phone}
                                            </p>
                                          )}
                                        </div>
                                        <Badge variant="destructive" className="text-xs shrink-0">
                                          Failed
                                        </Badge>
                                      </div>
                                      <div className="mt-2 p-2 bg-destructive/10 rounded text-xs text-destructive">
                                        {recipient.failed_reason || 'Unknown error'}
                                      </div>
                                    </CardContent>
                                  </Card>
                                ))}
                              </div>
                            </ScrollArea>
                          </div>
                        )}
                      </TabsContent>
                      
                      {/* Account Stats Tab */}
                      <TabsContent value="accounts" className="m-0">
                        {report.accountStats.length === 0 ? (
                          <div className="text-center py-12">
                            <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                            <p className="text-lg font-medium">No Account Data</p>
                            <p className="text-sm text-muted-foreground mt-2">
                              No accounts have processed recipients yet
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between text-sm text-muted-foreground px-1">
                              <span>Performance by Account</span>
                              <span>{report.accountStats.length} accounts used</span>
                            </div>
                            <ScrollArea className="h-[400px]">
                              <div className="space-y-2 pr-4">
                                {report.accountStats
                                  .sort((a, b) => b.uniqueRecipientsSent - a.uniqueRecipientsSent)
                                  .map((stat, idx) => {
                                    const total = stat.uniqueRecipientsSent + stat.uniqueRecipientsFailed + stat.uniqueRecipientsPending;
                                    const accountSuccessRate = total > 0 ? Math.round((stat.uniqueRecipientsSent / total) * 100) : 0;
                                    
                                    return (
                                      <Card key={stat.accountId} className="hover:bg-muted/50 transition-colors">
                                        <CardContent className="p-3">
                                          <div className="flex justify-between items-start mb-2">
                                            <div>
                                              <p className="font-medium">{stat.firstName || 'Unknown'}</p>
                                              <p className="text-sm text-muted-foreground">{stat.phoneNumber}</p>
                                            </div>
                                            <Badge 
                                              variant="outline" 
                                              className={cn(
                                                "text-xs",
                                                accountSuccessRate >= 80 ? "border-green-500 text-green-600" :
                                                accountSuccessRate >= 50 ? "border-yellow-500 text-yellow-600" :
                                                "border-destructive text-destructive"
                                              )}
                                            >
                                              {accountSuccessRate}% success
                                            </Badge>
                                          </div>
                                          <div className="grid grid-cols-3 gap-2 text-center text-xs">
                                            <div className="p-2 bg-green-500/10 rounded">
                                              <p className="font-bold text-green-600">{stat.uniqueRecipientsSent}</p>
                                              <p className="text-muted-foreground">Sent</p>
                                            </div>
                                            <div className="p-2 bg-destructive/10 rounded">
                                              <p className="font-bold text-destructive">{stat.uniqueRecipientsFailed}</p>
                                              <p className="text-muted-foreground">Failed</p>
                                            </div>
                                            <div className="p-2 bg-yellow-500/10 rounded">
                                              <p className="font-bold text-yellow-600">{stat.uniqueRecipientsPending}</p>
                                              <p className="text-muted-foreground">Pending</p>
                                            </div>
                                          </div>
                                        </CardContent>
                                      </Card>
                                    );
                                  })}
                              </div>
                            </ScrollArea>
                          </div>
                        )}
                      </TabsContent>
                    </div>
                  </Tabs>
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
            <>
              {/* Campaign Speed Settings Card */}
              <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
                        <TrendingUp className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold">Campaign Speed Settings</h3>
                        <p className="text-xs text-muted-foreground">
                          {campaignSpeed.messagesPerAccountPerDay} msgs/account today • Batch: {campaignSpeed.batchSize}
                        </p>
                      </div>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => {
                        if (!showSpeedSettings) {
                          // Refetch settings from database when opening panel
                          fetchSettings();
                        }
                        setShowSpeedSettings(!showSpeedSettings);
                      }}
                      className="gap-2"
                    >
                      <Settings className="w-4 h-4" />
                      {showSpeedSettings ? 'Hide' : 'Configure'}
                    </Button>
                  </div>
                  
                  {showSpeedSettings && (
                    <div className="mt-4 pt-4 border-t border-border/50 space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {/* Messages per Account per Day - Most Important */}
                        <div className="space-y-2 md:col-span-2 lg:col-span-1">
                          <Label className="flex items-center gap-2">
                            Messages per Account Today
                            <Badge variant="secondary" className="text-xs">Resets Daily</Badge>
                          </Label>
                          <div className="flex items-center gap-4">
                          <Slider
                              value={[campaignSpeed.messagesPerAccountPerDay]}
                              onValueChange={([v]) => setCampaignSpeed(prev => ({ ...prev, messagesPerAccountPerDay: v }))}
                              min={3}
                              max={10}
                              step={1}
                              className="flex-1"
                            />
                            <span className="w-12 text-center font-medium">{campaignSpeed.messagesPerAccountPerDay}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">Messages each account can send today (resets at midnight)</p>
                        </div>
                        
                        
                        <div className="space-y-2">
                          <Label>Wait Between Batches</Label>
                          <div className="flex items-center gap-4">
                            <Slider
                              value={[campaignSpeed.pollingInterval]}
                              onValueChange={([v]) => setCampaignSpeed(prev => ({ ...prev, pollingInterval: v }))}
                              min={0}
                              max={10}
                              step={1}
                              className="flex-1"
                            />
                            <span className="w-12 text-center font-medium">{campaignSpeed.pollingInterval}s</span>
                          </div>
                          <p className="text-xs text-muted-foreground">Pause after each batch completes (0 = no wait)</p>
                        </div>
                        
                        <div className="space-y-2">
                          <Label>Batch Size</Label>
                          <div className="flex items-center gap-4">
                            <Slider
                              value={[campaignSpeed.batchSize]}
                              onValueChange={([v]) => setCampaignSpeed(prev => ({ ...prev, batchSize: v }))}
                              min={10}
                              max={1000}
                              step={10}
                              className="flex-1"
                            />
                            <span className="w-16 text-center font-medium">{campaignSpeed.batchSize}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">Messages per batch request</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between pt-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <AlertCircle className="w-4 h-4" />
                          <span>Lower delays = faster but higher risk of restrictions</span>
                        </div>
                        <Button onClick={handleSaveSpeedSettings} disabled={isSaving} size="sm">
                          {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                          Save Speed Settings
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
              {/* Bulk Selection Bar */}
              <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-border/50">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={selectedCampaigns.size === campaigns.length && campaigns.length > 0}
                    onCheckedChange={selectAllCampaigns}
                  />
                  <span className="text-sm text-muted-foreground">
                    {selectedCampaigns.size === 0 
                      ? `${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}` 
                      : `${selectedCampaigns.size} selected`
                    }
                  </span>
                </div>
                {selectedCampaigns.size > 0 && (
                  <Button 
                    variant="destructive" 
                    size="sm" 
                    onClick={() => setIsDeleteDialogOpen(true)}
                    disabled={isDeleting}
                    className="gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete {selectedCampaigns.size}
                  </Button>
                )}
              </div>
              
              {/* Campaign Cards */}
              {campaigns.map((campaign) => {
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

              // Use database values directly (synced via trigger)
              const hasPending = (campaign.pendingCount ?? 0) > 0;
              const noUsableAccounts = usableAssigned.length === 0 && assignedAccountIds.length > 0;
              const campaignStuck = campaign.status === 'running' && hasPending && noUsableAccounts;
              
              // Check if campaign failed due to no usable accounts (has pending but failed status)
              const campaignFailedDueToAccounts = campaign.status === 'failed' && hasPending;
              
              // Get seat name for this campaign (use memoized map)
              const seatName = campaign.seatId ? seatsMap.get(campaign.seatId) : undefined;
              
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
                  
                  <CardContent className="p-3 pt-4">
                    <div className="flex items-center justify-between gap-3">
                      {/* Selection Checkbox */}
                      <Checkbox
                        checked={selectedCampaigns.has(campaign.id)}
                        onCheckedChange={() => toggleCampaignSelection(campaign.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0"
                      />
                      
                      {/* Left Section - Name & Status */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {/* Status Icon */}
                        <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
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
                          {campaign.status === 'running' && <Play className="w-4 h-4" />}
                          {campaign.status === 'completed' && <CheckCircle className="w-4 h-4" />}
                          {campaign.status === 'failed' && <XCircle className="w-4 h-4" />}
                          {campaign.status === 'paused' && <Pause className="w-4 h-4" />}
                          {campaign.status === 'draft' && <FileText className="w-4 h-4" />}
                        </div>
                        
                        <div className="min-w-0 flex-1">
                          <h3 className="font-medium text-sm group-hover:text-primary transition-colors truncate">{campaign.name}</h3>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            <span className={`text-[10px] font-medium uppercase tracking-wider ${
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
                            {seatsLoaded && seatName && (
                              <>
                                <span className="text-muted-foreground text-[10px]">•</span>
                                <span className="text-[10px] text-muted-foreground">{seatName}</span>
                              </>
                            )}
                            {campaign.createdAt && (
                              <>
                                <span className="text-muted-foreground text-[10px]">•</span>
                                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                                  <Clock className="w-2.5 h-2.5" />
                                  {format(new Date(campaign.createdAt), 'MMM d, yyyy h:mm a')}
                                </span>
                              </>
                            )}
                            {campaignStuck && (
                              <span className="text-[10px] text-destructive flex items-center gap-0.5">
                                <AlertCircle className="w-2.5 h-2.5" />
                                Stuck
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      {/* Center Section - Stats (Compact) - Use database values directly (synced via trigger) */}
                      <div className="hidden md:flex items-center gap-1 shrink-0">
                        {(() => {
                          // Use database values directly - they're kept in sync via trigger
                          const total = campaign.recipientCount || 0;
                          const sent = campaign.sentCount || 0;
                          const failed = campaign.failedCount || 0;
                          const pending = campaign.pendingCount || 0;
                          const percent = total > 0 ? Math.round((sent / total) * 100) : 0;
                          
                          return (
                            <>
                              <div className="text-center px-2 min-w-[40px]">
                                <p className="text-sm font-semibold text-foreground">{total}</p>
                                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Total</p>
                              </div>
                              <div className="w-px h-6 bg-border" />
                              <div className="text-center px-2 min-w-[40px]">
                                <p className="text-sm font-semibold text-primary">{sent}</p>
                                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Sent</p>
                              </div>
                              <div className="w-px h-6 bg-border" />
                              <div className="text-center px-2 min-w-[40px]">
                                <p className="text-sm font-semibold text-yellow-600">{pending}</p>
                                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Pending</p>
                              </div>
                              <div className="w-px h-6 bg-border" />
                              <div className="text-center px-2 min-w-[40px]">
                                <p className="text-sm font-semibold text-destructive">{failed}</p>
                                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Failed</p>
                              </div>
                              <div className="w-px h-6 bg-border" />
                              <div className="text-center px-2.5 py-0.5 rounded-md bg-muted/50">
                                <p className="text-base font-bold text-foreground">{percent}%</p>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                      
                      {/* Right Section - Actions */}
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Dialog onOpenChange={(open) => { if (open) fetchSingleCampaignReport(campaign.id); }}>
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
                              {/* Stats Summary - Use database values directly (synced via trigger) */}
                              {(() => {
                                const total = campaign.recipientCount || 0;
                                const sent = campaign.sentCount || 0;
                                const failed = campaign.failedCount || 0;
                                const pending = campaign.pendingCount || 0;
                                const successRate = total > 0 ? Math.round((sent / total) * 100) : 0;
                                
                                // Show empty state if no recipients
                                if (total === 0) {
                                  return (
                                    <div className="text-center py-6 bg-muted/30 rounded-xl border border-border/50">
                                      <AlertCircle className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                                      <p className="text-muted-foreground font-medium">No recipients added</p>
                                      <p className="text-xs text-muted-foreground mt-1">
                                        This campaign has no recipients to send to
                                      </p>
                                    </div>
                                  );
                                }
                                
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
                                          ? `No usable accounts available. ${campaign.pendingCount || 0} messages still pending.`
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
                                    <p className="font-medium mt-1">{seatsLoaded ? (seatName || 'Not assigned') : '...'}</p>
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
                              {(() => {
                                // Use database value directly (synced via trigger)
                                const failedCount = campaign.failedCount || 0;
                                const failedRecipients = report?.failedRecipients || [];
                                const hasLoaded = loadedReportIds.has(campaign.id);
                                
                                if (failedCount === 0) return null;
                                
                                return (
                                  <div>
                                    <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                                      <XCircle className="w-4 h-4 text-destructive" />
                                      Failed Recipients ({failedCount})
                                    </h4>
                                    {failedRecipients.length > 0 ? (
                                      <ScrollArea className="h-[200px] border rounded-xl">
                                        <div className="divide-y">
                                          {failedRecipients.map((recipient, idx) => (
                                            <div key={idx} className="p-3">
                                              <div className="flex justify-between items-start">
                                                <div>
                                                  <span className="font-medium text-sm">{recipient.name || recipient.phone_number}</span>
                                                  {recipient.name && (
                                                    <span className="text-xs text-muted-foreground ml-2">{recipient.phone_number}</span>
                                                  )}
                                                </div>
                                                {recipient.sender_phone && (
                                                  <div className="text-right">
                                                    <span className="text-xs text-muted-foreground">via </span>
                                                    <span className="text-xs font-medium">{recipient.sender_name || recipient.sender_phone}</span>
                                                  </div>
                                                )}
                                              </div>
                                              <p className="text-xs text-destructive mt-1" title={recipient.failed_reason || 'Unknown error'}>
                                                {recipient.failed_reason || 'Unknown error'}
                                              </p>
                                            </div>
                                          ))}
                                        </div>
                                      </ScrollArea>
                                    ) : hasLoaded ? (
                                      <div className="flex items-center justify-center py-4 border rounded-xl bg-muted/30">
                                        <span className="text-sm text-muted-foreground">No failure details available</span>
                                      </div>
                                    ) : (
                                      <div className="flex items-center justify-center py-4 border rounded-xl bg-muted/30">
                                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground mr-2" />
                                        <span className="text-sm text-muted-foreground">Loading failure details...</span>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
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
                        
                        <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => setDeletingCampaignId(campaign.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            </>
          )}
        </div>
      )}

      {/* Single Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingCampaignId} onOpenChange={(open) => !open && setDeletingCampaignId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Campaign</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this campaign? This action cannot be undone and will remove all associated recipients and messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleSingleDelete} 
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedCampaigns.size} Campaign(s)</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedCampaigns.size} selected campaign(s)? This action cannot be undone and will remove all associated recipients and messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleBulkDelete} 
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Delete All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
};

export default Campaigns;
