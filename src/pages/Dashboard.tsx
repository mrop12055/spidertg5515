import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useDashboardStats } from '@/hooks/useDashboardStats';
import { useCampaigns } from '@/hooks/useCampaigns';

import { TaskQueueCard } from '@/components/dashboard/TaskQueueCard';
import { RecentErrorsCard } from '@/components/dashboard/RecentErrorsCard';
import { 
  LayoutDashboard, 
  Phone, 
  MessageSquare, 
  Send,
  Globe,
  Users,
  TrendingUp,
  Clock,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const Dashboard: React.FC = () => {
  const { stats } = useDashboardStats();
  const { campaigns } = useCampaigns();
  const navigate = useNavigate();

  const runningCampaigns = campaigns.filter(c => c.status === 'running').length;

  return (
    <DashboardLayout>
      <PageHeader 
        title="Dashboard" 
        description="Monitor your TGxOP bulk messaging system"
        icon={LayoutDashboard}
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

      {/* Task Queue & Errors Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
        <TaskQueueCard />
        <RecentErrorsCard />
      </div>

      {/* Python Runner Download */}
      <RunnerDownloadCard />
    </DashboardLayout>

  );
};

export default Dashboard;
