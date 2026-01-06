import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Server, Play, Square, RefreshCw, Download, Loader2, 
  Terminal, CheckCircle2, XCircle, Clock, Send, MessageSquare,
  UserCog, Flame, Ban, Wifi, WifiOff, Trash2, Circle
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useRunnerStatus } from '@/hooks/useRunnerStatus';

const VPS_ONLINE_THRESHOLD_MS = 30000; // 30 seconds

interface VPSConnection {
  id: string;
  name: string;
  api_key: string;
  status: string;
  last_seen: string | null;
  ip_address: string | null;
}

interface VPSLog {
  id: string;
  runner_name: string;
  log_level: string;
  message: string;
  created_at: string;
}

interface VPSCommand {
  id: string;
  command: string;
  target_runner: string | null;
  status: string;
  result: string | null;
  created_at: string;
  processed_at: string | null;
}

const runnerConfig: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  campaign: { icon: <Send className="h-4 w-4" />, label: 'Campaign', color: 'text-blue-500' },
  livechat: { icon: <MessageSquare className="h-4 w-4" />, label: 'LiveChat', color: 'text-purple-500' },
  account: { icon: <UserCog className="h-4 w-4" />, label: 'Account', color: 'text-yellow-500' },
  warmup: { icon: <Flame className="h-4 w-4" />, label: 'Warmup', color: 'text-orange-500' },
  block: { icon: <Ban className="h-4 w-4" />, label: 'Block', color: 'text-red-500' },
};

export const VPSManager: React.FC = () => {
  const [vps, setVps] = useState<VPSConnection | null>(null);
  const [logs, setLogs] = useState<VPSLog[]>([]);
  const [commands, setCommands] = useState<VPSCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingCommand, setSendingCommand] = useState<string | null>(null);
  const [vpsOnline, setVpsOnline] = useState(false);
  const statusCheckRef = useRef<NodeJS.Timeout | null>(null);
  const { runners } = useRunnerStatus();

  // Check VPS online status based on last_seen
  const checkVpsStatus = useCallback(() => {
    if (!vps?.last_seen) {
      setVpsOnline(false);
      return;
    }
    const lastSeen = new Date(vps.last_seen).getTime();
    const isOnline = Date.now() - lastSeen < VPS_ONLINE_THRESHOLD_MS;
    setVpsOnline(isOnline);
  }, [vps]);

  const fetchVPS = useCallback(async () => {
    const { data } = await supabase
      .from('vps_connections')
      .select('*')
      .limit(1)
      .maybeSingle();
    setVps(data);
    setLoading(false);
  }, []);

  const fetchLogs = useCallback(async () => {
    if (!vps) return;
    const { data } = await supabase
      .from('vps_logs')
      .select('*')
      .eq('vps_id', vps.id)
      .order('created_at', { ascending: false })
      .limit(100);
    setLogs(data || []);
  }, [vps]);

  const fetchCommands = useCallback(async () => {
    if (!vps) return;
    const { data } = await supabase
      .from('vps_commands')
      .select('*')
      .eq('vps_id', vps.id)
      .order('created_at', { ascending: false })
      .limit(50);
    setCommands(data || []);
  }, [vps]);

  useEffect(() => {
    fetchVPS();
  }, [fetchVPS]);

  useEffect(() => {
    if (vps) {
      fetchLogs();
      fetchCommands();
      checkVpsStatus();
      
      // Check status every 5 seconds
      statusCheckRef.current = setInterval(checkVpsStatus, 5000);
      return () => {
        if (statusCheckRef.current) clearInterval(statusCheckRef.current);
      };
    }
  }, [vps, fetchLogs, fetchCommands, checkVpsStatus]);

  // Realtime subscriptions
  useEffect(() => {
    if (!vps) return;

    const channel = supabase
      .channel('vps-manager')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vps_logs', filter: `vps_id=eq.${vps.id}` }, () => fetchLogs())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vps_commands', filter: `vps_id=eq.${vps.id}` }, () => fetchCommands())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vps_connections', filter: `id=eq.${vps.id}` }, () => fetchVPS())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [vps, fetchLogs, fetchCommands, fetchVPS]);

  const sendCommand = async (command: string, targetRunner?: string) => {
    if (!vps) return;
    setSendingCommand(command + (targetRunner || ''));
    
    const { error } = await supabase.from('vps_commands').insert({
      vps_id: vps.id,
      command,
      target_runner: targetRunner || null,
    });

    if (error) {
      toast.error('Failed to send command');
    } else {
      toast.success(`Command sent: ${command}${targetRunner ? ` (${targetRunner})` : ''}`);
    }
    setSendingCommand(null);
  };

  const clearLogs = async () => {
    if (!vps) return;
    await supabase.from('vps_logs').delete().eq('vps_id', vps.id);
    setLogs([]);
    toast.success('Logs cleared');
  };

  // Format last seen time
  const getLastSeenText = () => {
    if (!vps?.last_seen) return 'Never';
    const diff = Date.now() - new Date(vps.last_seen).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(vps.last_seen).toLocaleTimeString();
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!vps) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            VPS Manager
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm mb-4">
            No VPS connected. Download and run the VPS Agent on your server to enable remote management.
          </p>
          <Button variant="outline" asChild>
            <a href="/setup">
              <Download className="h-4 w-4 mr-2" />
              Go to Setup Guide
            </a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-5 w-5 text-primary" />
            VPS Agent
          </CardTitle>
          <div className="flex items-center gap-3">
            {vps.ip_address && (
              <span className="text-xs font-mono text-muted-foreground">{vps.ip_address}</span>
            )}
            <div className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
              vpsOnline 
                ? "bg-green-500/15 text-green-600 dark:text-green-400" 
                : "bg-red-500/15 text-red-600 dark:text-red-400"
            )}>
              <Circle className={cn("h-2 w-2 fill-current", vpsOnline && "animate-pulse")} />
              {vpsOnline ? 'Running' : 'Stopped'}
            </div>
            <span className="text-xs text-muted-foreground">
              {getLastSeenText()}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Global Controls */}
        <div className="flex flex-wrap gap-2">
          <Button 
            size="sm" 
            onClick={() => sendCommand('start_all')}
            disabled={!!sendingCommand}
          >
            {sendingCommand === 'start_all' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}
            Start All
          </Button>
          <Button 
            size="sm" 
            variant="destructive"
            onClick={() => sendCommand('stop_all')}
            disabled={!!sendingCommand}
          >
            {sendingCommand === 'stop_all' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Square className="h-4 w-4 mr-1" />}
            Stop All
          </Button>
          <Button 
            size="sm" 
            variant="outline"
            onClick={() => sendCommand('restart_all')}
            disabled={!!sendingCommand}
          >
            {sendingCommand === 'restart_all' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Restart All
          </Button>
          <Button 
            size="sm" 
            variant="secondary"
            onClick={() => sendCommand('update')}
            disabled={!!sendingCommand}
          >
            {sendingCommand === 'update' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
            Update Scripts
          </Button>
        </div>

        {/* Individual Runner Controls */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {Object.entries(runnerConfig).map(([key, cfg]) => {
            const runnerStatus = runners.find(r => r.runnerKey === key);
            const isRunning = runnerStatus?.isOnline;
            
            return (
              <div key={key} className={cn(
                "p-2 rounded-lg border flex flex-col gap-2",
                isRunning ? "bg-green-500/10 border-green-500/30" : "bg-muted/50 border-border"
              )}>
                <div className="flex items-center gap-1.5">
                  <span className={cfg.color}>{cfg.icon}</span>
                  <span className="text-xs font-medium">{cfg.label}</span>
                  {isRunning ? (
                    <CheckCircle2 className="h-3 w-3 text-green-500 ml-auto" />
                  ) : (
                    <XCircle className="h-3 w-3 text-muted-foreground ml-auto" />
                  )}
                </div>
                <div className="flex gap-1">
                  <Button 
                    size="sm" 
                    variant="ghost" 
                    className="h-6 px-2 text-xs flex-1"
                    onClick={() => sendCommand('start_runner', key)}
                    disabled={!!sendingCommand || isRunning}
                  >
                    <Play className="h-3 w-3" />
                  </Button>
                  <Button 
                    size="sm" 
                    variant="ghost" 
                    className="h-6 px-2 text-xs flex-1"
                    onClick={() => sendCommand('stop_runner', key)}
                    disabled={!!sendingCommand || !isRunning}
                  >
                    <Square className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Tabs for Logs and Commands */}
        <Tabs defaultValue="logs" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="logs" className="text-xs">
              <Terminal className="h-3.5 w-3.5 mr-1" />
              Logs ({logs.length})
            </TabsTrigger>
            <TabsTrigger value="commands" className="text-xs">
              <Clock className="h-3.5 w-3.5 mr-1" />
              Commands ({commands.length})
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="logs" className="mt-2">
            <div className="flex justify-end mb-2">
              <Button size="sm" variant="ghost" onClick={clearLogs} className="h-7 text-xs">
                <Trash2 className="h-3 w-3 mr-1" />
                Clear
              </Button>
            </div>
            <ScrollArea className="h-48 rounded border bg-muted/30 p-2">
              {logs.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No logs yet</p>
              ) : (
                <div className="space-y-1 font-mono text-xs">
                  {logs.map(log => (
                    <div key={log.id} className="flex gap-2">
                      <span className="text-muted-foreground shrink-0">
                        {new Date(log.created_at).toLocaleTimeString()}
                      </span>
                      <Badge variant={log.log_level === 'error' ? 'destructive' : log.log_level === 'warning' ? 'secondary' : 'outline'} className="h-4 text-[10px]">
                        {log.runner_name}
                      </Badge>
                      <span className={cn(
                        log.log_level === 'error' && 'text-destructive',
                        log.log_level === 'warning' && 'text-yellow-500'
                      )}>
                        {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
          
          <TabsContent value="commands" className="mt-2">
            <ScrollArea className="h-48 rounded border bg-muted/30 p-2">
              {commands.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No commands sent yet</p>
              ) : (
                <div className="space-y-1.5">
                  {commands.map(cmd => (
                    <div key={cmd.id} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground shrink-0">
                        {new Date(cmd.created_at).toLocaleTimeString()}
                      </span>
                      <Badge variant="outline" className="h-4 text-[10px]">
                        {cmd.command}{cmd.target_runner ? `:${cmd.target_runner}` : ''}
                      </Badge>
                      <Badge 
                        variant={cmd.status === 'completed' ? 'default' : cmd.status === 'failed' ? 'destructive' : 'secondary'}
                        className="h-4 text-[10px]"
                      >
                        {cmd.status}
                      </Badge>
                      {cmd.result && <span className="text-muted-foreground truncate">{cmd.result}</span>}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
};
