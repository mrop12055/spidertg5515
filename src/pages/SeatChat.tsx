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
  Image, X, Loader2, MessageCircle
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { format, isToday, isYesterday, subDays } from 'date-fns';
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
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('24h');
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isSendingMedia, setIsSendingMedia] = useState(false);
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
      default: return subDays(now, 1);
    }
  };

  // Deduplicate conversations by phone number - keep the most recent one
  const deduplicateConversations = (convs: Conversation[]) => {
    const phoneMap = new Map<string, Conversation>();
    
    // Sort by last_message_at descending first
    const sorted = [...convs].sort((a, b) => {
      const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return timeB - timeA;
    });
    
    sorted.forEach(conv => {
      const phone = conv.recipient_phone || conv.id;
      // Only keep the first (most recent) one for each phone
      if (!phoneMap.has(phone)) {
        phoneMap.set(phone, conv);
      }
    });
    
    return Array.from(phoneMap.values());
  };

  // Filter conversations
  const filteredConversations = deduplicateConversations(
    conversations.filter(conv => {
      // Must not be hidden
      if (hiddenConversations.has(conv.id)) return false;
      
      // Time filter
      const cutoff = getTimeFilterCutoff();
      const lastMsgTime = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0;
      if (lastMsgTime < cutoff.getTime()) return false;
      
      // Search filter
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
      // Get all conversations for this seat (including those where admin replied from Conversations page)
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

  const formatMessageDate = (dateStr: string) => {
    const date = new Date(dateStr);
    if (isToday(date)) return format(date, 'HH:mm');
    if (isYesterday(date)) return 'Yesterday ' + format(date, 'HH:mm');
    return format(date, 'MMM d, HH:mm');
  };

  const getMessageStatusIcon = (status: string) => {
    switch (status) {
      case 'read':
        return <CheckCheck className="w-3.5 h-3.5 text-blue-500" />;
      case 'delivered':
        return <CheckCheck className="w-3.5 h-3.5 text-slate-400" />;
      case 'sent':
        return <Check className="w-3.5 h-3.5 text-slate-400" />;
      case 'pending':
        return <Clock className="w-3 h-3 text-slate-400" />;
      case 'failed':
        return <AlertCircle className="w-3.5 h-3.5 text-red-500" />;
      default:
        return null;
    }
  };

  // Get display name with username
  const getDisplayName = (conv: Conversation) => {
    if (conv.recipient_name) return conv.recipient_name;
    if (conv.recipient_username) return `@${conv.recipient_username}`;
    return conv.recipient_phone || 'Unknown';
  };

  // Get avatar initials
  const getAvatarInitial = (conv: Conversation) => {
    if (conv.recipient_name) return conv.recipient_name[0].toUpperCase();
    if (conv.recipient_username) return conv.recipient_username[0].toUpperCase();
    if (conv.recipient_phone) return conv.recipient_phone.slice(-2);
    return '?';
  };

  if (isLoading) {
    return (
      <div className="h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-10 h-10 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600 font-medium">Loading workspace...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full bg-white shadow-xl border-0">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h2 className="text-xl font-bold mb-2 text-slate-800">Access Error</h2>
            <p className="text-slate-500">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-50 to-blue-50/30 overflow-hidden">
      {/* Message Search Dialog */}
      <Dialog open={isMessageSearchOpen} onOpenChange={setIsMessageSearchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Search className="w-5 h-5" />
              Search Messages
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              placeholder="Type to search messages..."
              value={messageSearchQuery}
              onChange={(e) => setMessageSearchQuery(e.target.value)}
              autoFocus
            />
            {messageSearchQuery && (
              <div className="text-sm text-slate-500">
                Found {filteredMessages.length} message{filteredMessages.length !== 1 ? 's' : ''} matching "{messageSearchQuery}"
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Telegram-style Logo */}
            <div className="w-11 h-11 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-lg">
              <MessageCircle className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg text-slate-900">{seat?.name}</h1>
              <p className="text-xs text-slate-500">Telegram Chat Workspace</p>
            </div>
          </div>
          
          {/* Stats in header */}
          <div className="hidden md:flex items-center gap-6">
            <div className="flex items-center gap-2 text-sm">
              <MessageSquare className="w-4 h-4 text-blue-500" />
              <span className="font-semibold text-slate-800">{stats.total_conversations}</span>
              <span className="text-slate-500">Chats</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Send className="w-4 h-4 text-emerald-500" />
              <span className="font-semibold text-slate-800">{stats.messages_sent_today}</span>
              <span className="text-slate-500">Sent</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Eye className="w-4 h-4 text-purple-500" />
              <span className="font-semibold text-slate-800">{stats.messages_read}</span>
              <span className="text-slate-500">Read</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Users className="w-4 h-4 text-orange-500" />
              <span className="font-semibold text-slate-800">{stats.responses_received}</span>
              <span className="text-slate-500">Replies</span>
            </div>
          </div>

          <Badge className="bg-emerald-500 text-white border-0 shadow-sm">
            ● Online
          </Badge>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Conversation Sidebar */}
        <div className="w-80 lg:w-96 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
          {/* Search & Filter Header */}
          <div className="p-4 border-b border-slate-100 space-y-3">
            {/* Time Filter Tabs */}
            <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
              {(['24h', '3d', '5d', '7d'] as TimeFilter[]).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setTimeFilter(filter)}
                  className={cn(
                    "flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                    timeFilter === filter 
                      ? "bg-blue-600 text-white shadow-sm" 
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-200"
                  )}
                >
                  {filter}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 bg-slate-50 border-slate-200 focus:border-blue-400 focus:ring-blue-400 rounded-full h-9"
              />
            </div>

            {/* Conversation Count */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">
                {filteredConversations.length} Conversation{filteredConversations.length !== 1 ? 's' : ''}
              </span>
              {hiddenConversations.size > 0 && (
                <span className="text-xs text-slate-400">
                  {hiddenConversations.size} hidden
                </span>
              )}
            </div>
          </div>

          {/* Conversation List */}
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.length === 0 ? (
              <div className="p-8 text-center">
                <MessageSquare className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">No conversations found</p>
                <p className="text-xs text-slate-400 mt-1">
                  {searchQuery ? 'Try a different search' : 'Conversations will appear here'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredConversations.map((conv) => (
                  <div
                    key={conv.id}
                    className={cn(
                      "flex items-center gap-3 p-4 cursor-pointer transition-all group",
                      selectedConversation?.id === conv.id
                        ? "bg-blue-50 border-l-4 border-l-blue-500"
                        : "hover:bg-slate-50 border-l-4 border-l-transparent"
                    )}
                    onClick={() => setSelectedConversation(conv)}
                  >
                    {/* Avatar with profile picture */}
                    <Avatar className="w-12 h-12 border-2 border-white shadow-md flex-shrink-0">
                      <AvatarImage src={conv.recipient_avatar || ''} />
                      <AvatarFallback className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white text-sm font-semibold">
                        {getAvatarInitial(conv)}
                      </AvatarFallback>
                    </Avatar>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-slate-800 truncate">
                            {getDisplayName(conv)}
                          </p>
                          {/* Show username if different from name */}
                          {conv.recipient_username && conv.recipient_name && (
                            <p className="text-xs text-blue-600 truncate">
                              @{conv.recipient_username}
                            </p>
                          )}
                          {/* Show phone if we have name */}
                          {conv.recipient_name && conv.recipient_phone && (
                            <p className="text-xs text-slate-500 truncate">
                              {conv.recipient_phone}
                            </p>
                          )}
                        </div>
                        {conv.unread_count > 0 && (
                          <Badge className="bg-blue-600 text-white text-xs px-2 min-w-[22px] h-5 shadow-sm flex-shrink-0">
                            {conv.unread_count}
                          </Badge>
                        )}
                      </div>
                      {conv.last_message_at && (
                        <p className="text-[10px] text-slate-400 mt-1">
                          {formatMessageDate(conv.last_message_at)}
                        </p>
                      )}
                    </div>

                    {/* Actions Menu */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="w-4 h-4 text-slate-400" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          toggleHideConversation(conv.id);
                        }}>
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
        <div className="flex-1 flex flex-col bg-slate-50 overflow-hidden">
          {selectedConversation ? (
            <>
              {/* Chat Header */}
              <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-4">
                  <Avatar className="w-11 h-11 border-2 border-white shadow-md">
                    <AvatarImage src={selectedConversation.recipient_avatar || ''} />
                    <AvatarFallback className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-semibold">
                      {getAvatarInitial(selectedConversation)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-semibold text-slate-800">
                      {getDisplayName(selectedConversation)}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      {selectedConversation.recipient_username && (
                        <span className="text-blue-600">@{selectedConversation.recipient_username}</span>
                      )}
                      {selectedConversation.recipient_phone && (
                        <span>{selectedConversation.recipient_phone}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Search Messages Button */}
                  <Button 
                    variant="ghost" 
                    size="icon"
                    onClick={() => setIsMessageSearchOpen(true)}
                    title="Search messages"
                  >
                    <Search className="w-5 h-5 text-slate-400" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreVertical className="w-5 h-5 text-slate-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => toggleHideConversation(selectedConversation.id)}>
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
                className="flex-1 overflow-y-auto p-6"
                style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23e2e8f0\' fill-opacity=\'0.3\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")' }}
              >
                <div className="max-w-3xl mx-auto space-y-4">
                  {filteredMessages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-20">
                      <div className="w-16 h-16 rounded-full bg-slate-200 flex items-center justify-center mb-4">
                        <MessageSquare className="w-8 h-8 text-slate-400" />
                      </div>
                      <p className="text-slate-500 font-medium">
                        {messageSearchQuery ? 'No messages match your search' : 'No messages yet'}
                      </p>
                      <p className="text-sm text-slate-400">
                        {messageSearchQuery ? 'Try a different search term' : 'Start the conversation!'}
                      </p>
                    </div>
                  ) : (
                    filteredMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={cn(
                          "flex",
                          msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[75%] rounded-2xl px-4 py-3 shadow-sm",
                            msg.direction === 'outgoing'
                              ? 'bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-br-md'
                              : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md'
                          )}
                        >
                          {msg.media_url && (
                            <img
                              src={msg.media_url}
                              alt="Media"
                              className="max-w-full rounded-lg mb-2"
                            />
                          )}
                          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{msg.content}</p>
                          <div className={cn(
                            "flex items-center gap-1.5 mt-2",
                            msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'
                          )}>
                            <span className={cn(
                              "text-[10px]",
                              msg.direction === 'outgoing' 
                                ? 'text-white/70' 
                                : 'text-slate-400'
                            )}>
                              {formatMessageDate(msg.created_at)}
                            </span>
                            {msg.direction === 'outgoing' && getMessageStatusIcon(msg.status)}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              {/* Image Preview */}
              {imagePreview && (
                <div className="bg-white border-t border-slate-200 p-4 flex-shrink-0">
                  <div className="max-w-3xl mx-auto relative inline-block">
                    <img 
                      src={imagePreview} 
                      alt="Selected" 
                      className="max-h-32 rounded-lg border border-slate-200"
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

              {/* Message Input */}
              <div className="bg-white border-t border-slate-200 p-4 flex-shrink-0">
                <div className="max-w-3xl mx-auto flex items-center gap-2">
                  {/* Emoji Picker */}
                  <EmojiPicker onEmojiSelect={handleEmojiSelect} className="flex-shrink-0" />
                  
                  {/* Image Upload */}
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
                    className="text-slate-500 hover:text-slate-700 flex-shrink-0"
                    title="Send image"
                  >
                    <Image className="w-5 h-5" />
                  </Button>

                  {/* Input Field */}
                  <Input
                    placeholder="Type your message..."
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                    disabled={isSending}
                    className="flex-1 bg-slate-50 border-slate-200 focus:border-blue-400 focus:ring-blue-400 h-11 rounded-full"
                  />

                  {/* Send Button */}
                  <Button 
                    onClick={handleSendMessage} 
                    disabled={(!messageInput.trim() && !selectedImage) || isSending}
                    className="bg-blue-600 hover:bg-blue-700 text-white shadow-md h-11 w-11 rounded-full flex-shrink-0"
                  >
                    {isSending ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Send className="w-5 h-5" />
                    )}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center mx-auto mb-6">
                  <MessageCircle className="w-12 h-12 text-blue-500" />
                </div>
                <p className="text-xl font-semibold text-slate-700">Select a conversation</p>
                <p className="text-sm text-slate-400 mt-2">Choose from your conversations to start chatting</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SeatChat;
