import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmojiPicker } from '@/components/ui/emoji-picker';
import { 
  Send, MessageSquare, Users, Eye, CheckCheck, Check, 
  RefreshCw, AlertCircle, Clock, Search, EyeOff, MoreVertical,
  Image, X, Loader2, Phone, Smile, Paperclip, Mic, BarChart3, Settings
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { format, isToday, isYesterday, subDays, differenceInMinutes } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type TimeFilter = '24h' | '3d' | '5d' | '7d';
type SeatView = 'chats' | 'reports';

interface Seat {
  id: string;
  name: string;
  is_active: boolean;
}

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
}

interface Message {
  id: string;
  content: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' | 'sending';
  created_at: string;
  media_url: string | null;
  media_type: string | null;
}

interface SeatStats {
  total_conversations: number;
  messages_sent_today: number;
  messages_read: number;
  responses_received: number;
}

// Generate consistent colors for avatars based on phone number
const getAvatarColor = (phone: string | null) => {
  const colors = [
    'from-rose-400 to-rose-600',
    'from-orange-400 to-orange-600',
    'from-amber-400 to-amber-600',
    'from-emerald-400 to-emerald-600',
    'from-teal-400 to-teal-600',
    'from-cyan-400 to-cyan-600',
    'from-blue-400 to-blue-600',
    'from-indigo-400 to-indigo-600',
    'from-violet-400 to-violet-600',
    'from-purple-400 to-purple-600',
    'from-fuchsia-400 to-fuchsia-600',
    'from-pink-400 to-pink-600',
  ];
  if (!phone) return colors[0];
  const hash = phone.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
};

const SeatChat: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [seat, setSeat] = useState<Seat | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [isMessageSearchOpen, setIsMessageSearchOpen] = useState(false);
  const [hiddenConversations, setHiddenConversations] = useState<Set<string>>(new Set());
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('7d');
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<SeatView>('chats');
  const [stats, setStats] = useState<SeatStats>({
    total_conversations: 0,
    messages_sent_today: 0,
    messages_read: 0,
    responses_received: 0
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load hidden conversations from localStorage
  useEffect(() => {
    const savedHidden = localStorage.getItem(`hidden-conversations-${token}`);
    if (savedHidden) {
      setHiddenConversations(new Set(JSON.parse(savedHidden)));
    }
  }, [token]);

  // Save hidden conversations to localStorage
  const toggleHideConversation = (convId: string) => {
    setHiddenConversations(prev => {
      const newSet = new Set(prev);
      if (newSet.has(convId)) {
        newSet.delete(convId);
        toast.success('Conversation unhidden');
      } else {
        newSet.add(convId);
        toast.success('Conversation hidden');
        if (selectedConversation?.id === convId) {
          setSelectedConversation(null);
        }
      }
      localStorage.setItem(`hidden-conversations-${token}`, JSON.stringify([...newSet]));
      return newSet;
    });
  };

  // Time filter cutoff
  const getTimeFilterCutoff = () => {
    const now = new Date();
    switch (timeFilter) {
      case '24h': return subDays(now, 1);
      case '3d': return subDays(now, 3);
      case '5d': return subDays(now, 5);
      case '7d': return subDays(now, 7);
      default: return subDays(now, 7);
    }
  };

  // Deduplicate conversations by phone number - keep the most recent one
  const deduplicateConversations = (convs: Conversation[]) => {
    const phoneMap = new Map<string, Conversation>();
    
    const sorted = [...convs].sort((a, b) => {
      const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return timeB - timeA;
    });
    
    sorted.forEach(conv => {
      const phone = conv.recipient_phone || conv.id;
      if (!phoneMap.has(phone)) {
        phoneMap.set(phone, conv);
      }
    });
    
    return Array.from(phoneMap.values());
  };

  // Filter conversations
  const filteredConversations = deduplicateConversations(
    conversations.filter(conv => {
      if (hiddenConversations.has(conv.id)) return false;
      
      const cutoff = getTimeFilterCutoff();
      const lastMsgTime = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0;
      if (lastMsgTime < cutoff.getTime()) return false;
      
      if (!searchQuery) return true;
      const searchLower = searchQuery.toLowerCase();
      return (
        conv.recipient_name?.toLowerCase().includes(searchLower) ||
        conv.recipient_phone?.toLowerCase().includes(searchLower) ||
        conv.recipient_username?.toLowerCase().includes(searchLower)
      );
    })
  );

  // Filter messages by search
  const filteredMessages = messageSearchQuery
    ? messages.filter(msg => msg.content.toLowerCase().includes(messageSearchQuery.toLowerCase()))
    : messages;

  // Validate seat token
  useEffect(() => {
    const validateSeat = async () => {
      if (!token) {
        setError('Invalid seat link');
        setIsLoading(false);
        return;
      }

      try {
        const { data, error: seatError } = await supabase
          .from('seats')
          .select('id, name, is_active')
          .eq('access_token', token)
          .maybeSingle();

        if (seatError) throw seatError;
        
        if (!data) {
          setError('Seat not found');
          setIsLoading(false);
          return;
        }

        if (!data.is_active) {
          setError('This seat has been deactivated');
          setIsLoading(false);
          return;
        }

        setSeat(data);
        setIsLoading(false);
      } catch (err) {
        console.error('Error validating seat:', err);
        setError('Failed to load seat');
        setIsLoading(false);
      }
    };

    validateSeat();
  }, [token]);

  // Fetch conversations for this seat
  const fetchConversations = useCallback(async () => {
    if (!seat) return;

    try {
      const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('seat_id', seat.id)
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (error) throw error;
      setConversations(data || []);
    } catch (err) {
      console.error('Error fetching conversations:', err);
    }
  }, [seat]);

  // Fetch stats for this seat
  const fetchStats = useCallback(async () => {
    if (!seat) return;

    try {
      const { data, error } = await supabase
        .from('seat_stats')
        .select('*')
        .eq('seat_id', seat.id)
        .maybeSingle();

      if (!error && data) {
        setStats({
          total_conversations: data.total_conversations || 0,
          messages_sent_today: data.messages_sent_today || 0,
          messages_read: data.messages_read || 0,
          responses_received: data.responses_received || 0
        });
      }
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }, [seat]);

  // Fetch messages for selected conversation
  const fetchMessages = useCallback(async () => {
    if (!selectedConversation) return;

    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, content, direction, status, created_at, media_url, media_type')
        .eq('conversation_id', selectedConversation.id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setMessages(data || []);
      
      // Mark as read
      if (selectedConversation.unread_count > 0) {
        await supabase
          .from('conversations')
          .update({ unread_count: 0 })
          .eq('id', selectedConversation.id);
        
        await supabase
          .from('messages')
          .update({ read_at: new Date().toISOString() })
          .eq('conversation_id', selectedConversation.id)
          .eq('direction', 'incoming')
          .is('read_at', null);
      }
    } catch (err) {
      console.error('Error fetching messages:', err);
    }
  }, [selectedConversation]);

  useEffect(() => {
    if (seat) {
      fetchConversations();
      fetchStats();
    }
  }, [seat, fetchConversations, fetchStats]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Real-time subscriptions
  useEffect(() => {
    if (!seat) return;

    const channel = supabase
      .channel('seat-messages')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        () => {
          fetchMessages();
          fetchConversations();
          fetchStats();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        () => {
          fetchConversations();
          fetchStats();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [seat, fetchMessages, fetchConversations, fetchStats]);

  // Refresh every 10 seconds
  useEffect(() => {
    if (!seat) return;
    const interval = setInterval(() => {
      fetchConversations();
      fetchStats();
    }, 10000);
    return () => clearInterval(interval);
  }, [seat, fetchConversations, fetchStats]);

  const handleSendMessage = async () => {
    if ((!messageInput.trim() && !selectedImage) || !selectedConversation || isSending) return;

    setIsSending(true);
    try {
      const { error } = await supabase
        .from('messages')
        .insert({
          conversation_id: selectedConversation.id,
          account_id: selectedConversation.account_id,
          content: messageInput.trim() || '📷 Image',
          direction: 'outgoing',
          status: 'pending',
          priority: 10
        });

      if (error) throw error;
      
      setMessageInput('');
      clearSelectedImage();
      fetchMessages();
    } catch (err) {
      console.error('Error sending message:', err);
      toast.error('Failed to send message');
    } finally {
      setIsSending(false);
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

  const clearSelectedImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleEmojiSelect = (emoji: string) => {
    setMessageInput(prev => prev + emoji);
  };

  const formatMessageTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return format(date, 'HH:mm');
  };

  const formatConversationTime = (dateStr: string | null) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isToday(date)) return format(date, 'HH:mm');
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'dd/MM/yy');
  };

  const formatDateSeparator = (dateStr: string) => {
    const date = new Date(dateStr);
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMMM d, yyyy');
  };

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

  // Get display name - only phone number
  const getDisplayName = (conv: Conversation) => {
    return conv.recipient_phone || 'Unknown';
  };

  // Get avatar initials from phone number
  const getAvatarInitial = (conv: Conversation) => {
    if (conv.recipient_phone) {
      const digits = conv.recipient_phone.replace(/\D/g, '');
      return digits.slice(-2) || '??';
    }
    return '??';
  };

  // Group messages by date
  const groupMessagesByDate = (msgs: Message[]) => {
    const groups: { date: string; messages: Message[] }[] = [];
    let currentDate = '';
    
    msgs.forEach(msg => {
      const msgDate = format(new Date(msg.created_at), 'yyyy-MM-dd');
      if (msgDate !== currentDate) {
        currentDate = msgDate;
        groups.push({ date: msg.created_at, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    });
    
    return groups;
  };

  // Get last message preview
  const getLastMessagePreview = (conv: Conversation) => {
    const msg = messages.find(m => m.id); // Just a placeholder, we'd need to store last message
    return 'Tap to view messages';
  };

  if (isLoading) {
    return (
      <div className="h-screen bg-[#111b21] flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-[#00a884] flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Send className="w-8 h-8 text-white" />
          </div>
          <p className="text-[#8696a0] font-medium">Loading workspace...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen bg-[#111b21] flex items-center justify-center p-4">
        <Card className="max-w-md w-full bg-[#202c33] border-0 shadow-2xl">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-xl font-bold mb-2 text-white">Access Error</h2>
            <p className="text-[#8696a0]">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const messageGroups = groupMessagesByDate(filteredMessages);

  return (
    <div className="h-screen flex bg-[#111b21] overflow-hidden">
      {/* Left Sidebar Navigation */}
      <div className="w-16 bg-[#202c33] border-r border-[#2a3942] flex flex-col items-center py-4 flex-shrink-0">
        {/* Logo */}
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#00a884] to-[#25d366] flex items-center justify-center mb-6 shadow-lg">
          <Send className="w-5 h-5 text-white" />
        </div>
        
        {/* Navigation Items */}
        <div className="flex flex-col gap-2 flex-1">
          <button
            onClick={() => setCurrentView('chats')}
            className={cn(
              "w-12 h-12 rounded-xl flex items-center justify-center transition-all",
              currentView === 'chats'
                ? "bg-[#00a884] text-white"
                : "text-[#8696a0] hover:bg-[#2a3942] hover:text-white"
            )}
            title="Chats"
          >
            <MessageSquare className="w-5 h-5" />
          </button>
          
          <button
            onClick={() => setCurrentView('reports')}
            className={cn(
              "w-12 h-12 rounded-xl flex items-center justify-center transition-all",
              currentView === 'reports'
                ? "bg-[#00a884] text-white"
                : "text-[#8696a0] hover:bg-[#2a3942] hover:text-white"
            )}
            title="Reports"
          >
            <BarChart3 className="w-5 h-5" />
          </button>
        </div>
        
        {/* Bottom - Status */}
        <div className="mt-auto">
          <div className="w-3 h-3 rounded-full bg-[#00a884] ring-2 ring-[#202c33]" title="Online" />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Message Search Dialog */}
        <Dialog open={isMessageSearchOpen} onOpenChange={setIsMessageSearchOpen}>
          <DialogContent className="max-w-md bg-[#202c33] border-[#2a3942] text-white">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white">
                <Search className="w-5 h-5" />
                Search Messages
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                placeholder="Type to search messages..."
                value={messageSearchQuery}
                onChange={(e) => setMessageSearchQuery(e.target.value)}
                className="bg-[#2a3942] border-0 text-white placeholder:text-[#8696a0] focus:ring-[#00a884]"
                autoFocus
              />
              {messageSearchQuery && (
                <div className="text-sm text-[#8696a0]">
                  Found {filteredMessages.length} message{filteredMessages.length !== 1 ? 's' : ''} matching "{messageSearchQuery}"
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Header */}
        <header className="bg-[#202c33] border-b border-[#2a3942] flex-shrink-0 px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="font-semibold text-white text-base">{seat?.name}</h1>
                <p className="text-xs text-[#8696a0]">
                  {currentView === 'chats' ? 'Telegram Chats' : 'Reports & Statistics'}
                </p>
              </div>
            </div>
            
            {/* Stats - shown only in chats view */}
            {currentView === 'chats' && (
              <div className="hidden md:flex items-center gap-4">
                <div className="flex items-center gap-1.5 text-xs bg-[#2a3942] rounded-full px-3 py-1.5">
                  <MessageSquare className="w-3.5 h-3.5 text-[#00a884]" />
                  <span className="font-medium text-white">{stats.total_conversations}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs bg-[#2a3942] rounded-full px-3 py-1.5">
                  <Send className="w-3.5 h-3.5 text-[#00a884]" />
                  <span className="font-medium text-white">{stats.messages_sent_today}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs bg-[#2a3942] rounded-full px-3 py-1.5">
                  <Eye className="w-3.5 h-3.5 text-[#00a884]" />
                  <span className="font-medium text-white">{stats.messages_read}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs bg-[#2a3942] rounded-full px-3 py-1.5">
                  <Users className="w-3.5 h-3.5 text-[#00a884]" />
                  <span className="font-medium text-white">{stats.responses_received}</span>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Badge className="bg-[#00a884] text-white border-0 text-xs px-2 py-0.5">
                ● Online
              </Badge>
            </div>
          </div>
        </header>

        {/* View Content */}
        {currentView === 'chats' ? (
          /* Chats View */
          <div className="flex-1 flex overflow-hidden">
        {/* Conversation Sidebar */}
        <div className="w-[340px] lg:w-[420px] bg-[#111b21] border-r border-[#2a3942] flex flex-col flex-shrink-0">
          {/* Search & Filter */}
          <div className="p-2 bg-[#111b21]">
            {/* Time Filters */}
            <div className="flex gap-1 mb-2">
              {(['24h', '3d', '5d', '7d'] as TimeFilter[]).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setTimeFilter(filter)}
                  className={cn(
                    "flex-1 px-2 py-1.5 text-xs font-medium rounded-lg transition-all",
                    timeFilter === filter 
                      ? "bg-[#00a884] text-white" 
                      : "text-[#8696a0] hover:bg-[#2a3942]"
                  )}
                >
                  {filter}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8696a0]" />
              <Input
                placeholder="Search or start new chat"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 bg-[#202c33] border-0 text-white placeholder:text-[#8696a0] focus:ring-0 h-9 rounded-lg"
              />
            </div>
          </div>

          {/* Conversation List */}
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.length === 0 ? (
              <div className="p-8 text-center">
                <MessageSquare className="w-12 h-12 text-[#2a3942] mx-auto mb-3" />
                <p className="text-[#8696a0] font-medium text-sm">No conversations</p>
                <p className="text-xs text-[#667781] mt-1">
                  {searchQuery ? 'Try a different search' : 'Conversations will appear here'}
                </p>
              </div>
            ) : (
              <div>
                {filteredConversations.map((conv) => (
                  <div
                    key={conv.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-3 cursor-pointer transition-all group",
                      selectedConversation?.id === conv.id
                        ? "bg-[#2a3942]"
                        : "hover:bg-[#202c33]"
                    )}
                    onClick={() => setSelectedConversation(conv)}
                  >
                    {/* Avatar */}
                    <Avatar className="w-12 h-12 flex-shrink-0">
                      <AvatarImage src={conv.recipient_avatar || ''} />
                      <AvatarFallback className={cn(
                        "bg-gradient-to-br text-white text-sm font-medium",
                        getAvatarColor(conv.recipient_phone)
                      )}>
                        {getAvatarInitial(conv)}
                      </AvatarFallback>
                    </Avatar>
                    
                    <div className="flex-1 min-w-0 border-b border-[#2a3942] py-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-[15px] text-white truncate">
                          {getDisplayName(conv)}
                        </p>
                        <span className={cn(
                          "text-xs flex-shrink-0",
                          conv.unread_count > 0 ? "text-[#00a884]" : "text-[#667781]"
                        )}>
                          {formatConversationTime(conv.last_message_at)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <p className="text-sm text-[#8696a0] truncate">
                          Tap to view messages
                        </p>
                        {conv.unread_count > 0 && (
                          <span className="bg-[#00a884] text-white text-[11px] font-medium min-w-[20px] h-5 rounded-full flex items-center justify-center px-1.5 flex-shrink-0">
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
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-[#8696a0] hover:text-white hover:bg-transparent"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-[#233138] border-[#2a3942] text-white">
                        <DropdownMenuItem 
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleHideConversation(conv.id);
                          }}
                          className="text-[#d1d7db] hover:bg-[#2a3942] focus:bg-[#2a3942]"
                        >
                          <EyeOff className="w-4 h-4 mr-2" />
                          Hide conversation
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Message Area */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='400' height='400' viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23182229' fill-opacity='0.8'%3E%3Cpath d='M20 20h10v10H20zM50 50h10v10H50zM80 20h10v10H80zM110 50h10v10H110zM140 20h10v10H140zM170 50h10v10H170zM200 20h10v10H200zM230 50h10v10H230zM260 20h10v10H260zM290 50h10v10H290zM320 20h10v10H320zM350 50h10v10H350zM20 80h10v10H20zM50 110h10v10H50zM80 80h10v10H80zM110 110h10v10H110zM140 80h10v10H140zM170 110h10v10H170zM200 80h10v10H200zM230 110h10v10H230zM260 80h10v10H260zM290 110h10v10H290zM320 80h10v10H320zM350 110h10v10H350zM20 140h10v10H20zM50 170h10v10H50zM80 140h10v10H80zM110 170h10v10H110zM140 140h10v10H140zM170 170h10v10H170zM200 140h10v10H200zM230 170h10v10H230zM260 140h10v10H260zM290 170h10v10H290zM320 140h10v10H320zM350 170h10v10H350zM20 200h10v10H20zM50 230h10v10H50zM80 200h10v10H80zM110 230h10v10H110zM140 200h10v10H140zM170 230h10v10H170zM200 200h10v10H200zM230 230h10v10H230zM260 200h10v10H260zM290 230h10v10H290zM320 200h10v10H320zM350 230h10v10H350zM20 260h10v10H20zM50 290h10v10H50zM80 260h10v10H80zM110 290h10v10H110zM140 260h10v10H140zM170 290h10v10H170zM200 260h10v10H200zM230 290h10v10H230zM260 260h10v10H260zM290 290h10v10H290zM320 260h10v10H320zM350 290h10v10H350zM20 320h10v10H20zM50 350h10v10H50zM80 320h10v10H80zM110 350h10v10H110zM140 320h10v10H140zM170 350h10v10H170zM200 320h10v10H200zM230 350h10v10H230zM260 320h10v10H260zM290 350h10v10H290zM320 320h10v10H320zM350 350h10v10H350z'/%3E%3C/g%3E%3C/svg%3E")`,
          backgroundColor: '#0b141a'
        }}>
          {selectedConversation ? (
            <>
              {/* Chat Header */}
              <div className="bg-[#202c33] border-b border-[#2a3942] px-4 py-2 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <Avatar className="w-10 h-10">
                    <AvatarImage src={selectedConversation.recipient_avatar || ''} />
                    <AvatarFallback className={cn(
                      "bg-gradient-to-br text-white text-sm font-medium",
                      getAvatarColor(selectedConversation.recipient_phone)
                    )}>
                      {getAvatarInitial(selectedConversation)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-white text-[15px]">
                      {getDisplayName(selectedConversation)}
                    </p>
                    <p className="text-xs text-[#8696a0]">
                      {selectedConversation.is_active ? 'online' : 'last seen recently'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button 
                    variant="ghost" 
                    size="icon"
                    onClick={() => setIsMessageSearchOpen(true)}
                    className="text-[#8696a0] hover:text-white hover:bg-[#2a3942] h-10 w-10"
                  >
                    <Search className="w-5 h-5" />
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="icon"
                    className="text-[#8696a0] hover:text-white hover:bg-[#2a3942] h-10 w-10"
                  >
                    <Phone className="w-5 h-5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button 
                        variant="ghost" 
                        size="icon"
                        className="text-[#8696a0] hover:text-white hover:bg-[#2a3942] h-10 w-10"
                      >
                        <MoreVertical className="w-5 h-5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="bg-[#233138] border-[#2a3942] text-white">
                      <DropdownMenuItem 
                        onClick={() => toggleHideConversation(selectedConversation.id)}
                        className="text-[#d1d7db] hover:bg-[#2a3942] focus:bg-[#2a3942]"
                      >
                        <EyeOff className="w-4 h-4 mr-2" />
                        Hide conversation
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Messages Container */}
              <div 
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-[5%] lg:px-[10%] py-4"
              >
                <div className="max-w-4xl mx-auto space-y-1">
                  {messageGroups.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-20">
                      <div className="bg-[#182229] rounded-lg px-3 py-1.5 mb-4">
                        <p className="text-[#8696a0] text-xs">
                          {messageSearchQuery ? 'No messages match your search' : 'No messages yet'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    messageGroups.map((group, groupIndex) => (
                      <div key={groupIndex}>
                        {/* Date Separator */}
                        <div className="flex justify-center my-3">
                          <span className="bg-[#182229] text-[#8696a0] text-[11px] px-3 py-1 rounded-lg shadow">
                            {formatDateSeparator(group.date)}
                          </span>
                        </div>
                        
                        {/* Messages */}
                        {group.messages.map((msg, msgIndex) => (
                          <div
                            key={msg.id}
                            className={cn(
                              "flex mb-0.5",
                              msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'
                            )}
                          >
                            <div
                              className={cn(
                                "relative max-w-[65%] rounded-lg px-2.5 py-1.5 shadow-sm",
                                msg.direction === 'outgoing'
                                  ? 'bg-[#005c4b] text-white rounded-tr-none'
                                  : 'bg-[#202c33] text-[#e9edef] rounded-tl-none'
                              )}
                            >
                              {/* Message tail */}
                              <div className={cn(
                                "absolute top-0 w-2 h-3",
                                msg.direction === 'outgoing'
                                  ? '-right-2 border-l-8 border-l-[#005c4b] border-t-8 border-t-transparent'
                                  : '-left-2 border-r-8 border-r-[#202c33] border-t-8 border-t-transparent'
                              )} style={{
                                borderLeftColor: msg.direction === 'outgoing' ? '#005c4b' : 'transparent',
                                borderRightColor: msg.direction === 'incoming' ? '#202c33' : 'transparent',
                              }} />
                              
                              {msg.media_url && (
                                <img
                                  src={msg.media_url}
                                  alt="Media"
                                  className="max-w-full rounded-lg mb-1.5"
                                />
                              )}
                              <p className="text-[14.5px] leading-[19px] whitespace-pre-wrap break-words pr-12">
                                {msg.content}
                              </p>
                              <div className={cn(
                                "absolute bottom-1.5 right-2 flex items-center gap-1"
                              )}>
                                <span className="text-[11px] text-[#8696a0]">
                                  {formatMessageTime(msg.created_at)}
                                </span>
                                {msg.direction === 'outgoing' && getMessageStatusIcon(msg.status)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              {/* Image Preview */}
              {imagePreview && (
                <div className="bg-[#202c33] border-t border-[#2a3942] p-3 flex-shrink-0">
                  <div className="max-w-3xl mx-auto relative inline-block">
                    <img 
                      src={imagePreview} 
                      alt="Selected" 
                      className="max-h-24 rounded-lg"
                    />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-red-500 hover:bg-red-600"
                      onClick={clearSelectedImage}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Message Input */}
              <div className="bg-[#202c33] px-4 py-2 flex-shrink-0">
                <div className="flex items-center gap-2">
                  {/* Emoji */}
                  <EmojiPicker onEmojiSelect={handleEmojiSelect} className="flex-shrink-0" />
                  
                  {/* Attachment */}
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
                    onClick={() => fileInputRef.current?.click()}
                    className="text-[#8696a0] hover:text-white hover:bg-[#2a3942] h-10 w-10 flex-shrink-0"
                  >
                    <Paperclip className="w-5 h-5" />
                  </Button>

                  {/* Input */}
                  <Input
                    placeholder="Type a message"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                    disabled={isSending}
                    className="flex-1 bg-[#2a3942] border-0 text-white placeholder:text-[#8696a0] focus:ring-0 h-10 rounded-lg"
                  />

                  {/* Send / Mic Button */}
                  {messageInput.trim() || selectedImage ? (
                    <Button 
                      onClick={handleSendMessage} 
                      disabled={isSending}
                      className="bg-[#00a884] hover:bg-[#06cf9c] text-white h-10 w-10 rounded-full flex-shrink-0"
                      size="icon"
                    >
                      {isSending ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Send className="w-5 h-5" />
                      )}
                    </Button>
                  ) : (
                    <Button 
                      variant="ghost"
                      className="text-[#8696a0] hover:text-white hover:bg-[#2a3942] h-10 w-10 rounded-full flex-shrink-0"
                      size="icon"
                    >
                      <Mic className="w-5 h-5" />
                    </Button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-[280px] h-[280px] mx-auto mb-8 relative">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#00a884]/20 to-[#25d366]/20 rounded-full animate-pulse" />
                  <div className="absolute inset-8 bg-gradient-to-br from-[#00a884]/30 to-[#25d366]/30 rounded-full" />
                  <div className="absolute inset-16 bg-gradient-to-br from-[#00a884] to-[#25d366] rounded-full flex items-center justify-center">
                    <Send className="w-16 h-16 text-white" />
                  </div>
                </div>
                <h2 className="text-[32px] font-light text-[#e9edef] mb-2">{seat?.name}</h2>
                <p className="text-sm text-[#8696a0] max-w-md mx-auto">
                  Send and receive messages without keeping your phone online.
                  <br />
                  Select a conversation to start chatting.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    ) : (
      /* Reports View */
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#202c33] rounded-xl p-4 border border-[#2a3942]">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-[#00a884]/20 flex items-center justify-center">
                  <MessageSquare className="w-5 h-5 text-[#00a884]" />
                </div>
                <span className="text-[#8696a0] text-sm">Total Chats</span>
              </div>
              <p className="text-3xl font-bold text-white">{stats.total_conversations}</p>
            </div>
            
            <div className="bg-[#202c33] rounded-xl p-4 border border-[#2a3942]">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                  <Send className="w-5 h-5 text-blue-400" />
                </div>
                <span className="text-[#8696a0] text-sm">Sent Today</span>
              </div>
              <p className="text-3xl font-bold text-white">{stats.messages_sent_today}</p>
            </div>
            
            <div className="bg-[#202c33] rounded-xl p-4 border border-[#2a3942]">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                  <Eye className="w-5 h-5 text-purple-400" />
                </div>
                <span className="text-[#8696a0] text-sm">Messages Read</span>
              </div>
              <p className="text-3xl font-bold text-white">{stats.messages_read}</p>
            </div>
            
            <div className="bg-[#202c33] rounded-xl p-4 border border-[#2a3942]">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
                  <Users className="w-5 h-5 text-amber-400" />
                </div>
                <span className="text-[#8696a0] text-sm">Responses</span>
              </div>
              <p className="text-3xl font-bold text-white">{stats.responses_received}</p>
            </div>
          </div>
          
          {/* Response Rate */}
          <div className="bg-[#202c33] rounded-xl p-6 border border-[#2a3942]">
            <h3 className="text-white font-medium mb-4 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-[#00a884]" />
              Response Rate
            </h3>
            <div className="flex items-center gap-4">
              <div className="flex-1 bg-[#2a3942] rounded-full h-4 overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-[#00a884] to-[#25d366] transition-all duration-500"
                  style={{ 
                    width: `${stats.total_conversations > 0 
                      ? Math.round((stats.responses_received / stats.total_conversations) * 100) 
                      : 0}%` 
                  }}
                />
              </div>
              <span className="text-white font-bold text-lg min-w-[60px]">
                {stats.total_conversations > 0 
                  ? Math.round((stats.responses_received / stats.total_conversations) * 100) 
                  : 0}%
              </span>
            </div>
            <p className="text-[#8696a0] text-sm mt-2">
              {stats.responses_received} responses from {stats.total_conversations} conversations
            </p>
          </div>
          
          {/* Quick Info */}
          <div className="bg-[#202c33] rounded-xl p-6 border border-[#2a3942]">
            <h3 className="text-white font-medium mb-4">Seat Information</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[#8696a0]">Seat Name</p>
                <p className="text-white font-medium">{seat?.name}</p>
              </div>
              <div>
                <p className="text-[#8696a0]">Status</p>
                <p className="text-[#00a884] font-medium">● Active</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
      </div>
    </div>
  );
};

export default SeatChat;
