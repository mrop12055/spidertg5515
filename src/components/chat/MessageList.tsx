import React, { memo, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import MessageBubble from './MessageBubble';

interface Message {
  id: string;
  content: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' | 'sending';
  created_at: string;
  media_url: string | null;
  media_type: string | null;
}

interface MessageGroup {
  date: string;
  messages: Message[];
}

interface MessageListProps {
  messageGroups: MessageGroup[];
  formatMessageTime: (dateStr: string) => string;
  formatDateSeparator: (dateStr: string) => string;
}

const MessageList: React.FC<MessageListProps> = ({
  messageGroups,
  formatMessageTime,
  formatDateSeparator,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messageGroups]);

  if (messageGroups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground/50 text-sm italic">No messages yet</p>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 md:px-6 py-6 space-y-6 scroll-smooth"
    >
      {messageGroups.map((group, groupIndex) => (
        <div key={groupIndex} className="space-y-4">
          {/* Date separator */}
          <div className="flex items-center justify-center">
            <div className="bg-muted/60 backdrop-blur-sm px-4 py-1.5 rounded-full shadow-sm border border-border/30">
              <span className="text-xs font-semibold text-muted-foreground tracking-wide">
                {formatDateSeparator(group.date)}
              </span>
            </div>
          </div>
          
          {/* Messages */}
          <div className="space-y-3">
            {group.messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                formatTime={formatMessageTime}
              />
            ))}
          </div>
        </div>
      ))}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default memo(MessageList);
