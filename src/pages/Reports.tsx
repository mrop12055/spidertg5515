import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useTelegram } from '@/context/TelegramContext';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Activity,
  MessageSquare,
  Send,
  TrendingUp
} from 'lucide-react';
import { format } from 'date-fns';

const Reports: React.FC = () => {
  const { messages, campaigns, conversations } = useTelegram();

  // Get failed messages
  const failedMessages = messages.filter(m => m.status === 'failed' && m.direction === 'outgoing');
  const deliveredMessages = messages.filter(m => m.status === 'delivered' && m.direction === 'outgoing');
  const pendingMessages = messages.filter(m => m.status === 'pending' && m.direction === 'outgoing');
  const sentMessages = messages.filter(m => m.status === 'sent' && m.direction === 'outgoing');

  // Calculate stats
  const totalOutgoing = messages.filter(m => m.direction === 'outgoing').length;
  const successRate = totalOutgoing > 0 ? ((deliveredMessages.length + sentMessages.length) / totalOutgoing * 100).toFixed(1) : '0';

  // Get running campaigns
  const runningCampaigns = campaigns.filter(c => c.status === 'running');

  return (
    <DashboardLayout>
      <PageHeader 
        title="Reports" 
        description="Monitor message delivery status and campaign performance"
      />

      <div className="space-y-6">
        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-green-500/10">
                  <CheckCircle className="w-6 h-6 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{deliveredMessages.length}</p>
                  <p className="text-sm text-muted-foreground">Delivered</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-blue-500/10">
                  <Send className="w-6 h-6 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{sentMessages.length}</p>
                  <p className="text-sm text-muted-foreground">Sent</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-destructive/10">
                  <XCircle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{failedMessages.length}</p>
                  <p className="text-sm text-muted-foreground">Failed</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-lg bg-yellow-500/10">
                  <Clock className="w-6 h-6 text-yellow-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{pendingMessages.length}</p>
                  <p className="text-sm text-muted-foreground">Pending</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Success Rate */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5" />
              Delivery Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="text-4xl font-bold text-primary">{successRate}%</div>
              <div className="text-muted-foreground">
                <p>Success Rate</p>
                <p className="text-sm">{deliveredMessages.length + sentMessages.length} of {totalOutgoing} messages delivered</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Failed Messages */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-destructive" />
                Failed Messages
                <Badge variant="destructive" className="ml-2">{failedMessages.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px]">
                {failedMessages.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>No failed messages</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {failedMessages.slice(0, 50).map((msg) => {
                      const conv = conversations.find(c => c.id === msg.conversationId);
                      return (
                        <div key={msg.id} className="p-3 rounded-lg border border-destructive/20 bg-destructive/5">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="font-medium text-sm">
                              {conv?.recipientName || conv?.recipientPhone || 'Unknown'}
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(msg.timestamp), 'MMM d, HH:mm')}
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                            {msg.content}
                          </p>
                          {msg.failedReason && (
                            <div className="flex items-center gap-1 text-xs text-destructive">
                              <XCircle className="w-3 h-3" />
                              {msg.failedReason}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Live Activity */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                Live Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px]">
                {/* Running Campaigns */}
                {runningCampaigns.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-medium mb-2 text-muted-foreground">Running Campaigns</h4>
                    {runningCampaigns.map(campaign => (
                      <div key={campaign.id} className="p-3 rounded-lg border bg-primary/5 border-primary/20 mb-2">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{campaign.name}</span>
                          <Badge variant="default">Running</Badge>
                        </div>
                        <div className="mt-2 text-sm text-muted-foreground">
                          {campaign.sentCount || 0} / {campaign.recipientCount || 0} sent
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Recent Messages */}
                <div>
                  <h4 className="text-sm font-medium mb-2 text-muted-foreground">Recent Activity</h4>
                  {messages
                    .filter(m => m.direction === 'outgoing')
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                    .slice(0, 20)
                    .map(msg => {
                      const conv = conversations.find(c => c.id === msg.conversationId);
                      return (
                        <div key={msg.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                          <div className={`w-2 h-2 rounded-full ${
                            msg.status === 'delivered' ? 'bg-green-500' :
                            msg.status === 'sent' ? 'bg-blue-500' :
                            msg.status === 'failed' ? 'bg-destructive' :
                            'bg-yellow-500'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm truncate">
                              {conv?.recipientName || conv?.recipientPhone || 'Unknown'}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">{msg.content}</p>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(msg.timestamp), 'HH:mm')}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Reports;
