import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Send, Search, Phone, MoreVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const Chat: React.FC = () => {
  const { conversations, messages, sendMessage, accounts } = useTelegram();
  const [selectedConversation, setSelectedConversation] = useState<string | null>(
    conversations[0]?.id || null
  );
  const [messageInput, setMessageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const selectedConv = conversations.find(c => c.id === selectedConversation);
  const conversationMessages = messages.filter(
    m => selectedConv && m.recipientPhone === selectedConv.recipientPhone
  );

  const filteredConversations = conversations.filter(c =>
    c.recipientName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.recipientPhone.includes(searchQuery)
  );

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

  return (
    <DashboardLayout>
      <PageHeader
        title="Chat"
        description="Two-way conversations with contacts"
      />

      <div className="grid grid-cols-12 gap-4 h-[calc(100vh-180px)]">
        {/* Conversation List */}
        <Card className="col-span-4 flex flex-col">
          <div className="p-4 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {filteredConversations.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  No conversations yet
                </div>
              ) : (
                filteredConversations.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => setSelectedConversation(conv.id)}
                    className={cn(
                      "w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left",
                      selectedConversation === conv.id
                        ? "bg-primary/10 border border-primary/20"
                        : "hover:bg-accent"
                    )}
                  >
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="bg-primary/20 text-primary">
                        {conv.recipientName?.charAt(0) || '?'}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm truncate">
                          {conv.recipientName || conv.recipientPhone}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {format(conv.updatedAt, 'HH:mm')}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {conv.recipientPhone}
                      </p>
                    </div>
                    {conv.unreadCount > 0 && (
                      <Badge variant="default" className="h-5 min-w-5 flex items-center justify-center">
                        {conv.unreadCount}
                      </Badge>
                    )}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </Card>

        {/* Chat Area */}
        <Card className="col-span-8 flex flex-col">
          {selectedConv ? (
            <>
              {/* Chat Header */}
              <div className="p-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback className="bg-primary/20 text-primary">
                      {selectedConv.recipientName?.charAt(0) || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <h3 className="font-medium">
                      {selectedConv.recipientName || 'Unknown'}
                    </h3>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Phone className="w-3 h-3" />
                      {selectedConv.recipientPhone}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="icon">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </div>

              {/* Messages */}
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-4">
                  {conversationMessages.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8">
                      No messages yet. Start the conversation!
                    </div>
                  ) : (
                    conversationMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={cn(
                          "flex",
                          msg.direction === 'outgoing' ? "justify-end" : "justify-start"
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[70%] rounded-2xl px-4 py-2",
                            msg.direction === 'outgoing'
                              ? "bg-primary text-primary-foreground rounded-br-md"
                              : "bg-accent rounded-bl-md"
                          )}
                        >
                          <p className="text-sm">{msg.content}</p>
                          <p className={cn(
                            "text-xs mt-1",
                            msg.direction === 'outgoing' 
                              ? "text-primary-foreground/70" 
                              : "text-muted-foreground"
                          )}>
                            {format(msg.timestamp, 'HH:mm')}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>

              {/* Message Input */}
              <div className="p-4 border-t border-border">
                <div className="flex gap-2">
                  <Input
                    placeholder="Type a message..."
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={handleKeyPress}
                    className="flex-1"
                  />
                  <Button onClick={handleSendMessage} disabled={!messageInput.trim()}>
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <CardContent className="flex-1 flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <p>Select a conversation to start chatting</p>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default Chat;
