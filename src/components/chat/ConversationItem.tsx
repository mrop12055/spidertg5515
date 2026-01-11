import React, { memo } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical, Pin, PinOff, EyeOff, EyeIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Conversation {
  id: string;
  account_id: string;
  recipient_phone: string | null;
  recipient_name: string | null;
  recipient_username: string | null;
  recipient_avatar: string | null;
  recipient_telegram_id: number | null;
  unread_count: number;
  last_message_at: string | null;
  is_active: boolean;
  seat_id: string | null;
  first_message_sent: boolean | null;
  last_message_content?: string;
  last_message_direction?: 'incoming' | 'outgoing';
  has_reply?: boolean;
  is_pinned?: boolean;
  is_hidden?: boolean;
}

interface ConversationItemProps {
  conversation: Conversation;
  isSelected: boolean;
  onSelect: (conv: Conversation) => void;
  onTogglePin: (id: string, isPinned: boolean) => void;
  onToggleHide: (id: string, isHidden: boolean) => void;
  formatTime: (date: string | null) => string;
  getAvatarColor: (phone: string | null) => string;
  getAvatarInitial: (conv: Conversation) => string;
  getDisplayName: (conv: Conversation) => string;
}

const ConversationItem: React.FC<ConversationItemProps> = ({
  conversation: conv,
  isSelected,
  onSelect,
  onTogglePin,
  onToggleHide,
  formatTime,
  getAvatarColor,
  getAvatarInitial,
  getDisplayName,
}) => {
  return (
    <div
      className={cn(
        "flex items-center gap-3.5 px-3 py-4 cursor-pointer transition-colors duration-150 group rounded-xl",
        isSelected
          ? "bg-primary/10 border border-primary/30 shadow-sm shadow-primary/10"
          : "hover:bg-muted/60 border border-transparent"
      )}
      onClick={() => onSelect(conv)}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        <Avatar className="w-14 h-14 ring-2 ring-background/80 shadow-md">
          <AvatarImage src={conv.recipient_avatar || ''} />
          <AvatarFallback className={cn(
            "bg-gradient-to-br text-white text-base font-bold",
            getAvatarColor(conv.recipient_phone)
          )}>
            {getAvatarInitial(conv)}
          </AvatarFallback>
        </Avatar>
        {conv.is_pinned && (
          <span className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-amber-500 border-2 border-card flex items-center justify-center">
            <Pin className="w-2.5 h-2.5 text-white" />
          </span>
        )}
        {conv.unread_count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-primary border-2 border-card" />
        )}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <p className="font-semibold text-base text-foreground truncate">
              {getDisplayName(conv)}
            </p>
            {conv.first_message_sent && (
              <span className="flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-violet-500/15 text-violet-600 dark:text-violet-400 border border-violet-500/20">
                Campaign
              </span>
            )}
          </div>
          <span className={cn(
            "text-sm flex-shrink-0 font-medium tabular-nums",
            conv.unread_count > 0 ? "text-primary font-semibold" : "text-muted-foreground/70"
          )}>
            {formatTime(conv.last_message_at)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-1.5">
          <p className={cn(
            "text-sm truncate",
            conv.unread_count > 0 ? "text-foreground font-medium" : "text-muted-foreground/70"
          )}>
            {conv.last_message_content ? (
              <>
                {conv.last_message_direction === 'outgoing' && (
                  <span className="text-muted-foreground/50">You: </span>
                )}
                {conv.last_message_content.slice(0, 45)}{conv.last_message_content.length > 45 ? '...' : ''}
              </>
            ) : (
              <span className="italic text-muted-foreground/50">No messages</span>
            )}
          </p>
          {conv.unread_count > 0 && (
            <span className="bg-gradient-to-r from-primary to-primary/80 text-primary-foreground text-[9px] font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1.5 flex-shrink-0 shadow-sm">
              {conv.unread_count}
            </span>
          )}
        </div>
      </div>

      {/* Actions Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/80 rounded-md"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-popover border-border text-popover-foreground w-36">
          <DropdownMenuItem 
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(conv.id, !!conv.is_pinned);
            }}
            className="text-muted-foreground hover:bg-muted focus:bg-muted text-xs"
          >
            {conv.is_pinned ? (
              <>
                <PinOff className="w-3 h-3 mr-2" />
                Unpin
              </>
            ) : (
              <>
                <Pin className="w-3 h-3 mr-2" />
                Pin
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem 
            onClick={(e) => {
              e.stopPropagation();
              onToggleHide(conv.id, !!conv.is_hidden);
            }}
            className="text-muted-foreground hover:bg-muted focus:bg-muted text-xs"
          >
            {conv.is_hidden ? (
              <>
                <EyeIcon className="w-3 h-3 mr-2" />
                Unhide
              </>
            ) : (
              <>
                <EyeOff className="w-3 h-3 mr-2" />
                Hide
              </>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

// Memoize with custom comparison for performance
export default memo(ConversationItem, (prevProps, nextProps) => {
  const prev = prevProps.conversation;
  const next = nextProps.conversation;
  
  return (
    prev.id === next.id &&
    prev.unread_count === next.unread_count &&
    prev.last_message_content === next.last_message_content &&
    prev.last_message_at === next.last_message_at &&
    prev.is_pinned === next.is_pinned &&
    prev.is_hidden === next.is_hidden &&
    prev.has_reply === next.has_reply &&
    prevProps.isSelected === nextProps.isSelected
  );
});
