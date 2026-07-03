import { useState, useEffect, useCallback, useRef } from 'react';
import { localClient as supabase } from '@/lib/localClient';

interface RunnerInfo {
  runnerKey: string;
  name: string;
  isOnline: boolean;
  lastSeen: Date | null;
}

// Single unified runner that handles all functions
const runnerNames: Record<string, string> = {
  unified: 'Unified Runner',
};

const OFFLINE_THRESHOLD_MS = 60000; // 1 minute
const OFFLINE_GRACE_PERIOD_MS = 15000; // 15 seconds grace period before showing red dot

const normalizeRunnerKey = (runnerName: string): string => {
  // All runner names map to the single unified runner
  // This handles legacy names (campaign, livechat, account, warmup) and new unified name
  return 'unified';
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
          const runnerKey = normalizeRunnerKey(hb.runner_name);
          const lastSeen = new Date(hb.last_seen);
          // Keep the most recent timestamp for each runner
          if (!runnerMap.has(runnerKey) || lastSeen > runnerMap.get(runnerKey)!) {
            runnerMap.set(runnerKey, lastSeen);
          }
        }
      }
      
      // Consider offline if last seen more than OFFLINE_THRESHOLD_MS ago
      const offlineThreshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
      const now = new Date();
      
      // If last_seen is older than this, show as offline immediately (skip grace)
      const confirmedOfflineThreshold = new Date(
        Date.now() - OFFLINE_THRESHOLD_MS - OFFLINE_GRACE_PERIOD_MS
      );

      setRunners(prev => {
        const newRunners = prev.map(runner => {
          const lastSeen = runnerMap.get(runner.runnerKey);
          const isOnline = !!(lastSeen && lastSeen > offlineThreshold);

          // Track offline transitions for grace period
          if (!isOnline) {
            // If runner has been offline for longer than grace period already (based on last_seen),
            // backdate the offline tracking so red dot shows immediately
            if (!offlineSinceRef.current.has(runner.runnerKey)) {
              if (lastSeen && lastSeen < confirmedOfflineThreshold) {
                // Runner has been offline for a while, backdate to ensure immediate red dot
                offlineSinceRef.current.set(runner.runnerKey, lastSeen);
              } else {
                // Just went offline, start grace period now
                offlineSinceRef.current.set(runner.runnerKey, now);
              }
            }
          } else {
            // Runner is online, remove from offline tracking
            offlineSinceRef.current.delete(runner.runnerKey);
          }
          
          return {
            ...runner,
            isOnline,
            lastSeen: lastSeen || runner.lastSeen,
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

    // Debounce ref for realtime updates
    let debounceTimer: NodeJS.Timeout | null = null;
    const debouncedCheck = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkRunnerStatus, 1000);
    };

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
          // On any change, re-check status (debounced)
          debouncedCheck();
        }
      )
      .subscribe();

    // Check every 15 seconds to update "offline" status when heartbeats stop
    const interval = setInterval(checkRunnerStatus, 15000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [checkRunnerStatus]);

  const anyOffline = runners.some(r => !r.isOnline);
  const allOnline = runners.every(r => r.isOnline);
  const onlineCount = runners.filter(r => r.isOnline).length;

  return { runners, anyOffline, anyOfflineConfirmed, allOnline, onlineCount, totalCount: runners.length };
};
