import { useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Message } from '@/types/telegram';

interface WatchdogOptions {
  messages: Message[];
  onMessageStatusUpdate: (messageId: string, newStatus: Message['status']) => void;
  pollIntervalMs?: number;
  maxPollDurationMs?: number;
  staleThresholdMs?: number;
}

/**
 * Watches for pending messages and polls the backend to update their status.
 * This ensures the UI doesn't get stuck showing "pending" when realtime events are missed.
 */
export function usePendingMessageWatchdog({
  messages,
  onMessageStatusUpdate,
  pollIntervalMs = 3000,
  maxPollDurationMs = 60000,
  staleThresholdMs = 20000,
}: WatchdogOptions) {
  const watchedMessagesRef = useRef<Map<string, { startTime: number }>>(new Map());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check a batch of message IDs against the database
  const checkMessageStatuses = useCallback(async (messageIds: string[]) => {
    if (messageIds.length === 0) return;

    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, status')
        .in('id', messageIds);

      if (error) {
        console.error('[Watchdog] Error checking message statuses:', error);
        return;
      }

      if (data) {
        for (const row of data) {
          const currentMsg = messages.find(m => m.id === row.id);
          if (currentMsg && currentMsg.status === 'pending' && row.status !== 'pending') {
            console.log(`[Watchdog] Message ${row.id} status updated: pending → ${row.status}`);
            onMessageStatusUpdate(row.id, row.status as Message['status']);
            watchedMessagesRef.current.delete(row.id);
          }
        }
      }
    } catch (err) {
      console.error('[Watchdog] Exception checking statuses:', err);
    }
  }, [messages, onMessageStatusUpdate]);

  // Main polling effect
  useEffect(() => {
    const now = Date.now();

    // Find pending messages to watch
    const pendingMessages = messages.filter(m => m.status === 'pending');

    // Add new pending messages to watch list
    for (const msg of pendingMessages) {
      if (!watchedMessagesRef.current.has(msg.id)) {
        watchedMessagesRef.current.set(msg.id, { startTime: now });
        console.log(`[Watchdog] Now watching message ${msg.id}`);
      }
    }

    // Remove messages that are no longer pending
    for (const [id] of watchedMessagesRef.current) {
      if (!pendingMessages.find(m => m.id === id)) {
        watchedMessagesRef.current.delete(id);
      }
    }

    // Clear old interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // If no messages to watch, stop
    if (watchedMessagesRef.current.size === 0) {
      return;
    }

    // Start polling
    const poll = () => {
      const currentTime = Date.now();
      const idsToCheck: string[] = [];
      const idsToRemove: string[] = [];

      for (const [id, { startTime }] of watchedMessagesRef.current) {
        const elapsed = currentTime - startTime;

        // Stop watching if exceeded max duration
        if (elapsed > maxPollDurationMs) {
          console.log(`[Watchdog] Stopped watching message ${id} (exceeded max duration)`);
          idsToRemove.push(id);
          continue;
        }

        idsToCheck.push(id);
      }

      // Remove expired watches
      for (const id of idsToRemove) {
        watchedMessagesRef.current.delete(id);
      }

      // Check remaining messages
      if (idsToCheck.length > 0) {
        checkMessageStatuses(idsToCheck);
      }

      // Stop interval if nothing left to watch
      if (watchedMessagesRef.current.size === 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    // Run immediately for stale messages (older than threshold)
    const staleIds: string[] = [];
    for (const [id, { startTime }] of watchedMessagesRef.current) {
      if (now - startTime > staleThresholdMs) {
        staleIds.push(id);
      }
    }
    if (staleIds.length > 0) {
      console.log(`[Watchdog] Checking ${staleIds.length} stale pending messages on load`);
      checkMessageStatuses(staleIds);
    }

    intervalRef.current = setInterval(poll, pollIntervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [messages, checkMessageStatuses, pollIntervalMs, maxPollDurationMs, staleThresholdMs]);

  // Return count of watched messages for UI feedback
  return {
    watchedCount: watchedMessagesRef.current.size,
  };
}
