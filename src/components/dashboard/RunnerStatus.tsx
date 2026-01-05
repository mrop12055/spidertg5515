import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Send, MessageSquare, UserCog, Flame, Ban, CheckCircle2, XCircle, Activity, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface RunnerStatus {
  name: string;
  icon: React.ReactNode;
  color: string;
  functions: string[];
  runnerKey: string;
  lastSeen: Date | null;
  isOnline: boolean;
}

const initialRunners: Omit<RunnerStatus, 'lastSeen' | 'isOnline'>[] = [
  {
    name: 'Campaign Runner',
    icon: <Send className="h-4 w-4" />,
    color: 'text-blue-500',
    functions: ['Send messages', 'Validate recipients'],
    runnerKey: 'campaign',
  },
  {
    name: 'LiveChat Runner',
    icon: <MessageSquare className="h-4 w-4" />,
    color: 'text-purple-500',
    functions: ['Incoming messages', 'Send replies'],
    runnerKey: 'livechat',
  },
  {
    name: 'Account Runner',
    icon: <UserCog className="h-4 w-4" />,
    color: 'text-yellow-500',
    functions: ['SpamBot', 'Name/Photo', 'Privacy', 'Import', 'Check Ban'],
    runnerKey: 'account',
  },
  {
    name: 'Warmup Runner',
    icon: <Flame className="h-4 w-4" />,
    color: 'text-orange-500',
    functions: ['Join channels', 'View content', 'Reactions'],
    runnerKey: 'warmup',
  },
  {
    name: 'Block Runner',
    icon: <Ban className="h-4 w-4" />,
    color: 'text-red-500',
    functions: ['Block contacts', 'Unblock contacts'],
    runnerKey: 'block',
  }
];

// Track active toast IDs for each runner
const activeToasts = new Map<string, string | number>();

export const RunnerStatusCard: React.FC = () => {
  const [runnerStatuses, setRunnerStatuses] = useState<RunnerStatus[]>(
    initialRunners.map(r => ({ ...r, lastSeen: null, isOnline: false }))
  );
  
  // Track previous online states to detect changes
  const prevOnlineStates = useRef<Map<string, boolean>>(new Map());
  const isFirstCheck = useRef(true);

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

        setRunnerStatuses(prev => {
          const newStatuses = prev.map(runner => {
            const heartbeat = runnerMap.get(runner.runnerKey);
            const isOnline = heartbeat ? heartbeat.lastSeen > fifteenSecondsAgo : false;
            const wasOnline = prevOnlineStates.current.get(runner.runnerKey) ?? false;
            
            // Show persistent toast when runner goes offline (but not on first load)
            if (!isFirstCheck.current && wasOnline && !isOnline) {
              const toastId = toast.error(`${runner.name} is offline`, {
                description: 'Please start the Python script to continue',
                duration: Infinity, // Keep showing until dismissed
                icon: <AlertTriangle className="h-5 w-5 text-red-500" />,
                style: {
                  background: 'hsl(var(--destructive))',
                  color: 'hsl(var(--destructive-foreground))',
                  border: '1px solid hsl(var(--destructive))',
                },
              });
              activeToasts.set(runner.runnerKey, toastId);
            }
            
            // Dismiss toast when runner comes back online
            if (!isFirstCheck.current && !wasOnline && isOnline) {
              const existingToast = activeToasts.get(runner.runnerKey);
              if (existingToast) {
                toast.dismiss(existingToast);
                activeToasts.delete(runner.runnerKey);
                toast.success(`${runner.name} is back online`, {
                  duration: 3000,
                });
              }
            }
            
            // Update tracking
            prevOnlineStates.current.set(runner.runnerKey, isOnline);
            
            return {
              ...runner,
              isOnline,
              lastSeen: heartbeat?.lastSeen || runner.lastSeen
            };
          });
          
          isFirstCheck.current = false;
          return newStatuses;
        });
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
                  : "bg-destructive/10 border-destructive/30"
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={runner.color}>{runner.icon}</span>
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
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
