import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRunnerStatus } from '@/hooks/useRunnerStatus';

export const RunnerStatusCard: React.FC = () => {
  const { runners } = useRunnerStatus();
  const unifiedRunner = runners[0]; // There's only one runner now

  if (!unifiedRunner) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="w-5 h-5 text-primary" />
          Runner Status
          <span className={cn(
            "ml-auto text-sm font-medium",
            unifiedRunner.isOnline ? "text-green-600" : "text-destructive"
          )}>
            {unifiedRunner.isOnline ? 'Online' : 'Offline'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "p-4 rounded-lg border transition-colors",
            unifiedRunner.isOnline 
              ? "bg-green-500/10 border-green-500/30" 
              : "bg-destructive/10 border-destructive/30"
          )}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" />
              <span className="font-medium">Unified Runner</span>
            </div>
            {unifiedRunner.isOnline ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-destructive" />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Handles: Campaigns, LiveChat, Accounts, Warmup
          </p>
          {unifiedRunner.lastSeen && (
            <p className="text-xs text-muted-foreground mt-1">
              Last seen: {new Date(unifiedRunner.lastSeen).toLocaleTimeString()}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
