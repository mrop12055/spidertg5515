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
import { 
  Plus, Play, Pause, Trash2, Edit, Send, Users, CheckCircle, XCircle, 
  Upload, FileText, Loader2, Download, Clock, MessageSquare, Settings,
  AlertCircle, RotateCcw
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

interface CampaignReport {
  successful: number;
  failed: number;
  pending: number;
  total: number;
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
  
  // Bulk messaging settings
  const [messageTemplates, setMessageTemplates] = useState<BulkMessageTemplate[]>([
    { id: '1', message: '', accountCount: 10 }
  ]);
  const [messagesPerAccount, setMessagesPerAccount] = useState(5);
  const [messageInterval, setMessageInterval] = useState(30); // seconds between messages
  const [accountSwitchDelay, setAccountSwitchDelay] = useState(60); // seconds before next account
  const [showScheduler, setShowScheduler] = useState(false);
  const [schedulerSettings, setSchedulerSettings] = useState({
    enabled: true,
    maxMessagesBeforeRotation: 5,
    cooldownDuration: 30,
    prioritizeHighMaturity: true,
    autoSkipRestricted: true,
    balanceLoad: true
  });
  
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    messageTemplate: '',
    recipientCount: 0,
    accountIds: [] as string[]
  });

  // Fetch campaign reports
  useEffect(() => {
    const fetchReports = async () => {
      for (const campaign of campaigns) {
        const { data, error } = await supabase
          .from('campaign_recipients')
          .select('status')
          .eq('campaign_id', campaign.id);
        
        if (data && !error) {
          const report: CampaignReport = {
            successful: data.filter(r => r.status === 'sent').length,
            failed: data.filter(r => r.status === 'failed').length,
            pending: data.filter(r => r.status === 'pending').length,
            total: data.length,
          };
          setCampaignReports(prev => new Map(prev).set(campaign.id, report));
        }
      }
    };
    
    if (campaigns.length > 0) {
      fetchReports();
    }
  }, [campaigns]);

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
    
    // Use first message as main template, store others in metadata
    const mainMessage = allMessages[0];
    
    createCampaign({
      name: newCampaign.name,
      messageTemplate: mainMessage,
      recipientCount: newCampaign.recipientCount,
      accountIds: newCampaign.accountIds
    });
    
    // Store campaign settings in localStorage for the sender script
    const campaignSettings = {
      messageTemplates: messageTemplates.filter(t => t.message.trim()),
      messagesPerAccount,
      messageInterval,
      accountSwitchDelay,
      schedulerSettings,
    };
    localStorage.setItem(`campaign_settings_${newCampaign.name}`, JSON.stringify(campaignSettings));
    
    setNewCampaign({ name: '', messageTemplate: '', recipientCount: 0, accountIds: [] });
    setMessageTemplates([{ id: '1', message: '', accountCount: 10 }]);
    setIsCreateOpen(false);
  };

  const handleUploadRecipients = useCallback(async () => {
    if (!selectedCampaignId || !recipientText.trim()) {
      toast.error('Please enter recipient phone numbers');
      return;
    }

    const lines = recipientText.split('\n').filter(l => l.trim());
    const recipients = lines.map(line => {
      const parts = line.split(',').map(p => p.trim());
      return {
        phone_number: parts[0],
        name: parts[1] || undefined
      };
    }).filter(r => r.phone_number);

    if (recipients.length === 0) {
      toast.error('No valid phone numbers found');
      return;
    }

    await uploadRecipients(selectedCampaignId, recipients);
    setRecipientText('');
    setIsUploadOpen(false);
    refreshData();
  }, [selectedCampaignId, recipientText, uploadRecipients, refreshData]);

  const handleStartCampaign = async (campaignId: string) => {
    setIsStarting(campaignId);
    await startCampaign(campaignId);
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
              
              <Tabs defaultValue="messages" className="mt-4">
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="messages">Messages</TabsTrigger>
                  <TabsTrigger value="accounts">Accounts</TabsTrigger>
                  <TabsTrigger value="scheduler">Scheduler</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>
                
                <TabsContent value="messages" className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label>Campaign Name</Label>
                    <Input
                      placeholder="Enter campaign name"
                      value={newCampaign.name}
                      onChange={(e) => setNewCampaign(prev => ({ ...prev, name: e.target.value }))}
                    />
                  </div>
                  
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
                  
                  {activeAccounts.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground border rounded-lg">
                      No active accounts available. Upload accounts first.
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto space-y-2 p-2 border rounded-lg bg-accent/30">
                      <div className="flex items-center gap-2 mb-2">
                        <Checkbox
                          checked={newCampaign.accountIds.length === activeAccounts.length}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setNewCampaign(prev => ({ ...prev, accountIds: activeAccounts.map(a => a.id) }));
                            } else {
                              setNewCampaign(prev => ({ ...prev, accountIds: [] }));
                            }
                          }}
                        />
                        <label className="text-sm font-medium">Select All ({activeAccounts.length})</label>
                      </div>
                      {activeAccounts.map(account => (
                        <div key={account.id} className="flex items-center gap-2">
                          <Checkbox
                            id={account.id}
                            checked={newCampaign.accountIds.includes(account.id)}
                            onCheckedChange={() => handleAccountToggle(account.id)}
                          />
                          <label htmlFor={account.id} className="text-sm cursor-pointer flex-1">
                            {account.firstName || account.phoneNumber} 
                            <span className="text-muted-foreground ml-1">
                              ({account.phoneNumber}) - {account.messagesSentToday}/{account.dailyLimit} today
                            </span>
                          </label>
                        </div>
                      ))}
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
                          min={10}
                          max={300}
                          step={5}
                          className="flex-1"
                        />
                        <span className="w-12 text-center font-medium">{messageInterval}s</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Wait time between each message sent by the same account
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Account Switch Delay (seconds)</Label>
                      <div className="flex items-center gap-4">
                        <Slider
                          value={[accountSwitchDelay]}
                          onValueChange={([v]) => setAccountSwitchDelay(v)}
                          min={30}
                          max={600}
                          step={10}
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
                          Recommended to start conservative and adjust based on results.
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
                <Button onClick={handleCreateCampaign} disabled={!newCampaign.name}>
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
        <DialogContent className="max-w-lg">
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
                    <div className="grid grid-cols-4 gap-4">
                      <div className="text-center p-4 rounded-lg bg-muted">
                        <p className="text-2xl font-bold">{report.total}</p>
                        <p className="text-xs text-muted-foreground">Total</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-green-500/10">
                        <p className="text-2xl font-bold text-green-600">{report.successful}</p>
                        <p className="text-xs text-muted-foreground">Sent</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-destructive/10">
                        <p className="text-2xl font-bold text-destructive">{report.failed}</p>
                        <p className="text-xs text-muted-foreground">Failed</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-yellow-500/10">
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
              
              return (
                <Card key={campaign.id} className="hover:border-primary/30 transition-colors">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-lg flex items-center gap-2">
                          {campaign.name}
                          <Badge className={getStatusColor(campaign.status)}>
                            {campaign.status}
                          </Badge>
                        </CardTitle>
                        <p className="text-sm text-muted-foreground mt-1">
                          Created {format(campaign.createdAt, 'MMM d, yyyy')}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {/* Upload Recipients Button */}
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            setSelectedCampaignId(campaign.id);
                            setIsUploadOpen(true);
                          }}
                          title="Upload Recipients"
                        >
                          <FileText className="w-4 h-4" />
                        </Button>
                        
                        {/* View Report Button */}
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            setSelectedReportCampaign(campaign);
                            setIsReportOpen(true);
                          }}
                          title="View Report"
                        >
                          <MessageSquare className="w-4 h-4" />
                        </Button>
                        
                        {/* Start/Pause Button */}
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => handleStatusToggle(campaign)}
                          disabled={campaign.status === 'completed' || isStarting === campaign.id}
                        >
                          {isStarting === campaign.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : campaign.status === 'running' ? (
                            <Pause className="w-4 h-4" />
                          ) : (
                            <Play className="w-4 h-4" />
                          )}
                        </Button>
                        <Button variant="outline" size="icon">
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button 
                          variant="outline" 
                          size="icon"
                          onClick={() => deleteCampaign(campaign.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="bg-accent/50 p-3 rounded-lg mb-4">
                      <p className="text-sm font-mono">{campaign.messageTemplate}</p>
                    </div>
                    
                    {/* Progress Bar */}
                    {report && report.total > 0 && (
                      <div className="mb-4">
                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                          <span>Progress</span>
                          <span>{report.successful + report.failed} / {report.total}</span>
                        </div>
                        <Progress value={((report.successful + report.failed) / report.total) * 100} className="h-2" />
                      </div>
                    )}
                    
                    <div className="grid grid-cols-4 gap-4">
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{report?.total || campaign.recipientCount}</p>
                          <p className="text-xs text-muted-foreground">Recipients</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Send className="w-4 h-4 text-primary" />
                        <div>
                          <p className="text-sm font-medium">{report?.successful || campaign.sentCount}</p>
                          <p className="text-xs text-muted-foreground">Sent</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <XCircle className="w-4 h-4 text-destructive" />
                        <div>
                          <p className="text-sm font-medium">{report?.failed || campaign.failedCount}</p>
                          <p className="text-xs text-muted-foreground">Failed</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-yellow-600" />
                        <div>
                          <p className="text-sm font-medium">{report?.pending || 0}</p>
                          <p className="text-xs text-muted-foreground">Pending</p>
                        </div>
                      </div>
                    </div>
                    
                    {/* Assigned Accounts */}
                    {campaign.accountIds.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-border">
                        <p className="text-xs text-muted-foreground mb-2">
                          Assigned Accounts: {campaign.accountIds.length}
                        </p>
                      </div>
                    )}
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
