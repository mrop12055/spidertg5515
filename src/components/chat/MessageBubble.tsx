import React, { memo } from 'react';
import { Check, CheckCheck, Clock, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LinkifiedText } from './LinkifiedText';

interface Message {
  id: string;
  content: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' | 'sending';
  created_at: string;
  media_url: string | null;
  media_type: string | null;
}

interface MessageBubbleProps {
  message: Message;
  formatTime: (dateStr: string) => string;
}

const getMessageStatusIcon = (status: string) => {
  switch (status) {
    case 'read':
      return <CheckCheck className="w-4 h-4 text-[#53bdeb]" />;
    case 'delivered':
      return <CheckCheck className="w-4 h-4 text-[#8696a0]" />;
    case 'sent':
      return <Check className="w-4 h-4 text-[#8696a0]" />;
    case 'pending':
      return <Clock className="w-3.5 h-3.5 text-[#8696a0]" />;
    case 'failed':
      return <AlertCircle className="w-4 h-4 text-red-500" />;
    default:
      return null;
  }
};

const MessageBubble: React.FC<MessageBubbleProps> = ({ message: msg, formatTime }) => {
  const isOutgoing = msg.direction === 'outgoing';
  
  return (
    <div className={cn(
      "flex items-end gap-2",
      isOutgoing ? 'justify-end' : 'justify-start'
    )}>
      <div className={cn(
        "max-w-[75%] lg:max-w-[65%] group relative",
        isOutgoing 
          ? 'bg-gradient-to-br from-primary to-primary/90 text-primary-foreground rounded-2xl rounded-br-md shadow-md shadow-primary/20'
          : 'bg-card text-foreground rounded-2xl rounded-bl-md shadow-md border border-border/50'
      )}>
        {/* Media */}
        {msg.media_url && (
          <div className="p-1.5">
            {msg.media_type === 'image' ? (
              <img 
                src={msg.media_url} 
                alt="Attachment" 
                className="max-w-full rounded-xl max-h-72 object-cover cursor-pointer hover:opacity-95 transition-opacity shadow-sm"
                loading="lazy"
              />
            ) : (
              <a 
                href={msg.media_url} 
                target="_blank" 
                rel="noopener noreferrer"
                className={cn(
                  "text-sm underline hover:no-underline px-3 py-2 block",
                  isOutgoing ? "text-primary-foreground/90" : "text-primary"
                )}
              >
                View attachment
              </a>
            )}
          </div>
        )}
        
        {/* Content */}
        {msg.content && (
          <div className="px-4 py-2.5">
            <p className={cn(
              "text-[15px] leading-relaxed break-words whitespace-pre-wrap",
              isOutgoing ? 'text-primary-foreground' : 'text-foreground'
            )}>
              <LinkifiedText text={msg.content} />
            </p>
          </div>
        )}
        
        {/* Message footer */}
        <div className={cn(
          "flex items-center gap-1.5 mt-1.5 px-1 pb-1",
          isOutgoing ? 'justify-end pr-3' : 'justify-start pl-3'
        )}>
          <span className="text-[11px] text-muted-foreground/70">
            {formatTime(msg.created_at)}
          </span>
          {isOutgoing && (
            <span className="flex items-center">
              {getMessageStatusIcon(msg.status)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(MessageBubble, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.status === next.message.status &&
    prev.message.content === next.message.content
  );
});
