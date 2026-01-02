import React, { useState, useCallback, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CountdownTimer } from '@/components/ui/countdown-timer';
import { 
  Plus, Play, Pause, Trash2, Edit, Send, Users, CheckCircle, XCircle, 
  Upload, FileText, Loader2, Download, Clock, MessageSquare, Settings,
  AlertCircle, RotateCcw, Eye
} from 'lucide-react';
import AccountScheduler from '@/components/campaigns/AccountScheduler';
import { format } from 'date-fns';
import { Campaign } from '@/types/telegram';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

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

const Campaigns: React.FC = () => {
  const { campaigns, accounts, createCampaign, updateCampaign, deleteCampaign, uploadRecipients, startCampaign, isLoading, refreshData } = useTelegram();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [recipientText, setRecipientText] = useState('');
  const [isStarting, setIsStarting] = useState<string | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [selectedReportCampaign, setSelectedReportCampaign] = useState<Campaign | null>(null);
  const [campaignReports, setCampaignReports] = useState<Map<string, CampaignReport>>(new Map());
  const [accountUniqueRecipients, setAccountUniqueRecipients] = useState<Map<string, number>>(new Map());
  
  // Bulk messaging settings
  const [messageTemplates, setMessageTemplates] = useState<BulkMessageTemplate[]>([
    { id: '1', message: '', accountCount: 10 }
  ]);
  const [messagesPerAccount, setMessagesPerAccount] = useState(10);
  const [messageInterval, setMessageInterval] = useState(3); // seconds between messages (fast default)
  const [accountSwitchDelay, setAccountSwitchDelay] = useState(5); // seconds before next account (fast default)
  const [showScheduler, setShowScheduler] = useState(false);
  const [schedulerSettings, setSchedulerSettings] = useState({
    enabled: true,
    maxMessagesBeforeRotation: 10,
    cooldownDuration: 10, // minutes (faster default)
    prioritizeHighMaturity: true,
    autoSkipRestricted: true,
    balanceLoad: true
  });
  
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    messageTemplate: '',
    recipientCount: 0,
    accountIds: [] as string[],
    recipientsText: '' // Recipients input during creation
  });

  // Fetch campaign reports + auto-sync pending recipients based on already-sent messages
  const fetchReports = useCallback(async () => {
    for (const campaign of campaigns) {
      const { data: recipients, error } = await supabase
        .from('campaign_recipients')
        .select('id, status, phone_number, name, sent_by_account_id, failed_reason')
        .eq('campaign_id', campaign.id);

      if (!recipients || error) continue;

      // Auto-sync: if a recipient is still "pending" but we already have a sent/failed outgoing message,
      // update the recipient status so UI progress matches reality.
      const pending = recipients.filter(
        (r) => r.status === 'pending' && r.sent_by_account_id && r.phone_number,
      );

      if (pending.length > 0) {
        // 1) Best-effort: direct link (new campaigns) via messages.campaign_recipient_id
        const pendingIds = pending.map((r) => r.id);
        const { data: linkedMsgs } = await supabase
          .from('messages')
          .select('status, delivered_at, created_at, campaign_recipient_id, failed_reason')
          .eq('direction', 'outgoing')
          .in('status', ['sent', 'failed'])
          .in('campaign_recipient_id', pendingIds)
          .order('created_at', { ascending: false })
          .limit(200);

        const byRecipientId = new Map<string, { status: string; delivered_at: string | null; failed_reason: string | null }>();
        (linkedMsgs || []).forEach((m: any) => {
          const rid = m.campaign_recipient_id as string | null;
          if (!rid) return;
          if (!byRecipientId.has(rid)) {
            byRecipientId.set(rid, { status: m.status, delivered_at: m.delivered_at ?? null, failed_reason: m.failed_reason ?? null });
          }
        });

        // Apply direct updates first
        const remaining: typeof pending = [];
        await Promise.all(
          pending.map(async (r) => {
            const match = byRecipientId.get(r.id);
            if (!match) {
              remaining.push(r);
              return;
            }

            const nextStatus = match.status === 'sent' ? 'sent' : 'failed';
            await supabase
              .from('campaign_recipients')
              .update({
                status: nextStatus,
                sent_at: nextStatus === 'sent' ? match.delivered_at : null,
              })
              .eq('id', r.id);

            r.status = nextStatus as any;
          }),
        );

        // 2) Fallback (older campaigns): match by account + phone
        if (remaining.length > 0) {
          const phonesSet = new Set(remaining.map((r) => r.phone_number));
          const accountIds = Array.from(new Set(remaining.map((r) => r.sent_by_account_id!)));

          const { data: sentMsgs } = await supabase
            .from('messages')
            .select('status, delivered_at, account_id, created_at, failed_reason, conversations!inner(recipient_phone)')
            .eq('direction', 'outgoing')
            .in('status', ['sent', 'failed'])
            .in('account_id', accountIds)
            .order('created_at', { ascending: false })
            .limit(500);

          const msgIndex = new Map<string, { status: string; delivered_at: string | null; failed_reason: string | null }>();
          (sentMsgs || []).forEach((m: any) => {
            const phone = m?.conversations?.recipient_phone;
            if (!phone || !phonesSet.has(phone)) return;
            const key = `${m.account_id}|${phone}`;
            if (!msgIndex.has(key)) {
              msgIndex.set(key, { status: m.status, delivered_at: m.delivered_at ?? null, failed_reason: m.failed_reason ?? null });
            }
          });

          await Promise.all(
            remaining.map(async (r) => {
              const key = `${r.sent_by_account_id}|${r.phone_number}`;
              const match = msgIndex.get(key);
              if (!match) return;

              const nextStatus = match.status === 'sent' ? 'sent' : 'failed';
              await supabase
                .from('campaign_recipients')
                .update({
                  status: nextStatus,
                  sent_at: nextStatus === 'sent' ? match.delivered_at : null,
                })
                .eq('id', r.id);

              r.status = nextStatus as any;
            }),
          );
        }
      }

      // Fetch failed reasons from messages for failed recipients
      const failedRecipientPhones = recipients.filter((r) => r.status === 'failed').map((r) => r.phone_number);
      let failedRecipients: FailedRecipient[] = [];
      
      if (failedRecipientPhones.length > 0) {
        // Get failed/cancelled messages with reasons
        const { data: failedMessages } = await supabase
          .from('messages')
          .select('failed_reason, campaign_recipient_id')
          .eq('direction', 'outgoing')
          .in('status', ['failed', 'cancelled'])
          .in('campaign_recipient_id', recipients.filter(r => r.status === 'failed').map(r => r.id))
          .limit(100);

        const reasonsByRecipientId = new Map<string, string>();
        (failedMessages || []).forEach((m: any) => {
          if (m.campaign_recipient_id && m.failed_reason) {
            reasonsByRecipientId.set(m.campaign_recipient_id, m.failed_reason);
          }
        });

        failedRecipients = recipients
          .filter((r) => r.status === 'failed')
          .map((r) => ({
            phone_number: r.phone_number,
            name: r.name,
            // Priority: message failed_reason > recipient failed_reason > Unknown error
            failed_reason: reasonsByRecipientId.get(r.id) || (r as any).failed_reason || 'Unknown error'
          }));
      }

      const sentCount = recipients.filter((r) => r.status === 'sent').length;
      const failedCount = recipients.filter((r) => r.status === 'failed').length;
      const pendingCount = recipients.filter((r) => r.status === 'pending' || r.status === 'sending').length;
      
      // Calculate per-account unique recipient stats
      const accountStatsMap = new Map<string, { sent: Set<string>; failed: Set<string>; pending: Set<string> }>();
      
      recipients.forEach((r) => {
        if (!r.sent_by_account_id) return;
        
        if (!accountStatsMap.has(r.sent_by_account_id)) {
          accountStatsMap.set(r.sent_by_account_id, { sent: new Set(), failed: new Set(), pending: new Set() });
        }
        
        const stats = accountStatsMap.get(r.sent_by_account_id)!;
        if (r.status === 'sent') {
          stats.sent.add(r.phone_number);
        } else if (r.status === 'failed') {
          stats.failed.add(r.phone_number);
        } else if (r.status === 'pending' || r.status === 'sending') {
          stats.pending.add(r.phone_number);
        }
      });
      
      // Build account stats array with account info
      const accountStats: AccountRecipientStats[] = Array.from(accountStatsMap.entries()).map(([accountId, stats]) => {
        const account = accounts.find(a => a.id === accountId);
        return {
          accountId,
          phoneNumber: account?.phoneNumber || 'Unknown',
          firstName: account?.firstName || null,
          uniqueRecipientsSent: stats.sent.size,
          uniqueRecipientsFailed: stats.failed.size,
          uniqueRecipientsPending: stats.pending.size,
        };
      });
      
      // Check if campaign should be auto-completed
      // Complete when: no pending AND (has sent/failed OR campaign was running but no active accounts left)
      const shouldComplete = campaign.status === 'running' && pendingCount === 0 && recipients.length > 0;
      
      // Check if there are any USABLE accounts for this campaign (active + under daily limit)
      const { data: campaignAccountLinks } = await supabase
        .from('campaign_accounts')
        .select('account_id, telegram_accounts!inner(status, messages_sent_today, daily_limit)')
        .eq('campaign_id', campaign.id);

      const hasUsableAccount = (campaignAccountLinks || []).some((ca: any) => {
        const acc = ca.telegram_accounts;
        if (!acc) return false;
        const limit = acc.daily_limit ?? 25;
        const sentToday = acc.messages_sent_today ?? 0;
        return acc.status === 'active' && sentToday < limit;
      });

      const noUsableAccounts = !hasUsableAccount;
      const shouldForceComplete = campaign.status === 'running' && noUsableAccounts && recipients.length > 0;

      const report: CampaignReport = {
        successful: sentCount,
        failed: failedCount,
        pending: pendingCount,
        unused: pendingCount,  // If campaign completed, pending = unused
        total: recipients.length,
        failedRecipients,
        accountStats
      };

      // Auto-update campaign status to 'completed' when appropriate
      if (shouldComplete || shouldForceComplete) {
        await supabase
          .from('campaigns')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', campaign.id);
        // Refresh campaigns data to reflect the status change
        refreshData();
      }

      setCampaignReports((prev) => new Map(prev).set(campaign.id, report));
    }
  }, [campaigns]);

  useEffect(() => {
    if (campaigns.length > 0) fetchReports();
  }, [campaigns.length, fetchReports]);

  // Keep progress fresh while viewing this page
  useEffect(() => {
    if (campaigns.length === 0) return;
    const interval = window.setInterval(() => {
      fetchReports();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [campaigns.length, fetchReports]);

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
    
    // Upload recipients immediately after campaign creation
    if (createdCampaign) {
      await uploadRecipients(createdCampaign.id, parsedRecipients);
    }
    
    // Store campaign settings in localStorage for the sender script
    const campaignSettings = {
      messageTemplates: messageTemplates.filter(t => t.message.trim()),
      messagesPerAccount,
      messageInterval,
      accountSwitchDelay,
      schedulerSettings,
    };
    localStorage.setItem(`campaign_settings_${newCampaign.name}`, JSON.stringify(campaignSettings));
    
    setNewCampaign({ name: '', messageTemplate: '', recipientCount: 0, accountIds: [], recipientsText: '' });
    setMessageTemplates([{ id: '1', message: '', accountCount: 10 }]);
    setIsCreateOpen(false);
    refreshData();
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

  // For campaigns: only active accounts that are NOT temporarily restricted
  const campaignEligibleAccounts = accounts.filter(
    (a) => a.status === 'active' && !isTemporarilyRestricted(a)
  );
  const tempRestrictedAccounts = accounts.filter(
    (a) => a.status === 'active' && isTemporarilyRestricted(a)
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
                  <div className="space-y-2">
                    <Label>Campaign Name</Label>
                    <Input
                      placeholder="Enter campaign name"
                      value={newCampaign.name}
                      onChange={(e) => setNewCampaign(prev => ({ ...prev, name: e.target.value }))}
                    />
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
                    <Label>Phone Numbers or Telegram Usernames</Label>
                    <Textarea
                      placeholder={`+14155551234,John Doe\n@telegram_user\nusername123\n14155550000`}
                      value={newCampaign.recipientsText}
                      onChange={(e) => setNewCampaign(prev => ({ ...prev, recipientsText: e.target.value }))}
                      rows={8}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {newCampaign.recipientsText.split('\n').filter(l => l.trim()).length} recipients
                    </p>
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

                  {/* Show temporarily restricted accounts as informational (not selectable) */}
                  {tempRestrictedAccounts.length > 0 && (
                    <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-yellow-600">
                            {tempRestrictedAccounts.length} Account(s) Temporarily Restricted
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            These accounts have a 24h+ restriction and cannot be used for campaigns (new contacts = ban risk).
                            They can still reply to existing conversations.
                          </p>
                          <div className="mt-2 space-y-2">
                            {tempRestrictedAccounts.map((acc) => (
                              <div key={acc.id} className="flex items-center justify-between text-xs text-yellow-600 bg-yellow-500/5 rounded px-2 py-1">
                                <span>• {acc.firstName || acc.phoneNumber}</span>
                                {acc.restrictedUntil && (
                                  <CountdownTimer 
                                    targetDate={new Date(acc.restrictedUntil)} 
                                    className="text-yellow-600"
                                  />
                                )}
                              </div>
                            ))}
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
                    onSettingsChange={(settings) => setSchedulerSettings(settings)}
                    accountUniqueRecipients={accountUniqueRecipients}
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
                if (!report) return <p className="text-muted-foreground">Loading report...</p>;
                
                return (
                  <>
                    <div className="grid grid-cols-5 gap-3">
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
                      <div className="text-center p-3 rounded-lg bg-gray-500/10">
                        <p className="text-2xl font-bold text-gray-500">{report.unused}</p>
                        <p className="text-xs text-muted-foreground">Unused</p>
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
              
              return (
                <Card key={campaign.id} className={`group relative overflow-hidden transition-all duration-300 hover:shadow-lg hover:shadow-primary/5 ${campaignStuck || campaignFailedDueToAccounts ? 'border-destructive/50 bg-destructive/5' : 'hover:border-primary/40'}`}>
                  {/* Status indicator line at top */}
                  <div className={`absolute top-0 left-0 right-0 h-1 ${
                    campaign.status === 'running' 
                      ? 'bg-gradient-to-r from-primary via-primary/80 to-primary animate-pulse' 
                      : campaign.status === 'completed' 
                        ? 'bg-gradient-to-r from-green-500 to-green-400' 
                        : campaign.status === 'failed' 
                          ? 'bg-gradient-to-r from-destructive to-destructive/80' 
                          : campaign.status === 'paused'
                            ? 'bg-gradient-to-r from-yellow-500 to-yellow-400'
                            : 'bg-gradient-to-r from-muted to-muted-foreground/20'
                  }`} />
                  
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
                        
                        <div className="min-w-0">
                          <h3 className="font-semibold text-base truncate group-hover:text-primary transition-colors">{campaign.name}</h3>
                          <div className="flex items-center gap-2 mt-0.5">
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
                          const percent = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
                          
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
                                const pending = report?.pending ?? (total - sent - failed);
                                
                                return (
                                  <div className="grid grid-cols-4 gap-3">
                                    <div className="bg-muted/40 rounded-xl p-4 text-center border border-border/50">
                                      <Users className="w-5 h-5 mx-auto mb-2 text-muted-foreground" />
                                      <p className="text-2xl font-bold">{total}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Total Recipients</p>
                                    </div>
                                    <div className="bg-primary/10 rounded-xl p-4 text-center border border-primary/20">
                                      <Send className="w-5 h-5 mx-auto mb-2 text-primary" />
                                      <p className="text-2xl font-bold text-primary">{sent}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Delivered</p>
                                    </div>
                                    <div className="bg-destructive/10 rounded-xl p-4 text-center border border-destructive/20">
                                      <XCircle className="w-5 h-5 mx-auto mb-2 text-destructive" />
                                      <p className="text-2xl font-bold text-destructive">{failed}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Failed</p>
                                    </div>
                                    <div className="bg-yellow-500/10 rounded-xl p-4 text-center border border-yellow-500/20">
                                      <Clock className="w-5 h-5 mx-auto mb-2 text-yellow-600" />
                                      <p className="text-2xl font-bold text-yellow-600">{pending > 0 ? pending : 0}</p>
                                      <p className="text-xs text-muted-foreground mt-1">Pending</p>
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
                                        <span className="font-medium">{stat.firstName || 'Unknown Account'}</span>
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
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </DialogContent>
                        </Dialog>
                        
                        <div className="w-px h-6 bg-border mx-1" />
                        
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => { setSelectedCampaignId(campaign.id); setIsUploadOpen(true); }} title="Upload Recipients">
                          <FileText className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => { setSelectedReportCampaign(campaign); setIsReportOpen(true); }} title="View Report">
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
