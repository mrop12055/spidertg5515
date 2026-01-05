import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface RunnerInfo {
  runnerKey: string;
  name: string;
  isOnline: boolean;
  lastSeen: Date | null;
}

// Maps Python runner script names to display names
// warmup_runner.py reports both 'warmup' and 'warmup_chat' - we track both but show as single card
const runnerNames: Record<string, string> = {
  campaign: 'Campaign Runner',
  livechat: 'LiveChat Runner',
  account: 'Account Runner',
  warmup: 'Warmup Runner',  // warmup_runner.py
  block: 'Block Runner',
};

const OFFLINE_GRACE_PERIOD_MS = 10000; // 10 seconds grace period before showing red dot

export const useRunnerStatus = () => {
  const [runners, setRunners] = useState<RunnerInfo[]>(
    Object.entries(runnerNames).map(([key, name]) => ({
      runnerKey: key,
      name,
      isOnline: false,
      lastSeen: null,
    }))
  );
  
  // Track when each runner first went offline (for grace period)
  const offlineSinceRef = useRef<Map<string, Date>>(new Map());
  const [anyOfflineConfirmed, setAnyOfflineConfirmed] = useState(false);

  const checkRunnerStatus = useCallback(async () => {
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
      
      const thirtySecondsAgo = new Date(Date.now() - 30000);
      const now = new Date();

      setRunners(prev => {
        const newRunners = prev.map(runner => {
          const isOnline = runnerMap.has(runner.runnerKey) && runnerMap.get(runner.runnerKey)! > thirtySecondsAgo;
          
          // Track offline transitions for grace period
          if (!isOnline) {
            // If not already tracked as offline, start tracking
            if (!offlineSinceRef.current.has(runner.runnerKey)) {
              offlineSinceRef.current.set(runner.runnerKey, now);
            }
          } else {
            // Runner is online, remove from offline tracking
            offlineSinceRef.current.delete(runner.runnerKey);
          }
          
          return {
            ...runner,
            isOnline,
            lastSeen: runnerMap.get(runner.runnerKey) || runner.lastSeen,
          };
        });
        
        return newRunners;
      });
      
      // Check if any runner has been offline for longer than grace period
      const hasConfirmedOffline = Array.from(offlineSinceRef.current.entries()).some(([_, offlineSince]) => {
        return now.getTime() - offlineSince.getTime() >= OFFLINE_GRACE_PERIOD_MS;
      });
      setAnyOfflineConfirmed(hasConfirmedOffline);
      
    } catch (error) {
      console.error('Error checking runner status:', error);
    }
  }, []);

  useEffect(() => {
    // Initial check
    checkRunnerStatus();

    // Subscribe to realtime updates on runner_heartbeats
    const channel = supabase
      .channel('runner-heartbeats-live')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'runner_heartbeats'
        },
        () => {
          // On any change, re-check status
          checkRunnerStatus();
        }
      )
      .subscribe();

    // Also check every 5 seconds to update "offline" status when heartbeats stop
    const interval = setInterval(checkRunnerStatus, 5000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [checkRunnerStatus]);

  const anyOffline = runners.some(r => !r.isOnline);
  const allOnline = runners.every(r => r.isOnline);
  const onlineCount = runners.filter(r => r.isOnline).length;

  return { runners, anyOffline, anyOfflineConfirmed, allOnline, onlineCount, totalCount: runners.length };
};
