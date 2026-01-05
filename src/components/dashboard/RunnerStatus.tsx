import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Send, MessageSquare, UserCog, Flame, Ban, CheckCircle2, XCircle, Activity } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface RunnerStatus {
  name: string;
  icon: React.ReactNode;
  color: string;
  functions: string[];
  runnerKey: string;
  lastSeen: Date | null;
  isOnline: boolean;
}

export const RunnerStatusCard: React.FC = () => {
  const [runnerStatuses, setRunnerStatuses] = useState<RunnerStatus[]>([
    {
      name: 'Campaign Runner',
      icon: <Send className="h-4 w-4" />,
      color: 'text-blue-500',
      functions: ['Send messages', 'Validate recipients'],
      runnerKey: 'campaign',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'LiveChat Runner',
      icon: <MessageSquare className="h-4 w-4" />,
      color: 'text-purple-500',
      functions: ['Incoming messages', 'Send replies'],
      runnerKey: 'livechat',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'Account Runner',
      icon: <UserCog className="h-4 w-4" />,
      color: 'text-yellow-500',
      functions: ['SpamBot', 'Name/Photo', 'Privacy', 'Import', 'Check Ban'],
      runnerKey: 'account',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'Warmup Runner',
      icon: <Flame className="h-4 w-4" />,
      color: 'text-orange-500',
      functions: ['Join channels', 'View content', 'Reactions'],
      runnerKey: 'warmup',
      lastSeen: null,
      isOnline: false
    },
    {
      name: 'Block Runner',
      icon: <Ban className="h-4 w-4" />,
      color: 'text-red-500',
      functions: ['Block contacts', 'Unblock contacts'],
      runnerKey: 'block',
      lastSeen: null,
      isOnline: false
    }
  ]);

  useEffect(() => {
    const checkRunnerStatus = async () => {
      try {
        const { data: heartbeats } = await supabase
          .from('runner_heartbeats')
          .select('runner_name, last_seen, status');
        
        const runnerMap = new Map<string, { lastSeen: Date; status: string }>();
        if (heartbeats) {
          for (const hb of heartbeats) {
            runnerMap.set(hb.runner_name, {
              lastSeen: new Date(hb.last_seen),
              status: hb.status || 'online'
            });
          }
        }
        
        const fifteenSecondsAgo = new Date(Date.now() - 15000);

        setRunnerStatuses(prev => prev.map(runner => {
          const heartbeat = runnerMap.get(runner.runnerKey);
          const isOnline = heartbeat ? heartbeat.lastSeen > fifteenSecondsAgo : false;
          return {
            ...runner,
            isOnline,
            lastSeen: heartbeat?.lastSeen || runner.lastSeen
          };
        }));
      } catch (error) {
        console.error('Error checking runner status:', error);
      }
    };

    checkRunnerStatus();
    const interval = setInterval(checkRunnerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const onlineCount = runnerStatuses.filter(r => r.isOnline).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-5 h-5 text-primary" />
          Runner Status
          <span className="ml-auto text-sm font-normal text-muted-foreground">
            {onlineCount}/{runnerStatuses.length} Online
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {runnerStatuses.map((runner) => (
            <div
              key={runner.runnerKey}
              className={cn(
                "p-3 rounded-lg border transition-colors",
                runner.isOnline 
                  ? "bg-green-500/10 border-green-500/30" 
                  : "bg-muted/50 border-border"
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={runner.color}>{runner.icon}</span>
                {runner.isOnline ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
              <p className="text-xs font-medium truncate">{runner.name.replace(' Runner', '')}</p>
              <p className={cn(
                "text-[10px]",
                runner.isOnline ? "text-green-600" : "text-muted-foreground"
              )}>
                {runner.isOnline ? 'LIVE' : 'Offline'}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
