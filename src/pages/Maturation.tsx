import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { StatusBadge } from '@/components/ui/status-badge';
import { 
  Sparkles, 
  Users, 
  MessageSquare, 
  Image, 
  UserPlus, 
  Eye,
  Play,
  Pause,
  RefreshCw
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface MaturationActivity {
  id: string;
  type: 'join_channel' | 'send_message' | 'view_content' | 'add_contact' | 'profile_update';
  label: string;
  icon: React.ElementType;
  description: string;
}

const activities: MaturationActivity[] = [
  { id: 'join', type: 'join_channel', label: 'Join Channels', icon: Users, description: 'Join public channels to build activity' },
  { id: 'view', type: 'view_content', label: 'View Content', icon: Eye, description: 'Browse and view channel content' },
  { id: 'message', type: 'send_message', label: 'Send Messages', icon: MessageSquare, description: 'Send casual messages in groups' },
  { id: 'contact', type: 'add_contact', label: 'Add Contacts', icon: UserPlus, description: 'Add contacts to build network' },
  { id: 'profile', type: 'profile_update', label: 'Update Profile', icon: Image, description: 'Update profile photo and bio' },
];

const Maturation: React.FC = () => {
  const { accounts, updateAccount } = useTelegram();
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [activeActivities, setActiveActivities] = useState<string[]>(['join', 'view']);
  const [isRunning, setIsRunning] = useState(false);

  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccounts(prev =>
      prev.includes(accountId)
        ? prev.filter(id => id !== accountId)
        : [...prev, accountId]
    );
  };

  const toggleActivity = (activityId: string) => {
    setActiveActivities(prev =>
      prev.includes(activityId)
        ? prev.filter(id => id !== activityId)
        : [...prev, activityId]
    );
  };

  const handleStartMaturation = () => {
    setIsRunning(true);
    // Simulate maturation progress
    selectedAccounts.forEach(accountId => {
      const account = accounts.find(a => a.id === accountId);
      if (account) {
        updateAccount(accountId, {
          maturityScore: Math.min(100, account.maturityScore + 5),
          maturityDays: account.maturityDays + 1
        });
      }
    });
  };

  const handleStopMaturation = () => {
    setIsRunning(false);
  };

  const getMaturityLevel = (score: number): { label: string; color: string } => {
    if (score >= 80) return { label: 'Mature', color: 'text-status-active' };
    if (score >= 50) return { label: 'Growing', color: 'text-primary' };
    if (score >= 20) return { label: 'New', color: 'text-status-warning' };
    return { label: 'Fresh', color: 'text-muted-foreground' };
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Account Maturation"
        description="Warm up accounts to avoid bans and restrictions"
        action={
          <Button
            onClick={isRunning ? handleStopMaturation : handleStartMaturation}
            disabled={selectedAccounts.length === 0}
            variant={isRunning ? 'destructive' : 'default'}
            className="gap-2"
          >
            {isRunning ? (
              <>
                <Pause className="w-4 h-4" />
                Stop Maturation
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Start Maturation
              </>
            )}
          </Button>
        }
      />

      <div className="grid grid-cols-12 gap-6">
        {/* Activities Configuration */}
        <div className="col-span-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                Maturation Activities
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {activities.map((activity) => (
                <div
                  key={activity.id}
                  className={cn(
                    "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                    activeActivities.includes(activity.id)
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                  onClick={() => toggleActivity(activity.id)}
                >
                  <Checkbox
                    checked={activeActivities.includes(activity.id)}
                    onCheckedChange={() => toggleActivity(activity.id)}
                  />
                  <activity.icon className={cn(
                    "w-5 h-5 mt-0.5",
                    activeActivities.includes(activity.id) ? "text-primary" : "text-muted-foreground"
                  )} />
                  <div className="flex-1">
                    <p className="font-medium text-sm">{activity.label}</p>
                    <p className="text-xs text-muted-foreground">{activity.description}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Maturation Stats</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Selected Accounts</span>
                  <span className="font-medium">{selectedAccounts.length}</span>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Active Activities</span>
                  <span className="font-medium">{activeActivities.length}</span>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={isRunning ? "default" : "secondary"}>
                    {isRunning ? 'Running' : 'Stopped'}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Accounts List */}
        <div className="col-span-8">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Accounts for Maturation</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedAccounts(
                    selectedAccounts.length === accounts.length 
                      ? [] 
                      : accounts.map(a => a.id)
                  )}
                >
                  {selectedAccounts.length === accounts.length ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  No accounts available for maturation
                </div>
              ) : (
                <div className="space-y-3">
                  {accounts.map((account) => {
                    const maturityLevel = getMaturityLevel(account.maturityScore);
                    const isSelected = selectedAccounts.includes(account.id);

                    return (
                      <div
                        key={account.id}
                        className={cn(
                          "flex items-center gap-4 p-4 rounded-lg border cursor-pointer transition-all",
                          isSelected
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50"
                        )}
                        onClick={() => toggleAccountSelection(account.id)}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleAccountSelection(account.id)}
                        />
                        <Avatar className="h-10 w-10">
                          <AvatarFallback className="bg-primary/20 text-primary">
                            {account.firstName?.charAt(0) || '?'}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {account.firstName} {account.lastName}
                            </span>
                            <StatusBadge status={account.status} size="sm" />
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {account.phoneNumber}
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={cn("text-sm font-medium", maturityLevel.color)}>
                              {maturityLevel.label}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              {account.maturityScore}%
                            </span>
                          </div>
                          <Progress value={account.maturityScore} className="w-24 h-2" />
                          <p className="text-xs text-muted-foreground mt-1">
                            {account.maturityDays} days
                          </p>
                        </div>
                        {isRunning && isSelected && (
                          <RefreshCw className="w-4 h-4 text-primary animate-spin" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Maturation;
