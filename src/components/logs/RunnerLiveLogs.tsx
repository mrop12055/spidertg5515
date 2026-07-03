import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, Square, RefreshCw, Trash2, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LogLine {
  stream: string;
  line: string;
  ts: number;
}

export const RunnerLiveLogs: React.FC = () => {
  const api = typeof window !== 'undefined' ? window.localApi : undefined;
  const isDesktop = !!api?.isDesktop;

  const [status, setStatus] = useState<any>({ status: 'unknown' });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<'all' | 'out' | 'err' | 'sys'>('all');
  const boxRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!api) return;
    api.runner.status().then(setStatus).catch(() => {});
    const offS = api.runner.onStatus((s: any) => setStatus(s));
    const offL = api.runner.onLog((l: any) => {
      if (pausedRef.current) return;
      setLogs((prev) => {
        const next = [...prev, l];
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
    });
    return () => { offS?.(); offL?.(); };
  }, [api]);

  useEffect(() => {
    if (paused) return;
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, paused]);

  const shown = logs.filter((l) => filter === 'all' || l.stream === filter);
  const counts = {
    out: logs.filter((l) => l.stream === 'out').length,
    err: logs.filter((l) => l.stream === 'err').length,
    sys: logs.filter((l) => l.stream === 'sys').length,
  };

  const statusColor = {
    running: 'bg-green-500',
    starting: 'bg-yellow-500',
    stopped: 'bg-muted-foreground',
    crashed: 'bg-destructive',
    unknown: 'bg-muted-foreground',
  }[status.status as string] || 'bg-muted-foreground';

  if (!isDesktop) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Runner logs only appear in the packaged desktop app.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className={cn('w-2.5 h-2.5 rounded-full', statusColor, status.status === 'running' && 'animate-pulse')} />
            <span className="text-sm font-medium capitalize">{status.status}</span>
            {status.pid ? <span className="text-xs text-muted-foreground font-mono">pid {status.pid}</span> : null}
          </div>

          <div className="flex gap-1 ml-auto">
            <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>
              All <Badge variant="secondary" className="ml-1">{logs.length}</Badge>
            </Button>
            <Button size="sm" variant={filter === 'out' ? 'default' : 'outline'} onClick={() => setFilter('out')}>
              stdout <Badge variant="secondary" className="ml-1">{counts.out}</Badge>
            </Button>
            <Button size="sm" variant={filter === 'err' ? 'default' : 'outline'} onClick={() => setFilter('err')}>
              stderr <Badge variant="secondary" className="ml-1">{counts.err}</Badge>
            </Button>
            <Button size="sm" variant={filter === 'sys' ? 'default' : 'outline'} onClick={() => setFilter('sys')}>
              sys <Badge variant="secondary" className="ml-1">{counts.sys}</Badge>
            </Button>
          </div>

          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span className="ml-1">{paused ? 'Resume' : 'Pause'}</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setLogs([])}>
              <Trash2 className="w-3.5 h-3.5" /><span className="ml-1">Clear</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => api?.runner.start()}
              disabled={status.status === 'running' || status.status === 'starting'}>
              <Play className="w-3.5 h-3.5" /><span className="ml-1">Start</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => api?.runner.stop()}
              disabled={status.status === 'stopped'}>
              <Square className="w-3.5 h-3.5" /><span className="ml-1">Stop</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => api?.runner.restart()}>
              <RefreshCw className="w-3.5 h-3.5" /><span className="ml-1">Restart</span>
            </Button>
          </div>
        </div>

        {status.error ? (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded p-2 break-all">
            {status.error}
          </div>
        ) : null}

        <div
          ref={boxRef}
          className="h-[560px] overflow-auto rounded-md border bg-[#0b0f19] p-3 font-mono text-[11px] leading-[1.55]"
        >
          {shown.length === 0 ? (
            <div className="text-muted-foreground italic">
              Waiting for runner output…
            </div>
          ) : (
            shown.map((l, i) => (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  l.stream === 'err' && 'text-red-400',
                  l.stream === 'sys' && 'text-sky-400',
                  l.stream === 'out' && 'text-slate-200',
                )}
              >
                <span className="text-slate-500 mr-2">
                  {new Date(l.ts).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <span className="text-slate-500 mr-2">[{l.stream}]</span>
                {l.line}
              </div>
            ))
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          Showing {shown.length} of {logs.length} lines · buffer keeps the last 2000 · Pause to inspect.
        </div>
      </CardContent>
    </Card>
  );
};
