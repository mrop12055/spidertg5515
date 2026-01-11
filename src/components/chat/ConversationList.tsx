import React, { memo, useCallback } from 'react';
import { MessageSquare, Pin, EyeOff } from 'lucide-react';
import ConversationItem from './ConversationItem';

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

type ChatTab = 'all' | 'pinned' | 'hidden';

interface ConversationListProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  chatTab: ChatTab;
  searchQuery: string;
  onSelectConversation: (conv: Conversation) => void;
  onTogglePin: (id: string, isPinned: boolean) => void;
  onToggleHide: (id: string, isHidden: boolean) => void;
  formatTime: (date: string | null) => string;
  getAvatarColor: (phone: string | null) => string;
  getAvatarInitial: (conv: Conversation) => string;
  getDisplayName: (conv: Conversation) => string;
}

const ConversationList: React.FC<ConversationListProps> = ({
  conversations,
  selectedConversationId,
  chatTab,
  searchQuery,
  onSelectConversation,
  onTogglePin,
  onToggleHide,
  formatTime,
  getAvatarColor,
  getAvatarInitial,
  getDisplayName,
}) => {
  const handleSelect = useCallback((conv: Conversation) => {
    onSelectConversation(conv);
  }, [onSelectConversation]);

  const handleTogglePin = useCallback((id: string, isPinned: boolean) => {
    onTogglePin(id, isPinned);
  }, [onTogglePin]);

  const handleToggleHide = useCallback((id: string, isHidden: boolean) => {
    onToggleHide(id, isHidden);
  }, [onToggleHide]);

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-muted/80 to-muted/40 flex items-center justify-center mb-3 border border-border/50">
          {chatTab === 'hidden' ? (
            <EyeOff className="w-5 h-5 text-muted-foreground/50" />
          ) : chatTab === 'pinned' ? (
            <Pin className="w-5 h-5 text-muted-foreground/50" />
          ) : (
            <MessageSquare className="w-5 h-5 text-muted-foreground/50" />
          )}
        </div>
        <p className="text-foreground font-semibold text-xs">
          {chatTab === 'hidden' ? 'No hidden chats' : 
           chatTab === 'pinned' ? 'No pinned chats' : 
           'No conversations'}
        </p>
        <p className="text-[10px] text-muted-foreground/80 mt-1 text-center max-w-[160px]">
          {searchQuery ? 'No results match your search' : 
           chatTab === 'hidden' ? 'Hidden conversations appear here' :
           chatTab === 'pinned' ? 'Pin important conversations' :
           'New conversations will appear here'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 py-1.5">
      {conversations.map((conv) => (
        <ConversationItem
          key={conv.id}
          conversation={conv}
          isSelected={selectedConversationId === conv.id}
          onSelect={handleSelect}
          onTogglePin={handleTogglePin}
          onToggleHide={handleToggleHide}
          formatTime={formatTime}
          getAvatarColor={getAvatarColor}
          getAvatarInitial={getAvatarInitial}
          getDisplayName={getDisplayName}
        />
      ))}
    </div>
  );
};

export default memo(ConversationList);
