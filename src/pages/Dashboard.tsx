import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/ui/stat-card';
import { useTelegram } from '@/context/TelegramContext';
import { 
  LayoutDashboard, 
  Contact, 
  MessageSquare, 
  Send,
  CheckCircle2,
  Clock,
  ThumbsUp
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const Dashboard: React.FC = () => {
  const { campaigns, conversations } = useTelegram();
  const navigate = useNavigate();

  // Simple stats for the CRM
  const stats = {
    totalContacts: 0, // Will be managed locally in Contacts page
    activeCampaigns: campaigns.filter(c => c.status === 'running').length,
    totalConversations: conversations.length,
    pendingFollowups: conversations.filter(c => c.unreadCount > 0).length,
  };

  return (
    <DashboardLayout>
      <PageHeader 
        title="Dashboard" 
        description="Track your Telegram outreach and conversations"
        icon={LayoutDashboard}
      />
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          title="Active Campaigns"
          value={stats.activeCampaigns}
          icon={Send}
          variant="primary"
        />
        <StatCard
          title="Conversations"
          value={stats.totalConversations}
          icon={MessageSquare}
          variant="success"
        />
        <StatCard
          title="Pending Follow-ups"
          value={stats.pendingFollowups}
          icon={Clock}
          variant="warning"
        />
        <StatCard
          title="Total Campaigns"
          value={campaigns.length}
          icon={CheckCircle2}
          variant="default"
        />
      </div>

      <div className="mt-8 p-6 rounded-xl bg-card border border-border">
        <h2 className="text-lg font-semibold mb-4">How to Use TelegramCRM</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button 
            onClick={() => navigate('/contacts')}
            className="p-4 rounded-lg bg-secondary/50 text-left hover:bg-secondary/80 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center mb-3">
              <span className="text-primary-foreground font-bold">1</span>
            </div>
            <h3 className="font-medium mb-1">Add Contacts</h3>
            <p className="text-sm text-muted-foreground">Add contacts you want to reach out to on Telegram</p>
          </button>
          <button 
            onClick={() => navigate('/conversations')}
            className="p-4 rounded-lg bg-secondary/50 text-left hover:bg-secondary/80 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center mb-3">
              <span className="text-primary-foreground font-bold">2</span>
            </div>
            <h3 className="font-medium mb-1">Track Conversations</h3>
            <p className="text-sm text-muted-foreground">Log your conversations and track responses</p>
          </button>
          <button 
            onClick={() => navigate('/campaigns')}
            className="p-4 rounded-lg bg-secondary/50 text-left hover:bg-secondary/80 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center mb-3">
              <span className="text-primary-foreground font-bold">3</span>
            </div>
            <h3 className="font-medium mb-1">Organize Campaigns</h3>
            <p className="text-sm text-muted-foreground">Group contacts into campaigns for organized outreach</p>
          </button>
        </div>
      </div>

      <div className="mt-6 p-4 rounded-xl bg-primary/10 border border-primary/20">
        <div className="flex items-start gap-3">
          <ThumbsUp className="w-5 h-5 text-primary mt-0.5" />
          <div>
            <h3 className="font-medium text-foreground">Manual Messaging Mode</h3>
            <p className="text-sm text-muted-foreground mt-1">
              This CRM helps you organize and track contacts. Send messages manually via the Telegram app, then update conversation status here.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Dashboard;
