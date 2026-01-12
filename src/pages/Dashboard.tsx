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
import { 
  LayoutDashboard, 
  Phone, 
  MessageSquare, 
  Send,
  RefreshCw,
  Loader2,
  Globe,
  Users,
  TrendingUp,
  Clock,
  Infinity,
  Reply
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface DashboardStats {
  totalAccounts: number;
  activeAccounts: number;
  activeProxies: number;
  messagesToday: number;
  messagesLifetime: number;
  repliesLifetime: number;
}

const Dashboard: React.FC = () => {
  const { campaigns, proxies, refreshData } = useTelegram();
  const navigate = useNavigate();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [stats, setStats] = useState<DashboardStats>({
    totalAccounts: 0,
    activeAccounts: 0,
    activeProxies: 0,
    messagesToday: 0,
    messagesLifetime: 0,
    repliesLifetime: 0,
  });

  const fetchStats = async () => {
    try {
      // Use count queries for accuracy (avoids 1000 row limit issue)
      const [
        totalAccountsRes,
        activeAccountsRes,
        activeProxiesRes,
        messagesTodayRes,
        messagesLifetimeRes,
        repliesLifetimeRes
      ] = await Promise.all([
        // Total accounts
        supabase
          .from('telegram_accounts')
          .select('id', { count: 'exact', head: true }),
        // Active accounts
        supabase
          .from('telegram_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
        // Active proxies
        supabase
          .from('proxies')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
        // Messages today
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('direction', 'outgoing')
          .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
        // Lifetime messages
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('direction', 'outgoing'),
        // Lifetime replies
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('direction', 'incoming'),
      ]);

      setStats({
        totalAccounts: totalAccountsRes.count || 0,
        activeAccounts: activeAccountsRes.count || 0,
        activeProxies: activeProxiesRes.count || 0,
        messagesToday: messagesTodayRes.count || 0,
        messagesLifetime: messagesLifetimeRes.count || 0,
        repliesLifetime: repliesLifetimeRes.count || 0,
      });
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
      
      {/* Account & Proxy Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard
          title="Total Accounts"
          value={stats.totalAccounts}
          icon={Phone}
          variant="primary"
          index={0}
        />
        <StatCard
          title="Active Accounts"
          value={stats.activeAccounts}
          icon={Users}
          variant="success"
          index={1}
        />
        <StatCard
          title="Active Proxies"
          value={stats.activeProxies}
          icon={Globe}
          variant="default"
          index={2}
        />
      </div>

      {/* Message Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <StatCard
          title="Messages Today"
          value={stats.messagesToday}
          icon={Clock}
          variant="warning"
          index={3}
        />
        <StatCard
          title="Lifetime Messages"
          value={stats.messagesLifetime}
          icon={Send}
          variant="default"
          index={4}
        />
        <StatCard
          title="Lifetime Replies"
          value={stats.repliesLifetime}
          icon={MessageSquare}
          variant="success"
          index={5}
        />
      </div>

      {/* Runner Status */}
      <div className="mb-8">
        <RunnerStatusCard />
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
