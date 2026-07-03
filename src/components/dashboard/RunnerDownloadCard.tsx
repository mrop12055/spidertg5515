import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';

const RunnerDownloadCard: React.FC = () => {
  const [busy, setBusy] = useState(false);

  const handleExport = async () => {
    const api = (window as any).localApi?.runner;
    if (!api?.export) {
      toast.error('Runner export is only available in the desktop app.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.export();
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
  };

  return (
    <Card>
      <CardContent className="p-4 flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">Runner Folder</p>
          <p className="text-sm text-muted-foreground">
            Creates a <code>runner/</code> folder next to this app. Open it and run
            <code> python unified_runner.py</code> (or <code>run.bat</code>) manually.
            Proxy is optional — accounts without one connect directly.
          </p>
        </div>
        <Button onClick={handleExport} disabled={busy}>
          <FolderOpen className="w-4 h-4 mr-2" />
          {busy ? 'Preparing…' : 'Export Runner'}
        </Button>
      </CardContent>
    </Card>
  );
};

export default RunnerDownloadCard;
