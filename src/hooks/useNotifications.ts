import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Simple notification sound using Web Audio API
const playNotificationSound = () => {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Create a pleasant notification tone
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5 note
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
    
    // Second tone for a pleasant chime effect
    setTimeout(() => {
      const osc2 = audioContext.createOscillator();
      const gain2 = audioContext.createGain();
      
      osc2.connect(gain2);
      gain2.connect(audioContext.destination);
      
      osc2.frequency.setValueAtTime(1320, audioContext.currentTime); // E6 note
      osc2.type = 'sine';
      
      gain2.gain.setValueAtTime(0.2, audioContext.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
      
      osc2.start(audioContext.currentTime);
      osc2.stop(audioContext.currentTime + 0.2);
    }, 100);
  } catch (error) {
    console.log('Could not play notification sound:', error);
  }
};

export const useNotifications = () => {
  const lastNotifiedRef = useRef<string | null>(null);

  useEffect(() => {
    // Listen for incoming messages
    const channel = supabase
      .channel('notification-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'direction=eq.incoming'
        },
        async (payload) => {
          const message = payload.new as any;
          
          // Avoid duplicate notifications
          if (lastNotifiedRef.current === message.id) return;
          
          // Check if this message is from a campaign-initiated conversation (where we messaged first)
          try {
            const { data: conversation } = await supabase
              .from('conversations')
              .select('first_message_sent')
              .eq('id', message.conversation_id)
              .maybeSingle();
            
            // Only notify for campaign conversations (where we messaged first)
            if (!conversation?.first_message_sent) {
              console.log('Skipping notification - not a campaign conversation');
              return;
            }
          } catch (err) {
            console.log('Error checking conversation:', err);
            return; // Skip notification if we can't verify
          }
          
          lastNotifiedRef.current = message.id;
          
          // Play sound
          playNotificationSound();
          
          // Show browser notification if permitted
          if (Notification.permission === 'granted') {
            new Notification('New Reply', {
              body: message.content?.substring(0, 100) || 'You received a new message',
              icon: '/favicon.ico',
              tag: message.id
            });
          }
        }
      )
      .subscribe();

    // Request notification permission on mount
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
};

export { playNotificationSound };