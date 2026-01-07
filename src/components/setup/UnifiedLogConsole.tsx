import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { 
  Terminal, Trash2, Pause, Play, Download,
  Send, MessageSquare, UserCog, Flame, Server, Circle, Filter
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface LogEntry {
  id: string;
  runner_name: string;
  log_level: string | null;
  message: string;
  created_at: string;
  vps_id: string | null;
}

const runnerStyles: Record<string, { icon: React.ReactNode; label: string; bgColor: string; textColor: string; borderColor: string }> = {
  agent: { 
    icon: <Server className="h-3 w-3" />, 
    label: 'Agent', 
    bgColor: 'bg-slate-500/20',
    textColor: 'text-slate-400',
    borderColor: 'border-l-slate-500'
  },
  campaign: { 
    icon: <Send className="h-3 w-3" />, 
    label: 'Campaign', 
    bgColor: 'bg-blue-500/20',
    textColor: 'text-blue-400',
    borderColor: 'border-l-blue-500'
  },
  livechat: { 
    icon: <MessageSquare className="h-3 w-3" />, 
    label: 'LiveChat', 
    bgColor: 'bg-purple-500/20',
    textColor: 'text-purple-400',
    borderColor: 'border-l-purple-500'
  },
  account: { 
    icon: <UserCog className="h-3 w-3" />, 
    label: 'Account', 
    bgColor: 'bg-yellow-500/20',
    textColor: 'text-yellow-400',
    borderColor: 'border-l-yellow-500'
  },
  warmup: { 
    icon: <Flame className="h-3 w-3" />, 
    label: 'Warmup', 
    bgColor: 'bg-orange-500/20',
    textColor: 'text-orange-400',
    borderColor: 'border-l-orange-500'
  },
};

const getRunnerStyle = (runnerName: string) => {
  return runnerStyles[runnerName] || {
    icon: <Terminal className="h-3 w-3" />,
    label: runnerName,
    bgColor: 'bg-muted',
    textColor: 'text-muted-foreground',
    borderColor: 'border-l-muted-foreground'
  };
};

export const UnifiedLogConsole: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(['agent', 'campaign', 'livechat', 'account', 'warmup']));
  const scrollRef = useRef<HTMLDivElement>(null);
  const logsBufferRef = useRef<LogEntry[]>([]);

  const fetchLogs = useCallback(async () => {
    const { data, error } = await supabase
      .from('vps_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    
    if (error) {
      console.error('Failed to fetch logs:', error);
      return;
    }
    
    setLogs(data || []);
    logsBufferRef.current = data || [];
  }, []);

  useEffect(() => {
    fetchLogs();

    // Subscribe to real-time updates
    const channel = supabase
      .channel('unified-log-stream')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'vps_logs' },
        (payload) => {
          if (!isPaused) {
            const newLog = payload.new as LogEntry;
            setLogs(prev => [newLog, ...prev].slice(0, 500));
            logsBufferRef.current = [newLog, ...logsBufferRef.current].slice(0, 500);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchLogs, isPaused]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [logs, autoScroll]);

  const clearLogs = async () => {
    const { error } = await supabase.from('vps_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) {
      toast.error('Failed to clear logs');
    } else {
      setLogs([]);
      logsBufferRef.current = [];
      toast.success('Logs cleared');
    }
  };

  const exportLogs = () => {
    const filteredLogs = logs.filter(log => activeFilters.has(log.runner_name));
    const logText = filteredLogs.map(log => 
      `[${new Date(log.created_at).toLocaleString()}] [${log.runner_name.toUpperCase()}] ${log.log_level ? `[${log.log_level.toUpperCase()}]` : ''} ${log.message}`
    ).join('\n');
    
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `runner-logs-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleFilter = (runner: string) => {
    setActiveFilters(prev => {
      const newFilters = new Set(prev);
      if (newFilters.has(runner)) {
        newFilters.delete(runner);
      } else {
        newFilters.add(runner);
      }
      return newFilters;
    });
  };

  const filteredLogs = logs.filter(log => activeFilters.has(log.runner_name));

  const getLogLevelStyle = (level: string | null) => {
    switch (level?.toLowerCase()) {
      case 'error':
        return 'text-red-500';
      case 'warning':
        return 'text-yellow-500';
      case 'success':
        return 'text-green-500';
      default:
        return 'text-foreground';
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-5 w-5 text-primary" />
            Live Runner Console
            <Badge variant="outline" className="ml-1 text-[10px]">
              <Circle className={cn("h-1.5 w-1.5 mr-1 fill-current", isPaused ? "text-yellow-500" : "text-green-500 animate-pulse")} />
              {isPaused ? 'Paused' : 'Live'}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={exportLogs} className="h-7 text-xs" title="Export logs">
              <Download className="h-3 w-3" />
            </Button>
            <Button size="sm" variant="ghost" onClick={clearLogs} className="h-7 text-xs" title="Clear logs">
              <Trash2 className="h-3 w-3" />
            </Button>
            <Button 
              size="sm" 
              variant={isPaused ? "default" : "outline"} 
              onClick={() => setIsPaused(!isPaused)} 
              className="h-7 text-xs gap-1"
            >
              {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              {isPaused ? 'Resume' : 'Pause'}
            </Button>
          </div>
        </div>

        {/* Filter buttons */}
        <div className="flex items-center gap-2 pt-2 flex-wrap">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          {Object.entries(runnerStyles).map(([key, style]) => (
            <Button
              key={key}
              size="sm"
              variant={activeFilters.has(key) ? "default" : "outline"}
              onClick={() => toggleFilter(key)}
              className={cn(
                "h-6 px-2 text-[10px] gap-1",
                activeFilters.has(key) && style.bgColor,
                activeFilters.has(key) && style.textColor
              )}
            >
              {style.icon}
              {style.label}
            </Button>
          ))}
        </div>

        {/* Auto-scroll toggle */}
        <div className="flex items-center gap-2 pt-1">
          <Switch 
            id="auto-scroll" 
            checked={autoScroll} 
            onCheckedChange={setAutoScroll}
            className="h-4 w-7"
          />
          <label htmlFor="auto-scroll" className="text-[10px] text-muted-foreground">Auto-scroll to new logs</label>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {filteredLogs.length} / {logs.length} entries
          </span>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <ScrollArea className="h-80 rounded-lg border bg-black/90 dark:bg-black/70" ref={scrollRef}>
          <div className="p-3 font-mono text-xs space-y-0.5">
            {filteredLogs.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                {logs.length === 0 ? 'Waiting for logs...' : 'No logs match the selected filters'}
              </p>
            ) : (
              filteredLogs.map(log => {
                const style = getRunnerStyle(log.runner_name);
                return (
                  <div 
                    key={log.id} 
                    className={cn(
                      "flex gap-2 py-0.5 px-2 rounded-sm border-l-2 hover:bg-white/5 transition-colors",
                      style.borderColor
                    )}
                  >
                    <span className="text-muted-foreground shrink-0 w-20">
                      {new Date(log.created_at).toLocaleTimeString()}
                    </span>
                    <Badge 
                      className={cn(
                        "h-4 text-[9px] px-1.5 font-medium shrink-0 w-16 justify-center",
                        style.bgColor,
                        style.textColor,
                        "border-0"
                      )}
                    >
                      <span className="mr-0.5">{style.icon}</span>
                      {style.label.slice(0, 4)}
                    </Badge>
                    {log.log_level && (
                      <Badge 
                        variant={log.log_level === 'error' ? 'destructive' : 'secondary'}
                        className="h-4 text-[9px] px-1 shrink-0"
                      >
                        {log.log_level.toUpperCase().slice(0, 3)}
                      </Badge>
                    )}
                    <span className={cn("break-all", getLogLevelStyle(log.log_level))}>
                      {log.message}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
