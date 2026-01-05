import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Send, MessageSquare, UserCog, Flame, Ban, CheckCircle2, XCircle, Activity, AlertTriangle, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRunnerStatus } from '@/hooks/useRunnerStatus';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

const runnerIcons: Record<string, { icon: React.ReactNode; color: string; functions: string[] }> = {
  campaign: {
    icon: <Send className="h-4 w-4" />,
    color: 'text-blue-500',
    functions: ['Send messages', 'Validate recipients'],
  },
  livechat_receiver: {
    icon: <MessageSquare className="h-4 w-4" />,
    color: 'text-purple-500',
    functions: ['Receive messages', 'Receive images', 'Receive links'],
  },
  livechat_sender: {
    icon: <Send className="h-4 w-4" />,
    color: 'text-indigo-500',
    functions: ['Send replies', 'Send images', 'Send links'],
  },
  account: {
    icon: <UserCog className="h-4 w-4" />,
    color: 'text-yellow-500',
    functions: ['SpamBot', 'Name/Photo', 'Privacy', 'Import', 'Check Ban'],
  },
  warmup: {
    icon: <Flame className="h-4 w-4" />,
    color: 'text-orange-500',
    functions: ['Join channels', 'View content', 'Reactions', 'Pair chat'],
  },
  block: {
    icon: <Ban className="h-4 w-4" />,
    color: 'text-red-500',
    functions: ['Block contacts', 'Unblock contacts'],
  },
};

export const RunnerStatusCard: React.FC = () => {
  const { runners, onlineCount, totalCount, anyOfflineConfirmed } = useRunnerStatus();
  const navigate = useNavigate();
  
  const offlineRunners = runners.filter(r => !r.isOnline);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-5 h-5 text-primary" />
          Runner Status
          <span className={cn(
            "ml-auto text-sm font-medium px-2 py-0.5 rounded-full",
            onlineCount === totalCount 
              ? "bg-green-500/20 text-green-600" 
              : "bg-destructive/20 text-destructive"
          )}>
            {onlineCount}/{totalCount} Online
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error Banner when runners are offline */}
        {anyOfflineConfirmed && offlineRunners.length > 0 && (
          <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="font-semibold">Python Runners Offline</AlertTitle>
            <AlertDescription className="mt-2 space-y-2">
              <p className="text-sm">
                {offlineRunners.length === 1 
                  ? `${offlineRunners[0].name} is not running.`
                  : `${offlineRunners.length} runners are not running: ${offlineRunners.map(r => r.name.replace(' Runner', '')).join(', ')}`
                }
              </p>
              <p className="text-xs text-muted-foreground">
                Make sure Python runners are running on your PC. Download and run RUN.bat to start all runners.
              </p>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-2 gap-2 border-destructive/30 hover:bg-destructive/20"
                onClick={() => navigate('/setup')}
              >
                <Download className="h-3.5 w-3.5" />
                Go to Setup Guide
              </Button>
            </AlertDescription>
          </Alert>
        )}
        
        {/* Runner Grid */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {runners.map((runner) => {
            const config = runnerIcons[runner.runnerKey];
            return (
              <div
                key={runner.runnerKey}
                className={cn(
                  "p-3 rounded-lg border transition-colors",
                  runner.isOnline 
                    ? "bg-green-500/10 border-green-500/30" 
                    : "bg-destructive/10 border-destructive/30"
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={config?.color}>{config?.icon}</span>
                  {runner.isOnline ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-destructive animate-pulse" />
                  )}
                </div>
                <p className="text-xs font-medium truncate">{runner.name.replace(' Runner', '')}</p>
                <p className={cn(
                  "text-[10px] font-medium",
                  runner.isOnline ? "text-green-600" : "text-destructive"
                )}>
                  {runner.isOnline ? 'LIVE' : 'OFFLINE'}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};