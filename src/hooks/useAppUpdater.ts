import { useEffect, useState, useCallback } from 'react';

type UpdateState = 'idle' | 'checking' | 'available' | 'none' | 'downloaded' | 'error';

interface UpdateInfo {
  state: UpdateState;
  version?: string;
  message?: string;
  percent?: number;
}

// Safe access to the Electron updater bridge — falls back to a no-op in the browser preview.
const bridge = (typeof window !== 'undefined' && (window as any).localApi?.updater) || null;

export function useAppUpdater() {
  const [info, setInfo] = useState<UpdateInfo>({ state: 'idle' });

  useEffect(() => {
    if (!bridge) return;
    const offS = bridge.onStatus((s: any) => {
      setInfo((prev) => ({ ...prev, state: s.state, version: s.info?.version, message: s.message }));
    });
    const offP = bridge.onProgress((p: any) => {
      setInfo((prev) => ({ ...prev, percent: Math.round(p.percent || 0) }));
    });
    return () => { offS?.(); offP?.(); };
  }, []);

  const check = useCallback(async () => {
    if (!bridge) return { ok: false, message: 'Updates are only available in the desktop app.' };
    setInfo({ state: 'checking' });
    return bridge.check();
  }, []);

  const install = useCallback(async () => {
    if (!bridge) return;
    return bridge.install();
  }, []);

  return { info, check, install, isDesktop: !!bridge };
}
