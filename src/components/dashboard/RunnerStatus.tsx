import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle2, XCircle, Server, Play, Square, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type RunnerStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'unknown';

interface StatusPayload {
  status: RunnerStatus;
  error?: string | null;
  pid?: number | null;
  port?: number;
}

interface LogLine {
  stream: string;
  line: string;
  ts: number;
}

export const RunnerStatusCard: React.FC = () => {
  const api = typeof window !== 'undefined' ? window.localApi : undefined;
  const isDesktop = !!api?.isDesktop;

  const [state, setState] = useState<StatusPayload>({ status: 'unknown', pid: null });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const logBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    api.runner.status().then((s: any) => {
      if (!cancelled) setState(s);
    }).catch(() => {});

    const offStatus = api.runner.onStatus((s: any) => setState(s));
    const offLog = api.runner.onLog((l: any) => {
      setLogs((prev) => {
        const next = [...prev, l];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });

    return () => {
      cancelled = true;
      offStatus?.();
      offLog?.();
    };
  }, [api]);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const online = state.status === 'running';
  const starting = state.status === 'starting';

  const label = {
    running: 'Running',
    starting: 'Starting…',
    stopped: 'Stopped',
    crashed: 'Crashed',
    unknown: isDesktop ? 'Unknown' : 'Preview (no runner)',
  }[state.status];

  const doAction = async (fn: () => Promise<any>) => {
    if (!api) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="w-5 h-5 text-primary" />
          Python Runner
          <span
            className={cn(
              'ml-auto text-sm font-medium flex items-center gap-1.5',
              online ? 'text-green-600' : starting ? 'text-yellow-500' : 'text-destructive'
            )}
          >
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : online ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {label}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className={cn(
            'p-3 rounded-lg border text-sm',
            online
              ? 'bg-green-500/10 border-green-500/30'
              : starting
              ? 'bg-yellow-500/10 border-yellow-500/30'
              : 'bg-destructive/10 border-destructive/30'
          )}
        >
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium">{label}</span>
          </div>
          {state.pid ? (
            <div className="flex justify-between mt-1">
              <span className="text-muted-foreground">Process ID</span>
              <span className="font-mono">{state.pid}</span>
            </div>
          ) : null}
          {state.error ? (
            <div className="mt-2 text-xs text-destructive break-all">{state.error}</div>
          ) : null}
        </div>

        {isDesktop && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy || online || starting}
              onClick={() => doAction(() => api!.runner.start())}>
              <Play className="w-3.5 h-3.5 mr-1" /> Start
            </Button>
            <Button size="sm" variant="outline" disabled={busy || state.status === 'stopped'}
              onClick={() => doAction(() => api!.runner.stop())}>
              <Square className="w-3.5 h-3.5 mr-1" /> Stop
            </Button>
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => doAction(() => api!.runner.restart())}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Restart
            </Button>
          </div>
        )}

        <div>
          <div className="text-xs text-muted-foreground mb-1">Live output</div>
          <div
            ref={logBoxRef}
            className="h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-4"
          >
            {logs.length === 0 ? (
              <div className="text-muted-foreground italic">
                {isDesktop
                  ? 'Waiting for runner output…'
                  : 'Runner output only shows in the packaged desktop app.'}
              </div>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    l.stream === 'err' && 'text-destructive',
                    l.stream === 'sys' && 'text-primary'
                  )}
                >
                  <span className="opacity-50">
                    {new Date(l.ts).toLocaleTimeString()}{' '}
                  </span>
                  {l.line}
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
