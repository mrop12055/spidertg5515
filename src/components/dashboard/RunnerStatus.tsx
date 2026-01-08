import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Send, MessageSquare, UserCog, Flame, CheckCircle2, XCircle, Activity, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRunnerStatus } from '@/hooks/useRunnerStatus';

const runnerIcons: Record<string, { icon: React.ReactNode; color: string; functions: string[] }> = {
  campaign: {
    icon: <Send className="h-4 w-4" />,
    color: 'text-blue-500',
    functions: ['Send messages', 'Validate recipients'],
  },
  livechat: {
    icon: <MessageSquare className="h-4 w-4" />,
    color: 'text-purple-500',
    functions: ['Incoming messages', 'Send replies'],
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
};

export const RunnerStatusCard: React.FC = () => {
  const { runners, serverInstances, uniqueServerCount, onlineCount, totalCount } = useRunnerStatus();
  
  // Get unique online servers for display
  const onlineServers = serverInstances.filter(s => s.isOnline);
  const uniqueServers = Array.from(
    new Map(onlineServers.map(s => [s.serverId, s])).values()
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-5 h-5 text-primary" />
          Runner Status
          <span className="ml-auto flex items-center gap-3 text-sm font-normal text-muted-foreground">
            <span className="flex items-center gap-1">
              <Server className="w-3.5 h-3.5" />
              {uniqueServerCount} {uniqueServerCount === 1 ? 'Server' : 'Servers'}
            </span>
            <span>{onlineCount}/{totalCount} Online</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
                    <XCircle className="h-3.5 w-3.5 text-destructive" />
                  )}
                </div>
                <p className="text-xs font-medium truncate">{runner.name.replace(' Runner', '')}</p>
                <p className={cn(
                  "text-[10px]",
                  runner.isOnline ? "text-green-600" : "text-destructive"
                )}>
                  {runner.isOnline ? 'LIVE' : 'Offline'}
                </p>
              </div>
            );
          })}
        </div>
        
        {/* Active Servers Section */}
        {uniqueServers.length > 0 && (
          <div className="mt-3 pt-3 border-t">
            <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
              <Server className="w-3 h-3" />
              Active Servers ({uniqueServers.length})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {uniqueServers.slice(0, 10).map((server) => (
                <Badge 
                  key={server.serverId} 
                  variant="outline" 
                  className="text-xs bg-green-500/10 border-green-500/30 text-green-600"
                >
                  {server.serverId}
                </Badge>
              ))}
              {uniqueServers.length > 10 && (
                <Badge variant="secondary" className="text-xs">
                  +{uniqueServers.length - 10} more
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
