import React, { useState, useRef, useEffect, useMemo } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  Square,
  Reply,
  MessageCircle,
  MessageCircleOff
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/chat/LinkifiedText';
import { format, isToday, isYesterday, isSameDay, subDays } from 'date-fns';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

type TimeFilter = 'today' | '3d' | '5d';

interface BlockedContact {
  id: string;
  phone_number: string;
  name: string | null;
  reason: string | null;
  created_at: string;
  blocked_by_account_id: string | null;
}

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
  
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [isMessageSearchOpen, setIsMessageSearchOpen] = useState(false);
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
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('today');
  const [showRepliesOnly, setShowRepliesOnly] = useState(false);
  
  // Block list state
  const [isBlockListOpen, setIsBlockListOpen] = useState(false);
  const [blockedContacts, setBlockedContacts] = useState<BlockedContact[]>([]);
  const [isLoadingBlocked, setIsLoadingBlocked] = useState(false);

  const selectedConv = conversations.find(c => c.id === selectedConversation);

  // Precompute per-conversation message stats (single pass) to keep UI fast under realtime updates
  const messageStats = useMemo(() => {
    const stats = new Map<
      string,
      {
        firstTime: number;
        firstDir: 'incoming' | 'outgoing';
        lastTime: number;
        hasNonFailed: boolean;
        hasRecentIncoming: boolean;
      }
    >();

    const now = Date.now();
    for (const m of messages) {
      const convId = m.conversationId;
      const t = new Date(m.timestamp).getTime();
      const existing = stats.get(convId);

      if (!existing) {
        stats.set(convId, {
          firstTime: t,
          firstDir: m.direction,
          lastTime: t,
          hasNonFailed: m.status !== 'failed',
          hasRecentIncoming: m.direction === 'incoming' && now - t < 5 * 60 * 1000,
        });
        continue;
      }

      if (t < existing.firstTime) {
        existing.firstTime = t;
        existing.firstDir = m.direction;
      }
      if (t > existing.lastTime) existing.lastTime = t;
      if (m.status !== 'failed') existing.hasNonFailed = true;
      if (m.direction === 'incoming' && now - t < 5 * 60 * 1000) existing.hasRecentIncoming = true;
    }

    return stats;
  }, [messages]);

  // Messages for selected conversation (memoized)
  const conversationMessages = useMemo(() => {
    if (!selectedConv) return [] as typeof messages;

    let filtered = messages
      .filter(m => m.conversationId === selectedConv.id && m.status !== 'failed')
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    // Apply message search filter
    if (messageSearchQuery) {
      filtered = filtered.filter(m => 
        m.content.toLowerCase().includes(messageSearchQuery.toLowerCase())
      );
    }
    
    return filtered;
  }, [messages, selectedConv?.id, messageSearchQuery]);

  // Get cutoff date for a specific filter
  const getCutoffForFilter = (filter: TimeFilter) => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    
    switch (filter) {
      case 'today': {
        return startOfToday;
      }
      case '3d': {
        const threeDaysAgo = new Date(startOfToday);
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 2);
        return threeDaysAgo;
      }
      case '5d': {
        const fiveDaysAgo = new Date(startOfToday);
        fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 4);
        return fiveDaysAgo;
      }
      default: {
        return startOfToday;
      }
    }
  };

  // Filter conversations by time - based on last message activity (not creation time)
  const getTimeFilterCutoff = () => getCutoffForFilter(timeFilter);

  // Helper to get conversation last message time for filtering
  const getConversationActivityTime = (conv: typeof conversations[0]) => {
    // Use lastMessageAt for activity-based filtering
    if (conv.lastMessageAt) return new Date(conv.lastMessageAt).getTime();
    return new Date(conv.createdAt).getTime();
  };

  // Helper to check if conversation should be shown:
  // Only show conversations where WE sent the first message (campaign initiated)
  const shouldShowConversation = (conv: typeof conversations[0]) => {
    // STRICT: Only show if first_message_sent is explicitly TRUE
    if (conv.firstMessageSent === true) return true;

    const stats = messageStats.get(conv.id);
    if (!stats) return false;

    // Only show if WE sent the first message (outgoing)
    return stats.firstDir === 'outgoing';
  };

  // Helper to check if conversation has any successful (non-failed) messages
  const hasSuccessfulMessages = (conv: typeof conversations[0]) => {
    // If we don't have messages in context, still show the conversation
    const stats = messageStats.get(conv.id);
    if (!stats) return true; // Assume success if no messages loaded yet
    return stats.hasNonFailed;
  };

  // Helper to get latest message timestamp for a conversation
  const getLastMessageTime = (conv: typeof conversations[0]) => {
    // Use lastMessageAt from the conversation if available (more reliable)
    if (conv.lastMessageAt) return new Date(conv.lastMessageAt).getTime();

    const stats = messageStats.get(conv.id);
    if (stats) return stats.lastTime;

    return new Date(conv.updatedAt).getTime();
  };

  const filteredConversations = conversations
    .filter(c => {
      const cutoff = getTimeFilterCutoff();
      const convActivityTime = getConversationActivityTime(c);
      const matchesTime = convActivityTime >= cutoff.getTime();
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = !searchQuery || 
        c.recipientName?.toLowerCase().includes(searchLower) ||
        c.recipientPhone?.toLowerCase().includes(searchLower) ||
        c.recipientUsername?.toLowerCase().includes(searchLower);
      // Exclude SpamBot conversations
      const isNotSpamBot = 
        c.recipientPhone !== '@SpamBot' && 
        c.recipientName?.toLowerCase() !== 'spam info bot';
      // Show if campaign initiated OR has incoming messages
      const showConv = shouldShowConversation(c);
      // Hide conversations that only have failed messages
      const hasSuccess = hasSuccessfulMessages(c);
      // Hide locally blocked contacts
      const isBlocked = blockedContacts.some(b => b.phone_number === c.recipientPhone);
      // Filter by replies if enabled
      const matchesReplyFilter = !showRepliesOnly || c.hasReply === true;

      return matchesTime && matchesSearch && isNotSpamBot && showConv && hasSuccess && !isBlocked && matchesReplyFilter;
    })
    // Sort by actual last message time, not updatedAt
    .sort((a, b) => getLastMessageTime(b) - getLastMessageTime(a));

  // Pre-calculate counts for each time filter and replies (for display in filter buttons)
  const filterCounts = useMemo(() => {
    const baseFilter = (c: typeof conversations[0]) => {
      const isNotSpamBot = c.recipientPhone !== '@SpamBot' && c.recipientName?.toLowerCase() !== 'spam info bot';
      const showConv = shouldShowConversation(c);
      const hasSuccess = hasSuccessfulMessages(c);
      const isBlocked = blockedContacts.some(b => b.phone_number === c.recipientPhone);
      return isNotSpamBot && showConv && hasSuccess && !isBlocked;
    };

    const countForFilter = (filter: TimeFilter, repliesOnly: boolean) => {
      const cutoff = getCutoffForFilter(filter);
      return conversations.filter(c => {
        if (!baseFilter(c)) return false;
        const convActivityTime = getConversationActivityTime(c);
        if (convActivityTime < cutoff.getTime()) return false;
        if (repliesOnly && c.hasReply !== true) return false;
        return true;
      }).length;
    };

    return {
      today: countForFilter('today', false),
      '3d': countForFilter('3d', false),
      '5d': countForFilter('5d', false),
      todayReplies: countForFilter('today', true),
      '3dReplies': countForFilter('3d', true),
      '5dReplies': countForFilter('5d', true),
      currentReplies: countForFilter(timeFilter, true),
    };
  }, [conversations, blockedContacts, messageStats, timeFilter]);

  const isTyping = selectedConv ? typingUsers[selectedConv.recipientPhone] : false;

  // Check if conversation is "live" (has recent incoming messages within 5 minutes)
  const isLiveConversation = (conv: typeof selectedConv) => {
    if (!conv) return false;
    const stats = messageStats.get(conv.id);
    return Boolean(stats?.hasRecentIncoming);
  };

  const selectedConvIsLive = isLiveConversation(selectedConv);

  const lastMessageId = conversationMessages[conversationMessages.length - 1]?.id;
  useEffect(() => {
    // Scroll only when a new message is appended (not on status-only updates)
    if (!lastMessageId && !isTyping) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lastMessageId, isTyping]);

  // Auto-select first filtered conversation or reset if selected is invalid
  useEffect(() => {
    // If nothing is selected and we have conversations, select the first one
    if (selectedConversation === null && filteredConversations.length > 0) {
      setSelectedConversation(filteredConversations[0].id);
    }
    // If current selection is not in filtered list, reset to first valid or null
    if (selectedConversation && !filteredConversations.some(c => c.id === selectedConversation)) {
      setSelectedConversation(filteredConversations[0]?.id || null);
    }
  }, [filteredConversations, selectedConversation]);

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

  // Fetch blocked contacts
  const fetchBlockedContacts = async () => {
    setIsLoadingBlocked(true);
    try {
      const { data, error } = await supabase
        .from('blocked_contacts')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setBlockedContacts(data || []);
    } catch (error) {
      console.error('Error fetching blocked contacts:', error);
      toast.error('Failed to load blocked contacts');
    } finally {
      setIsLoadingBlocked(false);
    }
  };

  // Keep block list in sync so blocked chats are hidden from sidebar
  useEffect(() => {
    fetchBlockedContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUnblockContact = async (id: string) => {
    try {
      const blockedContact = blockedContacts.find(c => c.id === id);

      // Remove from blocked_contacts table
      const { error } = await supabase
        .from('blocked_contacts')
        .delete()
        .eq('id', id);
      
      if (error) throw error;

      await fetchBlockedContacts();

      // After unblock: open existing conversation if we still have it, otherwise prefill "New chat"
      const existing = blockedContact
        ? conversations.find(c => c.recipientPhone === blockedContact.phone_number)
        : undefined;

      if (existing) {
        setSelectedConversation(existing.id);
      } else if (blockedContact) {
        setNewChatPhone(blockedContact.phone_number);
        setNewChatName(blockedContact.name || '');
        setIsNewChatOpen(true);
      }
      
      toast.success('Contact unblocked');
    } catch (error) {
      console.error('Error unblocking:', error);
      toast.error('Failed to unblock contact');
    }
  };

  // Refresh blocked list when dialog opens
  useEffect(() => {
    if (isBlockListOpen) {
      fetchBlockedContacts();
    }
  }, [isBlockListOpen]);

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
              This will hide {singleActionConvId ? 'this contact' : `${selectedConversations.size} selected contacts`} from your chat list.
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

      {/* Block List Dialog */}
      <Dialog open={isBlockListOpen} onOpenChange={setIsBlockListOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="w-5 h-5" />
              Blocked Contacts
            </DialogTitle>
            <DialogDescription>
              Manage your blocked contacts. Unblock to allow messages again.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[400px]">
            {isLoadingBlocked ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : blockedContacts.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Ban className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No blocked contacts</p>
              </div>
            ) : (
              <div className="space-y-2">
                {blockedContacts.map(contact => (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{contact.phone_number}</p>
                      {contact.name && (
                        <p className="text-sm text-muted-foreground">{contact.name}</p>
                      )}
                      {contact.reason && (
                        <p className="text-xs text-muted-foreground mt-1">{contact.reason}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        Blocked {format(new Date(contact.created_at), 'MMM d, yyyy')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUnblockContact(contact.id)}
                    >
                      Unblock
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <div className="h-[calc(100vh-48px)] -m-6 flex overflow-hidden border border-border bg-card shadow-lg">
        {/* Sidebar - Conversation List */}
        <div className="w-[340px] min-w-[320px] flex-shrink-0 border-r border-border flex flex-col bg-card">
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
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold text-foreground">Chats</h2>
                    <div className="flex items-center gap-2">
                      {filteredConversations.filter(c => (c.unreadCount || 0) > 0).length > 0 && (
                        <Badge className="h-5 px-2 flex items-center justify-center text-[10px] font-medium bg-primary text-primary-foreground rounded-full">
                          {filteredConversations.filter(c => (c.unreadCount || 0) > 0).length} new
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {conversations.length.toLocaleString()} contacts
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7 text-muted-foreground hover:text-foreground" 
                      onClick={() => setIsBlockListOpen(true)} 
                      title="Blocked contacts"
                    >
                      <Ban className="w-4 h-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7 text-muted-foreground hover:text-foreground" 
                      onClick={() => setIsSelectionMode(true)} 
                      title="Select chats"
                    >
                      <CheckSquare className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                
                {/* Time Period Filters */}
                <div className="flex gap-1 mb-2 p-1 bg-muted/50 rounded-lg">
                  {(['today', '3d', '5d'] as TimeFilter[]).map((filter) => {
                    const isActive = timeFilter === filter;
                    const label = filter === 'today' ? 'Today' : filter === '3d' ? '3 Days' : '5 Days';
                    const count = filterCounts[filter];
                    return (
                      <button
                        key={filter}
                        onClick={() => setTimeFilter(filter)}
                        className={cn(
                          "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors",
                          isActive 
                            ? "bg-background text-foreground shadow-sm border border-border/50" 
                            : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                        )}
                      >
                        <span className="block">{label}</span>
                        <span className={cn(
                          "text-[10px] tabular-nums",
                          isActive ? "text-primary" : "text-muted-foreground/70"
                        )}>{count.toLocaleString()}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Reply Filter Toggle */}
                <div className="flex gap-1 mb-3 p-1 bg-muted/50 rounded-lg">
                  <button
                    onClick={() => setShowRepliesOnly(false)}
                    className={cn(
                      "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors",
                      !showRepliesOnly 
                        ? "bg-background text-foreground shadow-sm border border-border/50" 
                        : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                    )}
                  >
                    <span className="block">All Chats</span>
                    <span className="text-[10px] text-muted-foreground/70 tabular-nums">{filteredConversations.length.toLocaleString()}</span>
                  </button>
                  <button
                    onClick={() => setShowRepliesOnly(true)}
                    className={cn(
                      "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex flex-col items-center",
                      showRepliesOnly 
                        ? "bg-green-500/15 text-green-600 dark:text-green-400 shadow-sm border border-green-500/30" 
                        : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                    )}
                  >
                    <span className="flex items-center gap-1">
                      <MessageCircle className="w-3 h-3" />
                      Replied
                    </span>
                    <span className={cn(
                      "text-[10px] tabular-nums",
                      showRepliesOnly ? "text-green-600/80 dark:text-green-400/80" : "text-muted-foreground/70"
                    )}>{filterCounts.currentReplies.toLocaleString()}</span>
                  </button>
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

          {/* Conversation List - Optimized */}
          <ScrollArea className="flex-1">
            <div className="divide-y divide-border/30">
              {filteredConversations.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <MessageSquare className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-muted-foreground text-sm font-medium">No conversations</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Run a campaign to start chatting
                  </p>
                </div>
              ) : (
                filteredConversations.slice(0, 200).map((conv) => {
                  // Use memoized stats instead of filtering messages each render
                  const stats = messageStats.get(conv.id);
                  const isSelected = selectedConversation === conv.id;
                  const isUserTyping = typingUsers[conv.recipientPhone];
                  const isChecked = selectedConversations.has(conv.id);
                  
                  const displayName = conv.recipientPhone || 'Unknown';
                  const avatarInitial = conv.recipientPhone?.startsWith('+') ? conv.recipientPhone.slice(1, 3) : '?';
                  
                  // Use conversation's cached last message for performance
                  const messagePreview = conv.lastMessageContent?.trim() || 'Message sent';
                  const isCampaignMessage = conv.firstMessageSent === true;

                  return (
                    <div
                      key={conv.id}
                      className={cn(
                        "flex items-center gap-3 px-4 py-2.5 transition-colors cursor-pointer group",
                        isSelected && !isSelectionMode && "bg-primary/10 border-l-2 border-l-primary",
                        isChecked && isSelectionMode && "bg-primary/10",
                        !isSelected && "hover:bg-muted/50"
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
                        onClick={() => {
                          if (isSelectionMode) {
                            toggleConversationSelection(conv.id);
                          } else {
                            setSelectedConversation(conv.id);
                            setMessageSearchQuery('');
                            setIsMessageSearchOpen(false);
                          }
                        }}
                        className="flex-1 flex items-center gap-2.5 text-left min-w-0"
                      >
                        <div className="relative flex-shrink-0">
                          <Avatar className="h-10 w-10">
                            {conv.recipientAvatar && (
                              <AvatarImage src={conv.recipientAvatar} alt={conv.recipientName || 'Contact'} />
                            )}
                            <AvatarFallback className="bg-gradient-to-br from-primary/70 to-primary/40 text-primary-foreground font-medium text-xs">
                              {avatarInitial}
                            </AvatarFallback>
                          </Avatar>
                          {conv.isActive && (
                            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full ring-2 ring-background" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={cn(
                              "font-medium truncate text-sm",
                              conv.unreadCount > 0 ? "text-foreground" : "text-foreground/80"
                            )}>
                              {displayName}
                            </span>
                            <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
                              {formatMessageDate(conv.updatedAt)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-0.5">
                            <p className={cn(
                              "text-xs truncate flex items-center gap-1",
                              conv.unreadCount > 0 ? "text-foreground" : "text-muted-foreground"
                            )}>
                              {isUserTyping ? (
                                <span className="text-primary italic">typing...</span>
                              ) : (
                                <>
                                  {isCampaignMessage && (
                                    <span className="text-[9px] px-1 py-0.5 bg-primary/10 text-primary rounded flex-shrink-0">Camp</span>
                                  )}
                                  <span className="truncate">{messagePreview}</span>
                                </>
                              )}
                            </p>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {conv.hasReply && (
                                <MessageCircle className="w-3 h-3 text-green-500" />
                              )}
                              {conv.unreadCount > 0 && (
                                <Badge className="h-4 min-w-4 px-1 flex items-center justify-center text-[9px] font-bold bg-primary rounded-full">
                                  {conv.unreadCount}
                                </Badge>
                              )}
                            </div>
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
              {filteredConversations.length > 200 && (
                <div className="px-4 py-3 text-center text-xs text-muted-foreground bg-muted/30">
                  Showing first 200 of {filteredConversations.length.toLocaleString()} conversations
                </div>
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
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className={cn(
                      "text-muted-foreground hover:text-foreground",
                      isMessageSearchOpen && "bg-primary/10 text-primary"
                    )}
                    onClick={() => {
                      setIsMessageSearchOpen(!isMessageSearchOpen);
                      if (isMessageSearchOpen) setMessageSearchQuery('');
                    }}
                  >
                    <Search className="w-5 h-5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                    <MoreVertical className="w-5 h-5" />
                  </Button>
                </div>
              </div>

              {/* Message Search Bar */}
              {isMessageSearchOpen && (
                <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center gap-2">
                  <Search className="w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search in messages..."
                    value={messageSearchQuery}
                    onChange={(e) => setMessageSearchQuery(e.target.value)}
                    className="flex-1 h-8 bg-transparent border-0 focus-visible:ring-0 text-sm"
                    autoFocus
                  />
                  {messageSearchQuery && (
                    <span className="text-xs text-muted-foreground">
                      {conversationMessages.length} result{conversationMessages.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-6 w-6"
                    onClick={() => {
                      setIsMessageSearchOpen(false);
                      setMessageSearchQuery('');
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              )}

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
                                    <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                                      <LinkifiedText text={msg.content} />
                                    </p>
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
                    <Textarea
                      placeholder={selectedImage ? "Add a caption..." : "Type a message"}
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      className="rounded-2xl bg-secondary/50 border-0 focus-visible:ring-1 focus-visible:ring-primary min-h-[40px] max-h-[140px] px-4 py-2 leading-6 resize-none"
                      rows={1}
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
