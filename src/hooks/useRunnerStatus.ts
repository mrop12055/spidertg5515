import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface RunnerInfo {
  runnerKey: string;
  name: string;
  isOnline: boolean;
  lastSeen: Date | null;
}

const runnerNames: Record<string, string> = {
  campaign: 'Campaign Runner',
  livechat: 'LiveChat Runner',
  account: 'Account Runner',
  warmup: 'Warmup Runner',
  block: 'Block Runner',
};

export const useRunnerStatus = () => {
  const [runners, setRunners] = useState<RunnerInfo[]>(
    Object.entries(runnerNames).map(([key, name]) => ({
      runnerKey: key,
      name,
      isOnline: false,
      lastSeen: null,
    }))
  );

  useEffect(() => {
    const checkRunnerStatus = async () => {
      try {
        const { data: heartbeats } = await supabase
          .from('runner_heartbeats')
          .select('runner_name, last_seen, status');
        
        const runnerMap = new Map<string, Date>();
        if (heartbeats) {
          for (const hb of heartbeats) {
            runnerMap.set(hb.runner_name, new Date(hb.last_seen));
          }
        }
        
        const fifteenSecondsAgo = new Date(Date.now() - 15000);

        setRunners(prev => prev.map(runner => ({
          ...runner,
          isOnline: runnerMap.has(runner.runnerKey) && runnerMap.get(runner.runnerKey)! > fifteenSecondsAgo,
          lastSeen: runnerMap.get(runner.runnerKey) || runner.lastSeen,
        })));
      } catch (error) {
        console.error('Error checking runner status:', error);
      }
    };

    checkRunnerStatus();
    const interval = setInterval(checkRunnerStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const anyOffline = runners.some(r => !r.isOnline);
  const allOnline = runners.every(r => r.isOnline);
  const onlineCount = runners.filter(r => r.isOnline).length;

  return { runners, anyOffline, allOnline, onlineCount, totalCount: runners.length };
};
