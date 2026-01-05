import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useTelegram } from '@/context/TelegramContext';
import { supabase } from '@/integrations/supabase/client';
import { 
  LayoutDashboard, 
  Phone, 
  MessageSquare, 
  Send,
  CheckCircle2,
  Clock,
  XCircle,
  RefreshCw,
  PlayCircle,
  Loader2,
  ArrowRight,
  BookOpen,
  Globe,
  Users,
  AlertTriangle,
  TrendingUp,
  Wifi,
  WifiOff
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface MessageQueueStats {
  pending: number;
  sent: number;
  failed: number;
  total: number;
}

interface AccountStats {
  active: number;
  restricted: number;
  inactive: number;
}

const Dashboard: React.FC = () => {
  const { campaigns, conversations, accounts, proxies, stats, refreshData } = useTelegram();
  const navigate = useNavigate();
  const [queueStats, setQueueStats] = useState<MessageQueueStats>({ pending: 0, sent: 0, failed: 0, total: 0 });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [messages24h, setMessages24h] = useState(0);
  const [replies24h, setReplies24h] = useState(0);
  const [uniqueRecipientsSent, setUniqueRecipientsSent] = useState(0);

  const accountStats = {
    active: accounts.filter(a => a.status === 'active').length,
    restricted: accounts.filter(a => a.status === 'restricted' || a.status === 'cooldown').length,
    inactive: accounts.filter(a => a.status === 'banned' || a.status === 'disconnected').length,
  };

  const fetchQueueStats = async () => {
    try {
      const yesterday = new Date();
      yesterday.setHours(yesterday.getHours() - 24);

      // Use optimized count queries instead of fetching all messages
      const [pendingRes, sentRes, failedRes, msgs24hRes, replies24hRes, uniqueConvsRes] = await Promise.all([
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'outgoing').eq('status', 'pending'),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'outgoing').in('status', ['sent', 'delivered']),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'outgoing').eq('status', 'failed'),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'outgoing').gte('created_at', yesterday.toISOString()),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'incoming').gte('created_at', yesterday.toISOString()),
        supabase.from('conversations').select('id', { count: 'exact', head: true })
          .not('last_message_at', 'is', null),
      ]);

      const pending = pendingRes.count || 0;
      const sent = sentRes.count || 0;
      const failed = failedRes.count || 0;
      
      setMessages24h(msgs24hRes.count || 0);
      setReplies24h(replies24hRes.count || 0);
      setUniqueRecipientsSent(uniqueConvsRes.count || 0);
      
      setQueueStats({
        pending,
        sent,
        failed,
        total: pending + sent + failed
      });
    } catch (error) {
      console.error('Error fetching queue stats:', error);
    }
  };

  useEffect(() => {
    fetchQueueStats();
    const interval = setInterval(fetchQueueStats, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refreshData(), fetchQueueStats()]);
    setIsRefreshing(false);
  };

  const activeAccounts = accounts.filter(a => a.status === 'active').length;
  const runningCampaigns = campaigns.filter(c => c.status === 'running').length;
  const activeProxies = proxies.filter(p => p.status === 'active').length;

  return (
    <DashboardLayout>
      <PageHeader 
        title="Dashboard" 
        description="Monitor your TGxOP bulk messaging system"
        icon={LayoutDashboard}
        action={
          <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
            {isRefreshing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            <span className="ml-2">Refresh</span>
          </Button>
        }
      />
      
      {/* Main Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <StatCard
          title="Total Accounts"
          value={accounts.length}
          icon={Phone}
          variant="primary"
        />
        <StatCard
          title="Active Accounts"
          value={activeAccounts}
          icon={Users}
          variant="success"
        />
        <StatCard
          title="Active Proxies"
          value={activeProxies}
          icon={Globe}
          variant="default"
        />
        <StatCard
          title="Messages (24h)"
          value={messages24h}
          icon={Send}
          variant="warning"
        />
        <StatCard
          title="Replies (24h)"
          value={replies24h}
          icon={MessageSquare}
          variant="default"
        />
      </div>

      {/* Account Status Overview */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5 text-primary" />
            Account Status Overview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div 
              className="p-4 rounded-lg bg-green-500/10 border border-green-500/30 cursor-pointer hover:bg-green-500/20 transition-colors"
              onClick={() => navigate('/accounts')}
            >
              <div className="flex items-center gap-2 mb-2">
                <Wifi className="w-5 h-5 text-green-600" />
                <span className="text-sm text-muted-foreground">Active</span>
              </div>
              <p className="text-2xl font-bold text-green-600">{accountStats.active}</p>
            </div>
            <div 
              className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 cursor-pointer hover:bg-yellow-500/20 transition-colors"
              onClick={() => navigate('/accounts')}
            >
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-5 h-5 text-yellow-600" />
                <span className="text-sm text-muted-foreground">Restricted</span>
              </div>
              <p className="text-2xl font-bold text-yellow-600">{accountStats.restricted}</p>
            </div>
            <div 
              className="p-4 rounded-lg bg-muted cursor-pointer hover:bg-muted/80 transition-colors"
              onClick={() => navigate('/accounts')}
            >
              <div className="flex items-center gap-2 mb-2">
                <WifiOff className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Inactive</span>
              </div>
              <p className="text-2xl font-bold">{accountStats.inactive}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Message Queue Monitor */}
      <Card className="mb-8 border-primary/30">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <PlayCircle className="w-5 h-5 text-primary" />
              Message Queue Monitor
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={fetchQueueStats}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {queueStats.total === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No messages in queue</p>
              <p className="text-sm mt-1">Create a campaign and start it to queue messages</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Progress */}
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-muted-foreground">Queue Progress</span>
                  <span className="font-medium">{queueStats.sent + queueStats.failed} / {queueStats.total}</span>
                </div>
                <Progress 
                  value={((queueStats.sent + queueStats.failed) / queueStats.total) * 100} 
                  className="h-3"
                />
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 rounded-lg bg-status-warning/10 border border-status-warning/30 text-center">
                  <Clock className="w-6 h-6 mx-auto mb-2 text-status-warning" />
                  <p className="text-2xl font-bold text-status-warning">{queueStats.pending}</p>
                  <p className="text-sm text-muted-foreground">Pending</p>
                </div>
                <div className="p-4 rounded-lg bg-status-active/10 border border-status-active/30 text-center">
                  <CheckCircle2 className="w-6 h-6 mx-auto mb-2 text-status-active" />
                  <p className="text-2xl font-bold text-status-active">{uniqueRecipientsSent}</p>
                  <p className="text-sm text-muted-foreground">Recipients Reached</p>
                </div>
                <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-center">
                  <XCircle className="w-6 h-6 mx-auto mb-2 text-destructive" />
                  <p className="text-2xl font-bold text-destructive">{queueStats.failed}</p>
                  <p className="text-sm text-muted-foreground">Failed</p>
                </div>
              </div>

              {/* Info */}
              {queueStats.pending > 0 && (
                <div className="p-4 rounded-lg bg-primary/10 border border-primary/30">
                  <div className="flex items-start gap-3">
                    <Loader2 className="w-5 h-5 text-primary animate-spin mt-0.5" />
                    <div>
                      <p className="font-medium">Messages waiting to be sent</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Run the Python sender script on your PC to send these messages.
                        <Button 
                          variant="link" 
                          className="p-0 h-auto ml-1" 
                          onClick={() => navigate('/setup')}
                        >
                          View Setup Guide <ArrowRight className="w-3 h-3 inline ml-1" />
                        </Button>
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Running Campaigns */}
      {runningCampaigns > 0 && (
        <Card className="mb-8 border-green-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-green-600" />
              Running Campaigns ({runningCampaigns})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {campaigns.filter(c => c.status === 'running').map(campaign => (
                <div 
                  key={campaign.id}
                  className="p-4 rounded-lg bg-green-500/5 border border-green-500/20 flex items-center justify-between cursor-pointer hover:bg-green-500/10 transition-colors"
                  onClick={() => navigate('/campaigns')}
                >
                  <div>
                    <p className="font-medium">{campaign.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {campaign.sentCount} / {campaign.recipientCount} sent
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Progress 
                      value={(campaign.sentCount / (campaign.recipientCount || 1)) * 100} 
                      className="w-32 h-2"
                    />
                    <span className="text-sm font-medium">
                      {Math.round((campaign.sentCount / (campaign.recipientCount || 1)) * 100)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card className="hover:border-primary/30 transition-colors cursor-pointer" onClick={() => navigate('/accounts')}>
          <CardContent className="p-6">
            <div className="w-10 h-10 rounded-lg gradient-primary flex items-center justify-center mb-4">
              <Phone className="w-5 h-5 text-primary-foreground" />
            </div>
            <h3 className="font-semibold mb-1">Add Accounts</h3>
            <p className="text-sm text-muted-foreground">Upload Telegram accounts with session files</p>
          </CardContent>
        </Card>
        <Card className="hover:border-primary/30 transition-colors cursor-pointer" onClick={() => navigate('/campaigns')}>
          <CardContent className="p-6">
            <div className="w-10 h-10 rounded-lg gradient-primary flex items-center justify-center mb-4">
              <Send className="w-5 h-5 text-primary-foreground" />
            </div>
            <h3 className="font-semibold mb-1">Create Campaign</h3>
            <p className="text-sm text-muted-foreground">Set up a bulk messaging campaign</p>
          </CardContent>
        </Card>
        <Card className="hover:border-primary/30 transition-colors cursor-pointer" onClick={() => navigate('/setup')}>
          <CardContent className="p-6">
            <div className="w-10 h-10 rounded-lg gradient-primary flex items-center justify-center mb-4">
              <BookOpen className="w-5 h-5 text-primary-foreground" />
            </div>
            <h3 className="font-semibold mb-1">Setup Guide</h3>
            <p className="text-sm text-muted-foreground">Download and run the sender script</p>
          </CardContent>
        </Card>
      </div>

      {/* Workflow Overview */}
      <Card>
        <CardHeader>
          <CardTitle>How It Works</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg bg-accent/50 relative">
              <Badge className="absolute -top-2 -left-2 bg-primary text-primary-foreground">1</Badge>
              <h4 className="font-medium mb-2 mt-2">Upload Accounts</h4>
              <p className="text-sm text-muted-foreground">Add your Telegram accounts with session data</p>
            </div>
            <div className="p-4 rounded-lg bg-accent/50 relative">
              <Badge className="absolute -top-2 -left-2 bg-primary text-primary-foreground">2</Badge>
              <h4 className="font-medium mb-2 mt-2">Create Campaign</h4>
              <p className="text-sm text-muted-foreground">Write your message and add recipients</p>
            </div>
            <div className="p-4 rounded-lg bg-accent/50 relative">
              <Badge className="absolute -top-2 -left-2 bg-primary text-primary-foreground">3</Badge>
              <h4 className="font-medium mb-2 mt-2">Queue Messages</h4>
              <p className="text-sm text-muted-foreground">Click Start to queue messages in database</p>
            </div>
            <div className="p-4 rounded-lg bg-accent/50 relative">
              <Badge className="absolute -top-2 -left-2 bg-primary text-primary-foreground">4</Badge>
              <h4 className="font-medium mb-2 mt-2">Run Sender Script</h4>
              <p className="text-sm text-muted-foreground">Python script on your PC sends messages</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </DashboardLayout>
  );
};

export default Dashboard;
