import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import runnerSource from '../../../resources/runner/unified_runner.py?raw';

const RunnerDownloadCard: React.FC = () => {
  const [busy, setBusy] = useState(false);
  const isDesktop = !!(window as any).localApi?.runner?.export;

  const downloadRunnerFile = () => {
    const blob = new Blob([runnerSource], { type: 'text/x-python' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'unified_runner.py';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('Runner downloaded: unified_runner.py');
  };

  const handleExport = async () => {
    if (isDesktop) {
      setBusy(true);
      try {
        const res = await (window as any).localApi.runner.export();
        if (res?.ok) {
          toast.success(`Runner folder ready: ${res.path}`);
        } else {
          toast.error(res?.error || 'Failed to export runner');
        }
      } catch (e: any) {
        toast.error(e?.message || 'Failed to export runner');
      } finally {
        setBusy(false);
      }
      return;
    }

    downloadRunnerFile();
  };

  return (
    <Card>
      <CardContent className="p-4 flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">Runner Folder</p>
          <p className="text-sm text-muted-foreground">
            {isDesktop ? (
              <>
                Creates a <code>runner/</code> folder next to this app. Open it and run
                <code> python unified_runner.py</code> (or <code>run.bat</code>) manually.
                Proxy is optional — accounts without one connect directly.
              </>
            ) : (
              <>
                Download the <code>unified_runner.py</code> script to run on your machine.
                In the desktop app it can also export a ready-made folder with config and launcher.
              </>
            )}
          </p>
        </div>
        <Button onClick={handleExport} disabled={busy}>
          {isDesktop ? (
            <FolderOpen className="w-4 h-4 mr-2" />
          ) : (
            <Download className="w-4 h-4 mr-2" />
          )}
          {busy ? 'Preparing…' : isDesktop ? 'Export Runner' : 'Download Runner'}
        </Button>
      </CardContent>
    </Card>
  );
};

export default RunnerDownloadCard;
