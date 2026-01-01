import React, { useState, useRef, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useTelegram } from '@/context/TelegramContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
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
  Loader2,
  Trash2,
  Ban,
  CheckSquare,
  Square
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday, isSameDay, subDays, differenceInMinutes } from 'date-fns';
import { toast } from 'sonner';
type TimeFilter = '24h' | '3d' | '7d';

const Chat: React.FC = () => {
  const { 
    conversations, 
    messages, 
    sendMessage, 
    sendMediaMessage,
    accounts, 
    typingUsers,
    markConversationAsRead,
    startNewConversation,
    deleteConversation,
    deleteConversations,
    blockContact,
    blockContacts
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
  
  // Selection mode state
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedConversations, setSelectedConversations] = useState<Set<string>>(new Set());
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isBlockDialogOpen, setIsBlockDialogOpen] = useState(false);
  const [singleActionConvId, setSingleActionConvId] = useState<string | null>(null);
  
  // Time filter state
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('24h');

  const selectedConv = conversations.find(c => c.id === selectedConversation);
  // Filter out failed messages from chat view - use conversationId for accurate matching
  const conversationMessages = messages
    .filter(m => selectedConv && m.conversationId === selectedConv.id && m.status !== 'failed')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Filter conversations by time
  const getTimeFilterCutoff = () => {
    const now = new Date();
    switch (timeFilter) {
      case '24h': return subDays(now, 1);
      case '3d': return subDays(now, 3);
      case '7d': return subDays(now, 7);
      default: return subDays(now, 1);
    }
  };

  // Helper to check if we sent the first message (campaign initiated)
  const isUserInitiated = (conv: typeof conversations[0]) => {
    const convMessages = messages.filter(m => m.conversationId === conv.id);
    
    // No messages = don't show
    if (convMessages.length === 0) return false;
    
    // Sort by timestamp
    const sorted = [...convMessages].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    // First message must be outgoing (we sent via campaign)
    return sorted[0]?.direction === 'outgoing';
  };

  // Helper to check if conversation has any successful (non-failed) messages
  const hasSuccessfulMessages = (conv: typeof conversations[0]) => {
    const convMessages = messages.filter(m => m.conversationId === conv.id);
    // Must have at least one message that isn't failed
    return convMessages.some(m => m.status !== 'failed');
  };

  // Helper to get latest message timestamp for a conversation
  const getLastMessageTime = (conv: typeof conversations[0]) => {
    const convMessages = messages.filter(m => m.conversationId === conv.id);
    if (convMessages.length === 0) return new Date(conv.updatedAt).getTime();
    const sorted = [...convMessages].sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return new Date(sorted[0].timestamp).getTime();
  };

  const filteredConversations = conversations
    .filter(c => {
      const cutoff = getTimeFilterCutoff();
      const lastMsgTime = getLastMessageTime(c);
      const matchesTime = lastMsgTime >= cutoff.getTime();
      const matchesSearch = 
        c.recipientName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.recipientPhone?.includes(searchQuery);
      // Exclude SpamBot conversations
      const isNotSpamBot = 
        c.recipientPhone !== '@SpamBot' && 
        c.recipientName?.toLowerCase() !== 'spam info bot';
      // Only show conversations where WE sent first message
      const weInitiated = isUserInitiated(c);
      // Hide conversations that only have failed messages
      const hasSuccess = hasSuccessfulMessages(c);
      return matchesTime && matchesSearch && isNotSpamBot && weInitiated && hasSuccess;
    })
    // Sort by actual last message time, not updatedAt
    .sort((a, b) => getLastMessageTime(b) - getLastMessageTime(a));

  const isTyping = selectedConv ? typingUsers[selectedConv.recipientPhone] : false;

  // Check if conversation is "live" (has recent incoming messages within 5 minutes)
  const isLiveConversation = (conv: typeof selectedConv) => {
    if (!conv) return false;
    // Check if there are any incoming messages in the last 5 minutes
    const convMessages = messages.filter(m => m.conversationId === conv.id);
    const recentIncoming = convMessages.some(m => 
      m.direction === 'incoming' && 
      differenceInMinutes(new Date(), new Date(m.timestamp)) < 5
    );
    return recentIncoming;
  };

  const selectedConvIsLive = isLiveConversation(selectedConv);

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
    
    // CRITICAL: Always use the conversation's original account - never fallback to another account
    const account = accounts.find(a => a.id === selectedConv.accountId);
    if (!account) {
      toast.error('Original account is not available. Cannot send from a different number.');
      return;
    }

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

  // Selection handlers
  const toggleConversationSelection = (convId: string) => {
    setSelectedConversations(prev => {
      const next = new Set(prev);
      if (next.has(convId)) {
        next.delete(convId);
      } else {
        next.add(convId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedConversations(new Set(filteredConversations.map(c => c.id)));
  };

  const deselectAll = () => {
    setSelectedConversations(new Set());
  };

  const exitSelectionMode = () => {
    setIsSelectionMode(false);
    setSelectedConversations(new Set());
  };

  const handleBulkDelete = async () => {
    if (selectedConversations.size === 0) return;
    await deleteConversations(Array.from(selectedConversations));
    setIsDeleteDialogOpen(false);
    exitSelectionMode();
    if (selectedConversation && selectedConversations.has(selectedConversation)) {
      setSelectedConversation(null);
    }
  };

  const handleBulkBlock = async () => {
    if (selectedConversations.size === 0) return;
    await blockContacts(Array.from(selectedConversations));
    setIsBlockDialogOpen(false);
    exitSelectionMode();
    if (selectedConversation && selectedConversations.has(selectedConversation)) {
      setSelectedConversation(null);
    }
  };

  const handleSingleDelete = async () => {
    if (!singleActionConvId) return;
    await deleteConversation(singleActionConvId);
    setIsDeleteDialogOpen(false);
    setSingleActionConvId(null);
    if (selectedConversation === singleActionConvId) {
      setSelectedConversation(null);
    }
  };

  const handleSingleBlock = async () => {
    if (!singleActionConvId) return;
    await blockContact(singleActionConvId);
    setIsBlockDialogOpen(false);
    setSingleActionConvId(null);
    if (selectedConversation === singleActionConvId) {
      setSelectedConversation(null);
    }
  };

  const openSingleDeleteDialog = (convId: string) => {
    setSingleActionConvId(convId);
    setIsDeleteDialogOpen(true);
  };

  const openSingleBlockDialog = (convId: string) => {
    setSingleActionConvId(convId);
    setIsBlockDialogOpen(true);
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
      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {singleActionConvId ? 'Chat' : `${selectedConversations.size} Chats`}?</DialogTitle>
            <DialogDescription>
              This will permanently delete {singleActionConvId ? 'this chat' : `${selectedConversations.size} selected chats`} and all messages. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsDeleteDialogOpen(false); setSingleActionConvId(null); }}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={singleActionConvId ? handleSingleDelete : handleBulkDelete}>
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block Confirmation Dialog */}
      <Dialog open={isBlockDialogOpen} onOpenChange={setIsBlockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Block {singleActionConvId ? 'Contact' : `${selectedConversations.size} Contacts`}?</DialogTitle>
            <DialogDescription>
              This will block {singleActionConvId ? 'this contact' : `${selectedConversations.size} selected contacts`} and delete their chats.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsBlockDialogOpen(false); setSingleActionConvId(null); }}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={singleActionConvId ? handleSingleBlock : handleBulkBlock}>
              <Ban className="w-4 h-4 mr-2" />
              Block
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="h-[calc(100vh-100px)] flex rounded-xl overflow-hidden border border-border bg-card shadow-lg">
        {/* Sidebar - Conversation List */}
        <div className="w-[340px] border-r border-border flex flex-col bg-card">
          {/* Header */}
          <div className="p-4 border-b border-border">
            {isSelectionMode ? (
              <>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={exitSelectionMode}>
                      <X className="w-5 h-5" />
                    </Button>
                    <span className="font-medium">{selectedConversations.size} selected</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={selectedConversations.size === filteredConversations.length ? deselectAll : selectAll}>
                      {selectedConversations.size === filteredConversations.length ? <Square className="w-5 h-5" /> : <CheckSquare className="w-5 h-5" />}
                    </Button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button 
                    variant="destructive" 
                    size="sm" 
                    className="flex-1"
                    disabled={selectedConversations.size === 0}
                    onClick={() => setIsDeleteDialogOpen(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Delete ({selectedConversations.size})
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="flex-1 text-destructive hover:text-destructive"
                    disabled={selectedConversations.size === 0}
                    onClick={() => setIsBlockDialogOpen(true)}
                  >
                    <Ban className="w-4 h-4 mr-1" />
                    Block ({selectedConversations.size})
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-medium text-muted-foreground">Conversations</h2>
                    {conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0) > 0 && (
                      <Badge className="h-5 min-w-5 flex items-center justify-center text-xs bg-primary rounded-full">
                        {conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0)} unread
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsSelectionMode(true)} title="Select chats">
                      <CheckSquare className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                
                {/* Time Filter Tabs */}
                <div className="flex gap-1 mb-3 p-1 bg-secondary/30 rounded-lg">
                  {(['24h', '3d', '7d'] as TimeFilter[]).map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setTimeFilter(filter)}
                      className={cn(
                        "flex-1 px-2 py-1 text-[10px] font-medium rounded transition-all",
                        timeFilter === filter 
                          ? "bg-background shadow-sm text-foreground" 
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {filter === '24h' ? '24h' : filter === '3d' ? '3d' : '7d'}
                    </button>
                  ))}
                </div>
                
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 bg-secondary/50 border-0 focus-visible:ring-1 rounded-full h-9 text-sm"
                  />
                </div>
              </>
            )}
          </div>

          {/* Conversation List */}
          <ScrollArea className="flex-1">
            <div>
              {filteredConversations.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                  <p className="text-muted-foreground text-sm">No chats yet</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Start a campaign to begin conversations
                  </p>
                </div>
              ) : (
              filteredConversations.map((conv) => {
                  // Filter out failed messages from last message preview - use conversationId for accuracy
                  const convMessages = messages.filter(m => m.conversationId === conv.id && m.status !== 'failed');
                  const lastMsg = convMessages.sort((a, b) => 
                    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                  )[0];
                  const isSelected = selectedConversation === conv.id;
                  const isUserTyping = typingUsers[conv.recipientPhone];
                  const isChecked = selectedConversations.has(conv.id);
                  
                  // Get display name - fallback to phone if no name
                  const displayName = conv.recipientName || conv.recipientPhone || 'Unknown';
                  const avatarInitial = conv.recipientName?.charAt(0).toUpperCase() || 
                                        (conv.recipientPhone?.startsWith('+') ? conv.recipientPhone.slice(1, 3) : '?');
                  
                  // Get message preview - handle empty content + campaign indicator
                  const isCampaignMessage = !!lastMsg?.campaignRecipientId;
                  const messagePreview = lastMsg?.content?.trim() || (lastMsg ? 'Message sent' : 'No messages');

                  return (
                    <div
                      key={conv.id}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-3 transition-all duration-150 text-left hover:bg-accent/50 group",
                        isSelected && !isSelectionMode && "bg-primary/10",
                        isChecked && isSelectionMode && "bg-primary/10"
                      )}
                    >
                      {isSelectionMode && (
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() => toggleConversationSelection(conv.id)}
                          className="flex-shrink-0"
                        />
                      )}
                      <button
                        onClick={() => isSelectionMode ? toggleConversationSelection(conv.id) : setSelectedConversation(conv.id)}
                        className="flex-1 flex items-center gap-3 text-left"
                      >
                        <div className="relative flex-shrink-0">
                          <Avatar className="h-12 w-12">
                            {conv.recipientAvatar && (
                              <AvatarImage src={conv.recipientAvatar} alt={conv.recipientName || 'Contact'} />
                            )}
                            <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground font-medium text-lg">
                              {avatarInitial}
                            </AvatarFallback>
                          </Avatar>
                          {conv.isActive && (
                            <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-[#31A24C] rounded-full ring-2 ring-card" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="flex flex-col min-w-0">
                              <div className="flex items-center gap-2 truncate">
                                <span className={cn(
                                  "font-medium truncate",
                                  conv.unreadCount > 0 ? "text-foreground" : "text-foreground"
                                )}>
                                  {displayName}
                                </span>
                                {conv.blockedByRecipient && (
                                  <Badge variant="destructive" className="h-4 px-1.5 text-[10px] flex items-center gap-0.5">
                                    <Ban className="w-2.5 h-2.5" />
                                    Blocked
                                  </Badge>
                                )}
                              </div>
                              {/* Always show phone number if different from name */}
                              {conv.recipientPhone && conv.recipientPhone !== conv.recipientName && (
                                <span className="text-xs text-muted-foreground truncate">
                                  {conv.recipientPhone}
                                </span>
                              )}
                            </div>
                            <span className={cn(
                              "text-xs flex-shrink-0 ml-2",
                              conv.unreadCount > 0 ? "text-primary font-medium" : "text-muted-foreground"
                            )}>
                              {formatMessageDate(conv.updatedAt)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <p className={cn(
                              "text-sm truncate max-w-[180px] flex items-center gap-1",
                              conv.unreadCount > 0 ? "text-foreground" : "text-muted-foreground"
                            )}>
                              {isUserTyping ? (
                                <span className="text-primary italic">typing...</span>
                              ) : (
                                <>
                                  {lastMsg?.direction === 'outgoing' && (
                                    <span className="flex-shrink-0">{getMessageStatus(lastMsg.status)}</span>
                                  )}
                                  {isCampaignMessage && (
                                    <span className="text-[10px] px-1 py-0.5 bg-primary/20 text-primary rounded mr-1 flex-shrink-0">Campaign</span>
                                  )}
                                  <span className="truncate">{messagePreview}</span>
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
                      {!isSelectionMode && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openSingleDeleteDialog(conv.id)} className="text-destructive">
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete Chat
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openSingleBlockDialog(conv.id)} className="text-destructive">
                              <Ban className="w-4 h-4 mr-2" />
                              Block Contact
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
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
                    {selectedConv.recipientAvatar && (
                      <AvatarImage src={selectedConv.recipientAvatar} alt={selectedConv.recipientName || 'Contact'} />
                    )}
                    <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary/40 text-primary-foreground font-medium">
                      {selectedConv.recipientName?.charAt(0).toUpperCase() || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-foreground leading-tight">
                        {selectedConv.recipientName || selectedConv.recipientPhone}
                      </h3>
                      {selectedConvIsLive && (
                        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                          </span>
                          <span className="text-[10px] font-medium text-green-600 dark:text-green-400">Live</span>
                        </div>
                      )}
                    </div>
                    {/* Show phone number in chat header */}
                    {selectedConv.recipientPhone && selectedConv.recipientPhone !== selectedConv.recipientName && (
                      <span className="text-xs text-muted-foreground">{selectedConv.recipientPhone}</span>
                    )}
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
                                    {/* Campaign indicator */}
                                    {msg.campaignRecipientId && isOutgoing && (
                                      <span className="text-[9px] px-1 py-0.5 bg-primary-foreground/20 rounded mr-1">
                                        Campaign
                                      </span>
                                    )}
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
