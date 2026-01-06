import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useTelegram } from '@/context/TelegramContext';
import { supabase } from '@/integrations/supabase/client';
import { RunnerStatusCard } from '@/components/dashboard/RunnerStatus';
import { VPSManager } from '@/components/dashboard/VPSManager';
import { 
  LayoutDashboard, 
  Phone, 
  MessageSquare, 
  Send,
  RefreshCw,
  Loader2,
  Globe,
  Users,
  TrendingUp
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const Dashboard: React.FC = () => {
  const { campaigns, accounts, proxies, refreshData } = useTelegram();
  const navigate = useNavigate();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [messages24h, setMessages24h] = useState(0);
  const [replies24h, setReplies24h] = useState(0);

  // Active accounts: status is 'active' AND no restriction timer
  const activeAccounts = accounts.filter(a => 
    a.status === 'active' && !a.restrictedUntil
  ).length;

  const fetchStats = async () => {
    try {
      const yesterday = new Date();
      yesterday.setHours(yesterday.getHours() - 24);

      const [msgs24hRes, replies24hRes] = await Promise.all([
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'outgoing').gte('created_at', yesterday.toISOString()),
        supabase.from('messages').select('id', { count: 'exact', head: true })
          .eq('direction', 'incoming').gte('created_at', yesterday.toISOString()),
      ]);

      setMessages24h(msgs24hRes.count || 0);
      setReplies24h(replies24hRes.count || 0);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refreshData(), fetchStats()]);
    setIsRefreshing(false);
  };

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
          index={0}
        />
        <StatCard
          title="Active Accounts"
          value={activeAccounts}
          icon={Users}
          variant="success"
          index={1}
        />
        <StatCard
          title="Active Proxies"
          value={activeProxies}
          icon={Globe}
          variant="default"
          index={2}
        />
        <StatCard
          title="Messages (24h)"
          value={messages24h}
          icon={Send}
          variant="warning"
          index={3}
        />
        <StatCard
          title="Replies (24h)"
          value={replies24h}
          icon={MessageSquare}
          variant="default"
          index={4}
        />
      </div>

      {/* Runner Status & VPS Manager */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        <RunnerStatusCard />
        <VPSManager />
      </div>

      {/* Running Campaigns */}
      {runningCampaigns > 0 && (
        <Card className="border-green-500/30">
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
    </DashboardLayout>
  );
};

export default Dashboard;
