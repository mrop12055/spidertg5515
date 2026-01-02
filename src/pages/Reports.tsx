import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Activity,
  Send,
  TrendingUp,
  Users,
  MessageSquare,
  Zap,
  Shield,
  BarChart3,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  Phone,
  Calendar,
  Target,
  AlertCircle,
  PlayCircle,
  PauseCircle,
  Ban,
  UserCheck,
  Timer,
  Eye
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { format, formatDistanceToNow, subDays, startOfDay } from 'date-fns';

interface AccountStats {
  id: string;
  phone_number: string;
  status: string;
  messages_sent_today: number;
  daily_limit: number;
  restricted_until: string | null;
  ban_reason: string | null;
  last_active: string | null;
  spambot_status: string;
}

interface CampaignStats {
  id: string;
  name: string;
  status: string;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  reply_count: number;
  created_at: string;
}

interface RecipientStats {
  status: string;
  count: number;
  failed_reason?: string;
}

const Reports: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountStats[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignStats[]>([]);
  const [recipientStats, setRecipientStats] = useState<RecipientStats[]>([]);
  const [messageStats, setMessageStats] = useState({
    total: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    pending: 0,
    incoming: 0,
    outgoing: 0
  });
  const [failedReasons, setFailedReasons] = useState<{reason: string; count: number}[]>([]);
  const [todayStats, setTodayStats] = useState({ sent: 0, failed: 0, conversations: 0 });
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const fetchReportData = async () => {
    setIsLoading(true);
    try {
      // Fetch accounts
      const { data: accountsData } = await supabase
        .from('telegram_accounts')
        .select('id, phone_number, status, messages_sent_today, daily_limit, restricted_until, ban_reason, last_active, spambot_status')
        .order('status', { ascending: true });
      
      setAccounts(accountsData || []);

      // Fetch campaigns
      const { data: campaignsData } = await supabase
        .from('campaigns')
        .select('id, name, status, recipient_count, sent_count, failed_count, reply_count, created_at')
        .order('created_at', { ascending: false });
      
      setCampaigns(campaignsData || []);

      // Fetch recipient stats by status
      const { data: pendingRecipients } = await supabase
        .from('campaign_recipients')
        .select('status')
        .eq('status', 'pending');
      
      const { data: sentRecipients } = await supabase
        .from('campaign_recipients')
        .select('status')
        .eq('status', 'sent');
      
      const { data: failedRecipients } = await supabase
        .from('campaign_recipients')
        .select('status, failed_reason')
        .eq('status', 'failed');
      
      const { data: invalidRecipients } = await supabase
        .from('campaign_recipients')
        .select('status')
        .eq('status', 'invalid');

      // Count failed reasons
      const reasonCounts: Record<string, number> = {};
      (failedRecipients || []).forEach(r => {
        const reason = r.failed_reason || 'Unknown error';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      });
      
      setFailedReasons(
        Object.entries(reasonCounts)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count)
      );

      setRecipientStats([
        { status: 'pending', count: pendingRecipients?.length || 0 },
        { status: 'sent', count: sentRecipients?.length || 0 },
        { status: 'failed', count: failedRecipients?.length || 0 },
        { status: 'invalid', count: invalidRecipients?.length || 0 },
      ]);

      // Fetch message stats
      const { data: allMessages } = await supabase
        .from('messages')
        .select('status, direction');
      
      const msgs = allMessages || [];
      setMessageStats({
        total: msgs.length,
        sent: msgs.filter(m => m.status === 'sent').length,
        delivered: msgs.filter(m => m.status === 'delivered').length,
        failed: msgs.filter(m => m.status === 'failed').length,
        pending: msgs.filter(m => m.status === 'pending').length,
        incoming: msgs.filter(m => m.direction === 'incoming').length,
        outgoing: msgs.filter(m => m.direction === 'outgoing').length,
      });

      // Today's stats
      const today = startOfDay(new Date()).toISOString();
      const { data: todayMessages } = await supabase
        .from('messages')
        .select('status, direction')
        .gte('created_at', today);

      const { data: todayConversations } = await supabase
        .from('conversations')
        .select('id')
        .gte('created_at', today);

      const todayMsgs = todayMessages || [];
      setTodayStats({
        sent: todayMsgs.filter(m => m.direction === 'outgoing' && (m.status === 'sent' || m.status === 'delivered')).length,
        failed: todayMsgs.filter(m => m.status === 'failed').length,
        conversations: todayConversations?.length || 0
      });

      setLastRefresh(new Date());
    } catch (error) {
      console.error('Error fetching report data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReportData();
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchReportData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Calculate derived stats
  const activeAccounts = accounts.filter(a => a.status === 'active');
  const restrictedAccounts = accounts.filter(a => a.status === 'restricted' || (a.restricted_until && new Date(a.restricted_until) > new Date()));
  const totalDailyCapacity = activeAccounts.reduce((sum, a) => sum + (a.daily_limit || 25), 0);
  const usedCapacity = activeAccounts.reduce((sum, a) => sum + (a.messages_sent_today || 0), 0);
  const capacityPercent = totalDailyCapacity > 0 ? (usedCapacity / totalDailyCapacity) * 100 : 0;

  const runningCampaigns = campaigns.filter(c => c.status === 'running');
  const completedCampaigns = campaigns.filter(c => c.status === 'completed');
  const failedCampaigns = campaigns.filter(c => c.status === 'failed');

  const totalRecipients = recipientStats.reduce((sum, r) => sum + r.count, 0);
  const sentRecipients = recipientStats.find(r => r.status === 'sent')?.count || 0;
  const failedRecipientCount = recipientStats.find(r => r.status === 'failed')?.count || 0;
  const pendingRecipientCount = recipientStats.find(r => r.status === 'pending')?.count || 0;
  
  const deliveryRate = (messageStats.outgoing > 0) 
    ? ((messageStats.sent + messageStats.delivered) / messageStats.outgoing * 100) 
    : 0;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-500';
      case 'restricted': return 'bg-orange-500';
      case 'banned': return 'bg-red-500';
      case 'disconnected': return 'bg-gray-500';
      default: return 'bg-gray-400';
    }
  };

  const getCampaignStatusBadge = (status: string) => {
    const baseClass = "text-xs font-semibold px-2.5 py-1";
    switch (status) {
      case 'running': 
        return (
          <Badge className={`${baseClass} bg-primary/20 text-primary border border-primary/30 animate-pulse`}>
            <span className="w-1.5 h-1.5 rounded-full bg-primary mr-1.5 animate-pulse" />
            RUNNING
          </Badge>
        );
      case 'completed': 
        return (
          <Badge className={`${baseClass} bg-green-500/20 text-green-600 border border-green-500/30`}>
            <CheckCircle className="w-3 h-3 mr-1" />
            COMPLETED
          </Badge>
        );
      case 'failed': 
        return (
          <Badge className={`${baseClass} bg-destructive/20 text-destructive border border-destructive/30`}>
            <XCircle className="w-3 h-3 mr-1" />
            FAILED
          </Badge>
        );
      case 'paused': 
        return (
          <Badge className={`${baseClass} bg-yellow-500/20 text-yellow-600 border border-yellow-500/30`}>
            <PauseCircle className="w-3 h-3 mr-1" />
            PAUSED
          </Badge>
        );
      case 'draft': 
        return <Badge className={`${baseClass} bg-muted text-muted-foreground border border-border`}>DRAFT</Badge>;
      default: 
        return <Badge className={`${baseClass} bg-muted text-muted-foreground border border-border`}>{status?.toUpperCase()}</Badge>;
    }
  };

  return (
    <DashboardLayout>
      <PageHeader 
        title="Reports & Analytics" 
        description="Comprehensive overview of your messaging operations"
      />

      <div className="space-y-6">
        {/* Header Actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="w-4 h-4" />
            Last updated: {format(lastRefresh, 'HH:mm:ss')}
          </div>
          <Button variant="outline" size="sm" onClick={fetchReportData} disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Accounts</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{activeAccounts.length}</span>
                <span className="text-sm text-muted-foreground">/ {accounts.length}</span>
              </div>
              <p className="text-xs text-green-500 mt-1">Active</p>
            </CardContent>
          </Card>

          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Target className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Campaigns</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{runningCampaigns.length}</span>
                <span className="text-sm text-muted-foreground">running</span>
              </div>
              <p className="text-xs text-blue-500 mt-1">{completedCampaigns.length} completed</p>
            </CardContent>
          </Card>

          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Send className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Sent Today</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{todayStats.sent}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{todayStats.failed} failed</p>
            </CardContent>
          </Card>

          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <MessageSquare className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Conversations</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{todayStats.conversations}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">new today</p>
            </CardContent>
          </Card>

          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Delivery Rate</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className={`text-2xl font-bold ${deliveryRate >= 90 ? 'text-green-500' : deliveryRate >= 70 ? 'text-yellow-500' : 'text-red-500'}`}>
                  {deliveryRate.toFixed(1)}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{messageStats.sent + messageStats.delivered} / {messageStats.outgoing}</p>
            </CardContent>
          </Card>

          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Capacity</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{usedCapacity}</span>
                <span className="text-sm text-muted-foreground">/ {totalDailyCapacity}</span>
              </div>
              <Progress value={capacityPercent} className="h-1 mt-2" />
            </CardContent>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="errors">Errors & Issues</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Campaign Progress */}
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5" />
                    Campaign Progress
                  </CardTitle>
                  <CardDescription>Current status of all campaigns</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[300px]">
                    {campaigns.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <Target className="w-12 h-12 mx-auto mb-3 opacity-50" />
                        <p>No campaigns yet</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {campaigns.slice(0, 10).map(campaign => {
                          const progress = campaign.recipient_count > 0 
                            ? ((campaign.sent_count + campaign.failed_count) / campaign.recipient_count) * 100 
                            : 0;
                          const pending = campaign.recipient_count - campaign.sent_count - campaign.failed_count;
                          
                          return (
                            <div key={campaign.id} className="p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors">
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <span className="font-medium truncate">{campaign.name}</span>
                                  {getCampaignStatusBadge(campaign.status)}
                                </div>
                                
                                {/* Stats inline */}
                                <div className="flex items-center gap-4 text-sm shrink-0">
                                  <span className="text-muted-foreground">{campaign.recipient_count} total</span>
                                  <span className="text-primary font-medium">{campaign.sent_count} sent</span>
                                  <span className="text-destructive font-medium">{campaign.failed_count} failed</span>
                                  <span className="font-bold text-foreground">{progress.toFixed(0)}%</span>
                                </div>
                                
                                {/* View Details Button */}
                                <Dialog>
                                  <DialogTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                                      <Eye className="w-4 h-4" />
                                    </Button>
                                  </DialogTrigger>
                                  <DialogContent className="max-w-lg">
                                    <DialogHeader>
                                      <DialogTitle className="flex items-center gap-2">
                                        {campaign.name}
                                        {getCampaignStatusBadge(campaign.status)}
                                      </DialogTitle>
                                      <DialogDescription>Campaign details</DialogDescription>
                                    </DialogHeader>
                                    
                                    <div className="space-y-4 mt-4">
                                      {/* Stats Summary */}
                                      <div className="grid grid-cols-4 gap-3">
                                        <div className="bg-muted/30 rounded-lg p-3 text-center">
                                          <p className="text-2xl font-bold">{campaign.recipient_count}</p>
                                          <p className="text-xs text-muted-foreground">Total</p>
                                        </div>
                                        <div className="bg-primary/10 rounded-lg p-3 text-center">
                                          <p className="text-2xl font-bold text-primary">{campaign.sent_count}</p>
                                          <p className="text-xs text-muted-foreground">Sent</p>
                                        </div>
                                        <div className="bg-destructive/10 rounded-lg p-3 text-center">
                                          <p className="text-2xl font-bold text-destructive">{campaign.failed_count}</p>
                                          <p className="text-xs text-muted-foreground">Failed</p>
                                        </div>
                                        <div className="bg-yellow-500/10 rounded-lg p-3 text-center">
                                          <p className="text-2xl font-bold text-yellow-600">{pending > 0 ? pending : 0}</p>
                                          <p className="text-xs text-muted-foreground">Pending</p>
                                        </div>
                                      </div>
                                      
                                      {/* Additional Info */}
                                      <div className="space-y-2 text-sm">
                                        <div className="flex justify-between">
                                          <span className="text-muted-foreground">Created</span>
                                          <span>{format(new Date(campaign.created_at), 'MMM d, yyyy HH:mm')}</span>
                                        </div>
                                        {campaign.reply_count > 0 && (
                                          <div className="flex justify-between">
                                            <span className="text-muted-foreground">Replies</span>
                                            <span className="text-primary">{campaign.reply_count}</span>
                                          </div>
                                        )}
                                        <div className="flex justify-between">
                                          <span className="text-muted-foreground">Progress</span>
                                          <span className="font-bold">{progress.toFixed(1)}%</span>
                                        </div>
                                      </div>
                                    </div>
                                  </DialogContent>
                                </Dialog>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Quick Stats */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="w-5 h-5" />
                    Message Statistics
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-green-500" />
                        <span className="text-sm">Delivered</span>
                      </div>
                      <span className="font-medium">{messageStats.delivered}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-blue-500" />
                        <span className="text-sm">Sent</span>
                      </div>
                      <span className="font-medium">{messageStats.sent}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-yellow-500" />
                        <span className="text-sm">Pending</span>
                      </div>
                      <span className="font-medium">{messageStats.pending}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-red-500" />
                        <span className="text-sm">Failed</span>
                      </div>
                      <span className="font-medium">{messageStats.failed}</span>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ArrowUpRight className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm">Outgoing</span>
                      </div>
                      <span className="font-medium">{messageStats.outgoing}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ArrowDownRight className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm">Incoming</span>
                      </div>
                      <span className="font-medium">{messageStats.incoming}</span>
                    </div>
                  </div>

                  <Separator />

                  <div className="text-center p-4 rounded-lg bg-muted/50">
                    <p className="text-3xl font-bold">{messageStats.total}</p>
                    <p className="text-sm text-muted-foreground">Total Messages</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Recipient Status */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserCheck className="w-5 h-5" />
                  Campaign Recipients Status
                </CardTitle>
                <CardDescription>Distribution of recipient statuses across all campaigns</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="p-4 rounded-lg border bg-yellow-500/5 border-yellow-500/20">
                    <div className="flex items-center gap-2 mb-2">
                      <Clock className="w-5 h-5 text-yellow-500" />
                      <span className="font-medium">Pending</span>
                    </div>
                    <p className="text-3xl font-bold">{pendingRecipientCount}</p>
                    <p className="text-sm text-muted-foreground mt-1">Waiting to send</p>
                  </div>
                  
                  <div className="p-4 rounded-lg border bg-green-500/5 border-green-500/20">
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle className="w-5 h-5 text-green-500" />
                      <span className="font-medium">Sent</span>
                    </div>
                    <p className="text-3xl font-bold">{sentRecipients}</p>
                    <p className="text-sm text-muted-foreground mt-1">Successfully delivered</p>
                  </div>
                  
                  <div className="p-4 rounded-lg border bg-red-500/5 border-red-500/20">
                    <div className="flex items-center gap-2 mb-2">
                      <XCircle className="w-5 h-5 text-red-500" />
                      <span className="font-medium">Failed</span>
                    </div>
                    <p className="text-3xl font-bold">{failedRecipientCount}</p>
                    <p className="text-sm text-muted-foreground mt-1">Delivery failed</p>
                  </div>
                  
                  <div className="p-4 rounded-lg border bg-gray-500/5 border-gray-500/20">
                    <div className="flex items-center gap-2 mb-2">
                      <Ban className="w-5 h-5 text-gray-500" />
                      <span className="font-medium">Invalid</span>
                    </div>
                    <p className="text-3xl font-bold">{recipientStats.find(r => r.status === 'invalid')?.count || 0}</p>
                    <p className="text-sm text-muted-foreground mt-1">Invalid numbers</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Campaigns Tab */}
          <TabsContent value="campaigns" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <Card className="bg-blue-500/5 border-blue-500/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <PlayCircle className="w-8 h-8 text-blue-500" />
                    <div>
                      <p className="text-2xl font-bold">{runningCampaigns.length}</p>
                      <p className="text-sm text-muted-foreground">Running</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-green-500/5 border-green-500/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-8 h-8 text-green-500" />
                    <div>
                      <p className="text-2xl font-bold">{completedCampaigns.length}</p>
                      <p className="text-sm text-muted-foreground">Completed</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-red-500/5 border-red-500/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <XCircle className="w-8 h-8 text-red-500" />
                    <div>
                      <p className="text-2xl font-bold">{failedCampaigns.length}</p>
                      <p className="text-sm text-muted-foreground">Failed</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>All Campaigns</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <div className="space-y-3">
                    {campaigns.map(campaign => {
                      const progress = campaign.recipient_count > 0 
                        ? ((campaign.sent_count + campaign.failed_count) / campaign.recipient_count) * 100 
                        : 0;
                      
                      return (
                        <div key={campaign.id} className="p-4 rounded-lg border hover:bg-muted/50 transition-colors">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <span className="font-medium text-lg">{campaign.name}</span>
                              {getCampaignStatusBadge(campaign.status)}
                            </div>
                            <div className="text-sm text-muted-foreground flex items-center gap-1">
                              <Calendar className="w-4 h-4" />
                              {format(new Date(campaign.created_at), 'MMM d, yyyy HH:mm')}
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-5 gap-4 text-sm">
                            <div className="text-center p-2 rounded bg-muted/50">
                              <p className="text-muted-foreground text-xs mb-1">Recipients</p>
                              <p className="font-bold text-lg">{campaign.recipient_count}</p>
                            </div>
                            <div className="text-center p-2 rounded bg-green-500/10">
                              <p className="text-muted-foreground text-xs mb-1">Sent</p>
                              <p className="font-bold text-lg text-green-500">{campaign.sent_count}</p>
                            </div>
                            <div className="text-center p-2 rounded bg-red-500/10">
                              <p className="text-muted-foreground text-xs mb-1">Failed</p>
                              <p className="font-bold text-lg text-red-500">{campaign.failed_count}</p>
                            </div>
                            <div className="text-center p-2 rounded bg-blue-500/10">
                              <p className="text-muted-foreground text-xs mb-1">Replies</p>
                              <p className="font-bold text-lg text-blue-500">{campaign.reply_count}</p>
                            </div>
                            <div className="text-center p-2 rounded bg-muted/50">
                              <p className="text-muted-foreground text-xs mb-1">Progress</p>
                              <p className="font-bold text-lg">{progress.toFixed(0)}%</p>
                            </div>
                          </div>
                          
                          <Progress value={progress} className="h-1.5 mt-3" />
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Accounts Tab */}
          <TabsContent value="accounts" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
              <Card className="bg-green-500/5 border-green-500/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-8 h-8 text-green-500" />
                    <div>
                      <p className="text-2xl font-bold">{activeAccounts.length}</p>
                      <p className="text-sm text-muted-foreground">Active</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-orange-500/5 border-orange-500/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="w-8 h-8 text-orange-500" />
                    <div>
                      <p className="text-2xl font-bold">{restrictedAccounts.length}</p>
                      <p className="text-sm text-muted-foreground">Restricted</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-blue-500/5 border-blue-500/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <Zap className="w-8 h-8 text-blue-500" />
                    <div>
                      <p className="text-2xl font-bold">{usedCapacity}</p>
                      <p className="text-sm text-muted-foreground">Sent Today</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-purple-500/5 border-purple-500/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <Target className="w-8 h-8 text-purple-500" />
                    <div>
                      <p className="text-2xl font-bold">{totalDailyCapacity - usedCapacity}</p>
                      <p className="text-sm text-muted-foreground">Remaining Capacity</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Account Status</CardTitle>
                <CardDescription>Real-time status of all Telegram accounts</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <div className="space-y-2">
                    {accounts.map(account => {
                      const usagePercent = (account.messages_sent_today / (account.daily_limit || 25)) * 100;
                      const isTemporarilyRestricted = account.restricted_until && new Date(account.restricted_until) > new Date();
                      
                      return (
                        <div key={account.id} className={`p-4 rounded-lg border transition-colors ${
                          account.status === 'active' && !isTemporarilyRestricted ? 'bg-card' :
                          isTemporarilyRestricted ? 'bg-orange-500/5 border-orange-500/20' :
                          account.status === 'restricted' ? 'bg-orange-500/5 border-orange-500/20' :
                          account.status === 'banned' ? 'bg-red-500/5 border-red-500/20' :
                          'bg-muted/50'
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                              <div className={`w-3 h-3 rounded-full ${getStatusColor(isTemporarilyRestricted ? 'restricted' : account.status)}`} />
                              <div className="flex items-center gap-2">
                                <Phone className="w-4 h-4 text-muted-foreground" />
                                <span className="font-medium">{account.phone_number}</span>
                              </div>
                              {account.spambot_status === 'clean' && (
                                <Badge variant="outline" className="text-green-500 border-green-500/30">
                                  <Shield className="w-3 h-3 mr-1" /> Clean
                                </Badge>
                              )}
                              {account.spambot_status === 'limited' && (
                                <Badge variant="outline" className="text-orange-500 border-orange-500/30">
                                  <AlertCircle className="w-3 h-3 mr-1" /> Limited
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-sm">
                              <div className="text-right">
                                <span className="text-muted-foreground">Today: </span>
                                <span className="font-medium">{account.messages_sent_today} / {account.daily_limit || 25}</span>
                              </div>
                              <Progress value={usagePercent} className="w-20 h-2" />
                            </div>
                          </div>
                          
                          {(account.ban_reason || isTemporarilyRestricted) && (
                            <div className="mt-2 p-2 rounded bg-muted/50 text-sm">
                              {account.ban_reason && (
                                <div className="flex items-center gap-2 text-orange-500">
                                  <AlertTriangle className="w-4 h-4" />
                                  <span>{account.ban_reason}</span>
                                </div>
                              )}
                              {isTemporarilyRestricted && (
                                <div className="flex items-center gap-2 text-muted-foreground mt-1">
                                  <Timer className="w-4 h-4" />
                                  <span>Restricted until: {format(new Date(account.restricted_until!), 'MMM d, HH:mm')}</span>
                                </div>
                              )}
                            </div>
                          )}
                          
                          {account.last_active && (
                            <p className="text-xs text-muted-foreground mt-2">
                              Last active: {formatDistanceToNow(new Date(account.last_active), { addSuffix: true })}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Errors Tab */}
          <TabsContent value="errors" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Error Summary */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                    Error Breakdown
                  </CardTitle>
                  <CardDescription>Most common failure reasons</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px]">
                    {failedReasons.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-50 text-green-500" />
                        <p>No errors recorded</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {failedReasons.map((item, index) => (
                          <div key={index} className="p-3 rounded-lg border bg-destructive/5 border-destructive/20">
                            <div className="flex items-center justify-between mb-2">
                              <Badge variant="destructive">{item.count} occurrences</Badge>
                            </div>
                            <p className="text-sm">{item.reason}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Restricted Accounts */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Shield className="w-5 h-5 text-orange-500" />
                    Restricted Accounts
                  </CardTitle>
                  <CardDescription>Accounts with sending limitations</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px]">
                    {restrictedAccounts.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-50 text-green-500" />
                        <p>No restricted accounts</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {restrictedAccounts.map(account => (
                          <div key={account.id} className="p-3 rounded-lg border bg-orange-500/5 border-orange-500/20">
                            <div className="flex items-center gap-2 mb-2">
                              <Phone className="w-4 h-4" />
                              <span className="font-medium">{account.phone_number}</span>
                            </div>
                            {account.ban_reason && (
                              <p className="text-sm text-muted-foreground mb-2">{account.ban_reason}</p>
                            )}
                            {account.restricted_until && (
                              <div className="flex items-center gap-2 text-xs text-orange-500">
                                <Timer className="w-3 h-3" />
                                <span>Until: {format(new Date(account.restricted_until), 'MMM d, HH:mm')}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>

            {/* System Health */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="w-5 h-5" />
                  System Health Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className={`p-4 rounded-lg border ${activeAccounts.length > 0 ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      {activeAccounts.length > 0 ? (
                        <CheckCircle className="w-5 h-5 text-green-500" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-500" />
                      )}
                      <span className="font-medium">Account Availability</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {activeAccounts.length > 0 
                        ? `${activeAccounts.length} accounts ready to send`
                        : 'No active accounts available'}
                    </p>
                  </div>

                  <div className={`p-4 rounded-lg border ${capacityPercent < 80 ? 'bg-green-500/5 border-green-500/20' : capacityPercent < 95 ? 'bg-yellow-500/5 border-yellow-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      {capacityPercent < 80 ? (
                        <CheckCircle className="w-5 h-5 text-green-500" />
                      ) : capacityPercent < 95 ? (
                        <AlertCircle className="w-5 h-5 text-yellow-500" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-500" />
                      )}
                      <span className="font-medium">Daily Capacity</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {capacityPercent < 80 
                        ? `${(100 - capacityPercent).toFixed(0)}% capacity remaining`
                        : capacityPercent < 95
                        ? 'Running low on capacity'
                        : 'Daily limit reached'}
                    </p>
                  </div>

                  <div className={`p-4 rounded-lg border ${deliveryRate >= 90 ? 'bg-green-500/5 border-green-500/20' : deliveryRate >= 70 ? 'bg-yellow-500/5 border-yellow-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      {deliveryRate >= 90 ? (
                        <CheckCircle className="w-5 h-5 text-green-500" />
                      ) : deliveryRate >= 70 ? (
                        <AlertCircle className="w-5 h-5 text-yellow-500" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-500" />
                      )}
                      <span className="font-medium">Delivery Health</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {deliveryRate >= 90 
                        ? 'Excellent delivery rate'
                        : deliveryRate >= 70
                        ? 'Moderate delivery issues'
                        : 'High failure rate - check accounts'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
};

export default Reports;
