import React, { useState, useRef, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useTelegram } from '@/context/TelegramContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmojiPicker } from '@/components/ui/emoji-picker';
import { 
  Send, 
  Search, 
  Phone, 
  MoreVertical, 
  Paperclip, 
  Check, 
  CheckCheck,
  MessageSquare,
  Clock,
  Plus,
  UserPlus,
  XCircle,
  Image,
  X,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { toast } from 'sonner';

const Chat: React.FC = () => {
  const { 
    conversations, 
    messages, 
    sendMessage, 
    sendMediaMessage,
    accounts, 
    typingUsers,
    markConversationAsRead,
    startNewConversation 
  } = useTelegram();
  
  const [selectedConversation, setSelectedConversation] = useState<string | null>(
    conversations[0]?.id || null
  );
  const [messageInput, setMessageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState('');
  const [newChatName, setNewChatName] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || '');
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isSendingMedia, setIsSendingMedia] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedConv = conversations.find(c => c.id === selectedConversation);
  const conversationMessages = messages
    .filter(m => selectedConv && m.recipientPhone === selectedConv.recipientPhone)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const filteredConversations = conversations
    .filter(c =>
      c.recipientName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.recipientPhone.includes(searchQuery)
    )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const isTyping = selectedConv ? typingUsers[selectedConv.recipientPhone] : false;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversationMessages, isTyping]);

  // Mark conversation as read when selected
  useEffect(() => {
    if (selectedConversation) {
      // Small delay to ensure the conversation is rendered first
      const timer = setTimeout(() => {
        markConversationAsRead(selectedConversation);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [selectedConversation, markConversationAsRead]);

  const handleSendMessage = async () => {
    if ((!messageInput.trim() && !selectedImage) || !selectedConv) return;
    
    const account = accounts.find(a => a.id === selectedConv.accountId) || accounts[0];
    if (!account) return;

    if (selectedImage) {
      setIsSendingMedia(true);
      try {
        await sendMediaMessage(account.id, selectedConv.recipientPhone, selectedImage, messageInput || undefined);
        setSelectedImage(null);
        setImagePreview(null);
        setMessageInput('');
      } finally {
        setIsSendingMedia(false);
      }
    } else {
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

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast.error('Please select an image file');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast.error('Image must be less than 10MB');
        return;
      }
      setSelectedImage(file);
      const reader = new FileReader();
      reader.onload = (e) => setImagePreview(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    setMessageInput(prev => prev + emoji);
  };

  const clearSelectedImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleStartNewChat = async () => {
    if (!newChatPhone.trim() || !selectedAccountId) return;
    
    const convId = await startNewConversation(selectedAccountId, newChatPhone, newChatName || undefined);
    if (convId) {
      setSelectedConversation(convId);
    }
    setIsNewChatOpen(false);
    setNewChatPhone('');
    setNewChatName('');
  };

  const formatMessageDate = (date: Date) => {
    if (isToday(date)) return format(date, 'HH:mm');
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMM d');
  };

  const formatDateSeparator = (date: Date) => {
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMMM d, yyyy');
  };

  const formatLastSeen = (date: Date | undefined, isActive: boolean) => {
    if (isActive) return 'online';
    if (!date) return 'offline';
    if (isToday(date)) return `last seen at ${format(date, 'HH:mm')}`;
    if (isYesterday(date)) return `last seen yesterday at ${format(date, 'HH:mm')}`;
    return `last seen ${format(date, 'MMM d')}`;
  };

  const getMessageStatus = (status: string) => {
    switch (status) {
      case 'read':
        return <CheckCheck className="w-4 h-4 text-[#34B7F1]" />;
      case 'delivered':
        return <CheckCheck className="w-4 h-4 text-muted-foreground/70" />;
      case 'sent':
        return <Check className="w-4 h-4 text-muted-foreground/70" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-destructive" />;
      case 'pending':
        return <Clock className="w-3 h-3 text-muted-foreground/50" />;
      default:
        return <Clock className="w-3 h-3 text-muted-foreground/50" />;
    }
  };

  // Group messages by date
  const groupedMessages: { date: Date; messages: typeof conversationMessages }[] = [];
  conversationMessages.forEach(msg => {
    const msgDate = new Date(msg.timestamp);
    const lastGroup = groupedMessages[groupedMessages.length - 1];
    
    if (!lastGroup || !isSameDay(new Date(lastGroup.date), msgDate)) {
      groupedMessages.push({ date: msgDate, messages: [msg] });
    } else {
      lastGroup.messages.push(msg);
    }
  });

  const activeAccounts = accounts.filter(a => a.status === 'active');

  return (
    <DashboardLayout>
      <div className="h-[calc(100vh-100px)] flex rounded-xl overflow-hidden border border-border bg-card shadow-lg">
        {/* Sidebar - Conversation List */}
        <div className="w-[340px] border-r border-border flex flex-col bg-card">
          {/* Header */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Chats</h2>
              <Dialog open={isNewChatOpen} onOpenChange={setIsNewChatOpen}>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Plus className="w-5 h-5" />
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>New Conversation</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 pt-4">
                    <div className="space-y-2">
                      <Label>Select Account</Label>
                      <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose account" />
                        </SelectTrigger>
                        <SelectContent>
                          {activeAccounts.map(acc => (
                            <SelectItem key={acc.id} value={acc.id}>
                              {acc.firstName} ({acc.phoneNumber})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Phone Number or Username</Label>
                      <Input
                        placeholder="+1234567890 or @username"
                        value={newChatPhone}
                        onChange={(e) => setNewChatPhone(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Enter a phone number with country code or Telegram @username
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label>Name (Optional)</Label>
                      <Input
                        placeholder="Contact name"
                        value={newChatName}
                        onChange={(e) => setNewChatName(e.target.value)}
                      />
                    </div>
                    <Button onClick={handleStartNewChat} className="w-full">
                      <UserPlus className="w-4 h-4 mr-2" />
                      Start Chat
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 bg-secondary/50 border-0 focus-visible:ring-1 rounded-full"
              />
            </div>
          </div>

          {/* Conversation List */}
          <ScrollArea className="flex-1">
            <div>
              {filteredConversations.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                  <p className="text-muted-foreground text-sm">No conversations yet</p>
                  <Button 
                    variant="link" 
                    className="mt-2 text-primary"
                    onClick={() => setIsNewChatOpen(true)}
                  >
                    Start a new chat
                  </Button>
                </div>
              ) : (
                filteredConversations.map((conv) => {
                  const convMessages = messages.filter(m => m.recipientPhone === conv.recipientPhone);
                  const lastMsg = convMessages.sort((a, b) => 
                    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                  )[0];
                  const isSelected = selectedConversation === conv.id;
                  const isUserTyping = typingUsers[conv.recipientPhone];

                  return (
                    <button
                      key={conv.id}
                      onClick={() => setSelectedConversation(conv.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-3 transition-all duration-150 text-left hover:bg-accent/50",
                        isSelected && "bg-primary/10"
                      )}
                    >
                      <div className="relative flex-shrink-0">
                        <Avatar className="h-12 w-12">
                          <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground font-medium text-lg">
                            {conv.recipientName?.charAt(0).toUpperCase() || '?'}
                          </AvatarFallback>
                        </Avatar>
                        {conv.isActive && (
                          <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-[#31A24C] rounded-full ring-2 ring-card" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className={cn(
                            "font-medium truncate",
                            conv.unreadCount > 0 ? "text-foreground" : "text-foreground"
                          )}>
                            {conv.recipientName || conv.recipientPhone}
                          </span>
                          <span className={cn(
                            "text-xs flex-shrink-0 ml-2",
                            conv.unreadCount > 0 ? "text-primary font-medium" : "text-muted-foreground"
                          )}>
                            {formatMessageDate(conv.updatedAt)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <p className={cn(
                            "text-sm truncate max-w-[200px] flex items-center gap-1",
                            conv.unreadCount > 0 ? "text-foreground" : "text-muted-foreground"
                          )}>
                            {isUserTyping ? (
                              <span className="text-primary italic">typing...</span>
                            ) : (
                              <>
                                {lastMsg?.direction === 'outgoing' && (
                                  <span className="flex-shrink-0">{getMessageStatus(lastMsg.status)}</span>
                                )}
                                <span className="truncate">{lastMsg?.content || 'No messages'}</span>
                              </>
                            )}
                          </p>
                          {conv.unreadCount > 0 && (
                            <Badge className="h-5 min-w-5 flex items-center justify-center text-xs bg-primary rounded-full ml-2">
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
        <div className="flex-1 flex flex-col bg-secondary/30 dark:bg-background/50">
          {selectedConv ? (
            <>
              {/* Chat Header */}
              <div className="h-16 px-4 border-b border-border flex items-center justify-between bg-card">
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground font-medium">
                      {selectedConv.recipientName?.charAt(0).toUpperCase() || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <h3 className="font-semibold text-foreground leading-tight">
                      {selectedConv.recipientName || selectedConv.recipientPhone}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {isTyping ? (
                        <span className="text-primary">typing...</span>
                      ) : (
                        formatLastSeen(selectedConv.updatedAt, selectedConv.isActive)
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                    <Phone className="w-5 h-5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                    <Search className="w-5 h-5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                    <MoreVertical className="w-5 h-5" />
                  </Button>
                </div>
              </div>

              {/* Messages Area */}
              <ScrollArea className="flex-1 px-4 py-2">
                <div className="max-w-3xl mx-auto space-y-1">
                  {groupedMessages.length === 0 ? (
                    <div className="text-center py-16">
                      <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                        <MessageSquare className="w-10 h-10 text-primary" />
                      </div>
                      <h3 className="font-medium text-foreground mb-1">Start a conversation</h3>
                      <p className="text-sm text-muted-foreground">Send a message to begin chatting</p>
                    </div>
                  ) : (
                    groupedMessages.map((group, groupIndex) => (
                      <div key={groupIndex}>
                        {/* Date Separator */}
                        <div className="flex justify-center my-4">
                          <span className="px-3 py-1 bg-card/80 backdrop-blur-sm rounded-lg text-xs text-muted-foreground shadow-sm border border-border/50">
                            {formatDateSeparator(group.date)}
                          </span>
                        </div>
                        
                        {/* Messages for this date */}
                        {group.messages.map((msg, msgIndex) => {
                          const isOutgoing = msg.direction === 'outgoing';
                          const prevMsg = group.messages[msgIndex - 1];
                          const nextMsg = group.messages[msgIndex + 1];
                          const isFirstInGroup = !prevMsg || prevMsg.direction !== msg.direction;
                          const isLastInGroup = !nextMsg || nextMsg.direction !== msg.direction;

                          return (
                            <div
                              key={msg.id}
                              className={cn(
                                "flex",
                                isOutgoing ? "justify-end" : "justify-start",
                                isLastInGroup ? "mb-2" : "mb-0.5"
                              )}
                            >
                              <div
                                className={cn(
                                  "max-w-[65%] relative",
                                  isOutgoing ? "order-1" : "order-2"
                                )}
                              >
                                <div
                                  className={cn(
                                    "px-3 py-2 shadow-sm relative",
                                    msg.status === 'failed'
                                      ? "bg-destructive/10 border border-destructive/30 text-foreground"
                                      : isOutgoing
                                        ? "bg-primary/90 text-primary-foreground dark:bg-primary/80 dark:text-primary-foreground"
                                        : "bg-card text-card-foreground border border-border",
                                    // Rounded corners based on position
                                    isFirstInGroup && isLastInGroup && (isOutgoing 
                                      ? "rounded-2xl rounded-br-md" 
                                      : "rounded-2xl rounded-bl-md"),
                                    isFirstInGroup && !isLastInGroup && (isOutgoing 
                                      ? "rounded-t-2xl rounded-bl-2xl rounded-br-md" 
                                      : "rounded-t-2xl rounded-br-2xl rounded-bl-md"),
                                    !isFirstInGroup && isLastInGroup && (isOutgoing 
                                      ? "rounded-b-2xl rounded-tl-2xl rounded-tr-md rounded-br-md" 
                                      : "rounded-b-2xl rounded-tr-2xl rounded-tl-md rounded-bl-md"),
                                    !isFirstInGroup && !isLastInGroup && (isOutgoing 
                                      ? "rounded-l-2xl rounded-r-md" 
                                      : "rounded-r-2xl rounded-l-md")
                                  )}
                                >
                                  {/* Display image if present */}
                                  {msg.mediaUrl && msg.mediaType === 'image' && (
                                    <div className="mb-2 -mx-1 -mt-1">
                                      <img 
                                        src={msg.mediaUrl} 
                                        alt="Shared image" 
                                        className="max-w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                                        style={{ maxHeight: '300px' }}
                                        onClick={() => window.open(msg.mediaUrl, '_blank')}
                                      />
                                    </div>
                                  )}
                                  {msg.content && (
                                    <p className="text-sm leading-relaxed break-words">{msg.content}</p>
                                  )}
                                  {/* Show failed reason if message failed */}
                                  {msg.status === 'failed' && msg.failedReason && (
                                    <p className="text-xs text-destructive mt-1 pt-1 border-t border-destructive/20">
                                      ⚠ {msg.failedReason.replace('PERMANENT: ', '')}
                                    </p>
                                  )}
                                  <div className="flex items-center justify-end gap-1 mt-0.5 -mb-0.5">
                                    <span className={cn(
                                      "text-[11px]",
                                      msg.status === 'failed'
                                        ? "text-destructive"
                                        : isOutgoing 
                                          ? "text-primary-foreground/80" 
                                          : "text-muted-foreground"
                                    )}>
                                      {format(msg.timestamp, 'HH:mm')}
                                    </span>
                                    {isOutgoing && (
                                      <span className="ml-0.5">{getMessageStatus(msg.status)}</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                  
                  {/* Typing Indicator */}
                  {isTyping && (
                    <div className="flex justify-start mb-2">
                      <div className="bg-card border border-border px-4 py-3 rounded-2xl rounded-bl-md shadow-sm">
                        <div className="flex gap-1">
                          <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <div ref={messagesEndRef} />
                </div>
              </ScrollArea>

              {/* Message Input */}
              <div className="p-3 bg-card border-t border-border">
                {/* Image Preview */}
                {imagePreview && (
                  <div className="max-w-3xl mx-auto mb-3">
                    <div className="relative inline-block">
                      <img 
                        src={imagePreview} 
                        alt="Preview" 
                        className="h-24 rounded-lg object-cover border border-border"
                      />
                      <Button
                        variant="destructive"
                        size="icon"
                        className="absolute -top-2 -right-2 h-6 w-6 rounded-full"
                        onClick={clearSelectedImage}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                )}
                
                <div className="max-w-3xl mx-auto flex items-end gap-2">
                  <EmojiPicker onEmojiSelect={handleEmojiSelect} className="h-10 w-10" />
                  
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleImageSelect}
                    accept="image/*"
                    className="hidden"
                  />
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="text-muted-foreground hover:text-foreground h-10 w-10"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Image className="w-6 h-6" />
                  </Button>
                  
                  <div className="flex-1">
                    <Input
                      placeholder={selectedImage ? "Add a caption..." : "Type a message"}
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyDown={handleKeyPress}
                      className="rounded-full bg-secondary/50 border-0 focus-visible:ring-1 focus-visible:ring-primary h-10"
                    />
                  </div>
                  <Button 
                    onClick={handleSendMessage} 
                    disabled={(!messageInput.trim() && !selectedImage) || isSendingMedia}
                    size="icon"
                    className="h-10 w-10 rounded-full bg-primary hover:bg-primary/90"
                  >
                    {isSendingMedia ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Send className="w-5 h-5" />
                    )}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center bg-card/50">
              <div className="text-center">
                <div className="w-32 h-32 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
                  <MessageSquare className="w-16 h-16 text-primary" />
                </div>
                <h3 className="text-xl font-medium text-foreground mb-2">Telegram Hub Chat</h3>
                <p className="text-muted-foreground max-w-sm mb-4">
                  Send and receive messages from your Telegram accounts
                </p>
                <Button onClick={() => setIsNewChatOpen(true)} variant="outline" className="gap-2">
                  <Plus className="w-4 h-4" />
                  Start New Chat
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Chat;
