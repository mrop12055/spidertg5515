import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/ui/stat-card';
import { useTelegram } from '@/context/TelegramContext';
import { 
  LayoutDashboard, 
  Users, 
  Server, 
  MessageSquare, 
  Send,
  AlertTriangle,
  CheckCircle2,
  Ban
} from 'lucide-react';

const Dashboard: React.FC = () => {
  const { stats } = useTelegram();

  return (
    <DashboardLayout>
      <PageHeader 
        title="Dashboard" 
        description="Overview of your Telegram accounts and messaging"
        icon={LayoutDashboard}
      />
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          title="Total Accounts"
          value={stats.totalAccounts}
          icon={Users}
          variant="primary"
          trend={{ value: 12, isPositive: true }}
        />
        <StatCard
          title="Active Accounts"
          value={stats.activeAccounts}
          icon={CheckCircle2}
          variant="success"
        />
        <StatCard
          title="Banned Accounts"
          value={stats.bannedAccounts}
          icon={Ban}
          variant="danger"
        />
        <StatCard
          title="Restricted"
          value={stats.restrictedAccounts}
          icon={AlertTriangle}
          variant="warning"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Active Proxies"
          value={`${stats.activeProxies}/${stats.totalProxies}`}
          icon={Server}
          variant="default"
        />
        <StatCard
          title="Messages Today"
          value={stats.messagesToday}
          icon={Send}
          variant="primary"
          trend={{ value: 8, isPositive: true }}
        />
        <StatCard
          title="Replies Received"
          value={stats.repliesReceived}
          icon={MessageSquare}
          variant="success"
        />
        <StatCard
          title="Campaigns Running"
          value={stats.campaignsRunning}
          icon={Send}
          variant="default"
        />
      </div>

      <div className="mt-8 p-6 rounded-xl bg-card border border-border">
        <h2 className="text-lg font-semibold mb-4">Quick Start Guide</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-lg bg-secondary/50">
            <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center mb-3">
              <span className="text-primary-foreground font-bold">1</span>
            </div>
            <h3 className="font-medium mb-1">Upload Accounts</h3>
            <p className="text-sm text-muted-foreground">Upload ZIP with session files to add accounts in bulk</p>
          </div>
          <div className="p-4 rounded-lg bg-secondary/50">
            <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center mb-3">
              <span className="text-primary-foreground font-bold">2</span>
            </div>
            <h3 className="font-medium mb-1">Assign Proxies</h3>
            <p className="text-sm text-muted-foreground">Add proxies and assign one to each account for safety</p>
          </div>
          <div className="p-4 rounded-lg bg-secondary/50">
            <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center mb-3">
              <span className="text-primary-foreground font-bold">3</span>
            </div>
            <h3 className="font-medium mb-1">Mature & Message</h3>
            <p className="text-sm text-muted-foreground">Warm up accounts for 10-15 days before bulk messaging</p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Dashboard;
