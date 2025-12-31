import React, { useState, useRef, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useTelegram } from '@/context/TelegramContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { 
  Send, 
  Search, 
  Phone, 
  MoreVertical, 
  Paperclip, 
  Smile, 
  Check, 
  CheckCheck,
  MessageSquare,
  Circle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday } from 'date-fns';

const Chat: React.FC = () => {
  const { conversations, messages, sendMessage, accounts } = useTelegram();
  const [selectedConversation, setSelectedConversation] = useState<string | null>(
    conversations[0]?.id || null
  );
  const [messageInput, setMessageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selectedConv = conversations.find(c => c.id === selectedConversation);
  const conversationMessages = messages.filter(
    m => selectedConv && m.recipientPhone === selectedConv.recipientPhone
  );

  const filteredConversations = conversations.filter(c =>
    c.recipientName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.recipientPhone.includes(searchQuery)
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversationMessages]);

  const handleSendMessage = () => {
    if (!messageInput.trim() || !selectedConv) return;
    
    const account = accounts.find(a => a.id === selectedConv.accountId);
    if (account) {
      sendMessage(account.id, selectedConv.recipientPhone, messageInput);
      setMessageInput('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const formatMessageDate = (date: Date) => {
    if (isToday(date)) return format(date, 'HH:mm');
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMM d');
  };

  const getMessageStatus = (status: string) => {
    switch (status) {
      case 'read':
        return <CheckCheck className="w-3.5 h-3.5 text-primary" />;
      case 'delivered':
        return <CheckCheck className="w-3.5 h-3.5 text-muted-foreground" />;
      case 'sent':
        return <Check className="w-3.5 h-3.5 text-muted-foreground" />;
      default:
        return <Circle className="w-2 h-2 text-muted-foreground" />;
    }
  };

  return (
    <DashboardLayout>
      <div className="h-[calc(100vh-100px)] flex rounded-xl overflow-hidden border border-border bg-card shadow-lg">
        {/* Sidebar - Conversation List */}
        <div className="w-80 border-r border-border flex flex-col bg-card">
          {/* Header */}
          <div className="p-4 border-b border-border">
            <h2 className="text-lg font-semibold mb-3">Messages</h2>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 bg-secondary/50 border-0 focus-visible:ring-1"
              />
            </div>
          </div>

          {/* Conversation List */}
          <ScrollArea className="flex-1">
            <div className="py-2">
              {filteredConversations.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                  <p className="text-muted-foreground text-sm">No conversations yet</p>
                </div>
              ) : (
                filteredConversations.map((conv) => {
                  const lastMsg = messages.find(m => m.recipientPhone === conv.recipientPhone);
                  const isSelected = selectedConversation === conv.id;

                  return (
                    <button
                      key={conv.id}
                      onClick={() => setSelectedConversation(conv.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-3 transition-all duration-200 text-left",
                        isSelected
                          ? "bg-primary/10 border-l-2 border-l-primary"
                          : "hover:bg-accent/50 border-l-2 border-l-transparent"
                      )}
                    >
                      <div className="relative">
                        <Avatar className="h-12 w-12 ring-2 ring-background">
                          <AvatarFallback className="bg-gradient-to-br from-primary to-primary/60 text-primary-foreground font-medium">
                            {conv.recipientName?.charAt(0) || '?'}
                          </AvatarFallback>
                        </Avatar>
                        {conv.isActive && (
                          <span className="absolute bottom-0 right-0 w-3 h-3 bg-status-active rounded-full ring-2 ring-background" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className={cn(
                            "font-medium text-sm truncate",
                            conv.unreadCount > 0 && "text-foreground"
                          )}>
                            {conv.recipientName || conv.recipientPhone}
                          </span>
                          <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
                            {formatMessageDate(conv.updatedAt)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <p className={cn(
                            "text-xs truncate max-w-[180px]",
                            conv.unreadCount > 0 ? "text-foreground font-medium" : "text-muted-foreground"
                          )}>
                            {lastMsg?.direction === 'outgoing' && (
                              <span className="inline-flex mr-1">{getMessageStatus(lastMsg.status)}</span>
                            )}
                            {lastMsg?.content || 'No messages'}
                          </p>
                          {conv.unreadCount > 0 && (
                            <Badge className="h-5 min-w-5 flex items-center justify-center text-xs bg-primary">
                              {conv.unreadCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col bg-background/50">
          {selectedConv ? (
            <>
              {/* Chat Header */}
              <div className="h-16 px-6 border-b border-border flex items-center justify-between bg-card/80 backdrop-blur-sm">
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="bg-gradient-to-br from-primary to-primary/60 text-primary-foreground font-medium">
                        {selectedConv.recipientName?.charAt(0) || '?'}
                      </AvatarFallback>
                    </Avatar>
                    {selectedConv.isActive && (
                      <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-status-active rounded-full ring-2 ring-card" />
                    )}
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">
                      {selectedConv.recipientName || 'Unknown'}
                    </h3>
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Phone className="w-3 h-3" />
                      {selectedConv.recipientPhone}
                      <span className="text-primary">• Online</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                    <Search className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                    <MoreVertical className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Messages Area */}
              <ScrollArea className="flex-1 px-6 py-4">
                <div className="max-w-3xl mx-auto space-y-3">
                  {conversationMessages.length === 0 ? (
                    <div className="text-center py-16">
                      <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                        <MessageSquare className="w-10 h-10 text-primary" />
                      </div>
                      <h3 className="font-medium text-foreground mb-1">Start a conversation</h3>
                      <p className="text-sm text-muted-foreground">Send a message to begin chatting</p>
                    </div>
                  ) : (
                    conversationMessages.map((msg, index) => {
                      const isOutgoing = msg.direction === 'outgoing';
                      const showAvatar = index === 0 || 
                        conversationMessages[index - 1]?.direction !== msg.direction;

                      return (
                        <div
                          key={msg.id}
                          className={cn(
                            "flex gap-2",
                            isOutgoing ? "justify-end" : "justify-start"
                          )}
                        >
                          {!isOutgoing && showAvatar && (
                            <Avatar className="h-8 w-8 mt-auto">
                              <AvatarFallback className="bg-accent text-accent-foreground text-xs">
                                {selectedConv.recipientName?.charAt(0) || '?'}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          {!isOutgoing && !showAvatar && <div className="w-8" />}
                          
                          <div
                            className={cn(
                              "max-w-[65%] group relative",
                              isOutgoing ? "order-1" : "order-2"
                            )}
                          >
                            <div
                              className={cn(
                                "px-4 py-2.5 rounded-2xl shadow-sm",
                                isOutgoing
                                  ? "bg-primary text-primary-foreground rounded-br-md"
                                  : "bg-card border border-border rounded-bl-md"
                              )}
                            >
                              <p className="text-sm leading-relaxed">{msg.content}</p>
                              <div className={cn(
                                "flex items-center justify-end gap-1.5 mt-1",
                                isOutgoing ? "text-primary-foreground/70" : "text-muted-foreground"
                              )}>
                                <span className="text-[10px]">
                                  {format(msg.timestamp, 'HH:mm')}
                                </span>
                                {isOutgoing && getMessageStatus(msg.status)}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </ScrollArea>

              {/* Message Input */}
              <div className="p-4 border-t border-border bg-card/80 backdrop-blur-sm">
                <div className="max-w-3xl mx-auto flex items-end gap-3">
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                      <Paperclip className="w-5 h-5" />
                    </Button>
                  </div>
                  <div className="flex-1 relative">
                    <Input
                      placeholder="Type a message..."
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyDown={handleKeyPress}
                      className="pr-12 py-6 rounded-2xl bg-secondary/50 border-0 focus-visible:ring-1 focus-visible:ring-primary"
                    />
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <Smile className="w-5 h-5" />
                    </Button>
                  </div>
                  <Button 
                    onClick={handleSendMessage} 
                    disabled={!messageInput.trim()}
                    size="icon"
                    className="h-12 w-12 rounded-xl bg-primary hover:bg-primary/90 shadow-glow"
                  >
                    <Send className="w-5 h-5" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
                  <MessageSquare className="w-12 h-12 text-primary" />
                </div>
                <h3 className="text-xl font-semibold text-foreground mb-2">Welcome to Chat</h3>
                <p className="text-muted-foreground max-w-sm">
                  Select a conversation from the list to start messaging
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Chat;
