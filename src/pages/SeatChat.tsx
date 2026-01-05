import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmojiPicker } from '@/components/ui/emoji-picker';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Send, MessageSquare, Users, Eye, CheckCheck, Check, 
  RefreshCw, AlertCircle, Clock, Search, EyeOff, MoreVertical,
  Image, X, Loader2, Phone, Smile, Paperclip, BarChart3, Settings,
  Pin, PinOff, EyeIcon
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { format, isToday, isYesterday, subDays, differenceInMinutes } from 'date-fns';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/chat/LinkifiedText';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type TimeFilter = 'today' | '3d' | '5d' | '7d';
type SeatView = 'chats' | 'reports';
type ChatTab = 'all' | 'pinned' | 'hidden';

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
  last_message_content?: string;
  last_message_direction?: 'incoming' | 'outgoing';
  has_reply?: boolean;
  is_pinned?: boolean;
  is_hidden?: boolean;
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
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('7d');
  const [showRepliedOnly, setShowRepliedOnly] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<SeatView>('chats');
  const [chatTab, setChatTab] = useState<ChatTab>('all');
  const [stats, setStats] = useState<SeatStats>({
    total_conversations: 0,
    messages_sent_today: 0,
    messages_read: 0,
    responses_received: 0
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Toggle pin conversation in database
  const togglePinConversation = async (convId: string, currentlyPinned: boolean) => {
    try {
      const { error } = await supabase
        .from('conversations')
        .update({ is_pinned: !currentlyPinned })
        .eq('id', convId);
      
      if (error) throw error;
      
      toast.success(currentlyPinned ? 'Conversation unpinned' : 'Conversation pinned');
      fetchConversations();
    } catch (err) {
      console.error('Error toggling pin:', err);
      toast.error('Failed to update conversation');
    }
  };

  // Toggle hide conversation in database
  const toggleHideConversation = async (convId: string, currentlyHidden: boolean) => {
    try {
      const { error } = await supabase
        .from('conversations')
        .update({ is_hidden: !currentlyHidden })
        .eq('id', convId);
      
      if (error) throw error;
      
      if (!currentlyHidden && selectedConversation?.id === convId) {
        setSelectedConversation(null);
      }
      
      toast.success(currentlyHidden ? 'Conversation unhidden' : 'Conversation hidden');
      fetchConversations();
    } catch (err) {
      console.error('Error toggling hide:', err);
      toast.error('Failed to update conversation');
    }
  };

  // Time filter cutoff - memoized
  const timeFilterCutoff = React.useMemo(() => {
    const now = new Date();
    switch (timeFilter) {
      case 'today': {
        // Start of today (midnight)
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        return startOfToday;
      }
      case '3d': return subDays(now, 3);
      case '5d': return subDays(now, 5);
      case '7d': return subDays(now, 7);
      default: return subDays(now, 7);
    }
  }, [timeFilter]);

  // Deduplicate conversations by phone number - keep the most recent one
  const deduplicateConversations = useCallback((convs: Conversation[]) => {
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
  }, []);

  // Time-filtered base conversations - ONLY show campaign conversations (where we messaged first)
  const timeFilteredConversations = React.useMemo(() => {
    const cutoffTime = timeFilterCutoff.getTime();
    return conversations.filter(conv => {
      // Only include conversations where we sent the first message (campaign initiated)
      if (!conv.first_message_sent) return false;
      
      const lastMsgTime = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0;
      return lastMsgTime >= cutoffTime;
    });
  }, [conversations, timeFilterCutoff]);

  // Filter conversations based on current tab and filters
  const filteredConversations = React.useMemo(() => {
    let filtered = timeFilteredConversations;
    
    // Filter by tab
    if (chatTab === 'pinned') {
      filtered = filtered.filter(conv => conv.is_pinned);
    } else if (chatTab === 'hidden') {
      // Hidden tab should show all hidden regardless of time filter (only campaign conversations)
      filtered = conversations.filter(conv => conv.is_hidden && conv.first_message_sent);
    } else {
      // "all" tab shows non-hidden conversations
      filtered = filtered.filter(conv => !conv.is_hidden);
    }
    
    // Apply "replied only" filter
    if (showRepliedOnly) {
      filtered = filtered.filter(conv => conv.has_reply);
    }
    
    // When searching, ignore time filter to search ALL conversations
    if (searchQuery) {
      // Re-filter from all conversations for search (still only campaign conversations)
      const searchLower = searchQuery.toLowerCase();
      filtered = conversations.filter(conv => (
        conv.first_message_sent && // Only campaign conversations
        (conv.recipient_name?.toLowerCase().includes(searchLower) ||
        conv.recipient_phone?.toLowerCase().includes(searchLower) ||
        conv.recipient_username?.toLowerCase().includes(searchLower) ||
        conv.last_message_content?.toLowerCase().includes(searchLower))
      ));
      
      // Apply tab filter after search
      if (chatTab === 'pinned') {
        filtered = filtered.filter(conv => conv.is_pinned);
      } else if (chatTab === 'hidden') {
        filtered = filtered.filter(conv => conv.is_hidden);
      } else {
        filtered = filtered.filter(conv => !conv.is_hidden);
      }
    }
    
    // Sort: pinned first, then by last message time
    return deduplicateConversations(filtered).sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return timeB - timeA;
    });
  }, [timeFilteredConversations, conversations, chatTab, showRepliedOnly, searchQuery, deduplicateConversations]);

  // Count for each tab (using time-filtered base - only campaign conversations)
  const allCount = timeFilteredConversations.filter(c => !c.is_hidden).length;
  const pinnedCount = timeFilteredConversations.filter(c => c.is_pinned).length;
  const hiddenCount = conversations.filter(c => c.is_hidden && c.first_message_sent).length;

  // Filter messages by search
  const filteredMessages = messageSearchQuery
    ? messages.filter(msg => msg.content.toLowerCase().includes(messageSearchQuery.toLowerCase()))
    : messages;

  // Validate seat token
  useEffect(() => {
    const validateSeat = async () => {
      if (!token) {
        setError('invalid_link');
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
          setError('revoked');
          setIsLoading(false);
          return;
        }

        if (!data.is_active) {
          setError('deactivated');
          setIsLoading(false);
          return;
        }

        setSeat(data);
        setIsLoading(false);
      } catch (err) {
        console.error('Error validating seat:', err);
        setError('failed');
        setIsLoading(false);
      }
    };

    validateSeat();
  }, [token]);

  // Fetch conversations for this seat - ONLY campaign conversations (where we messaged first)
  const fetchConversations = useCallback(async () => {
    if (!seat) return;

    try {
      // Only fetch campaign conversations (first_message_sent = true) to reduce load
      const { data, error } = await supabase
        .from('conversations')
        .select('id, account_id, recipient_phone, recipient_name, recipient_username, recipient_avatar, recipient_telegram_id, unread_count, last_message_at, is_active, seat_id, first_message_sent, last_message_content, last_message_direction, has_reply, is_pinned, is_hidden')
        .eq('seat_id', seat.id)
        .eq('first_message_sent', true)
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (error) throw error;
      
      // Use the conversation's stored values directly (updated by trigger)
      setConversations((data || []).map(conv => ({
        ...conv,
        has_reply: conv.has_reply ?? false,
        last_message_direction: conv.last_message_direction as 'incoming' | 'outgoing' | undefined,
      })));
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
      let mediaUrl: string | null = null;
      let mediaType: string | null = null;

      // Upload image if selected
      if (selectedImage) {
        const fileName = `${Date.now()}_${selectedImage.name}`;
        const filePath = `${selectedConversation.account_id}/${fileName}`;
        
        const { error: uploadError } = await supabase.storage
          .from('message-attachments')
          .upload(filePath, selectedImage);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('message-attachments')
          .getPublicUrl(filePath);

        mediaUrl = publicUrl;
        mediaType = selectedImage.type.startsWith('image/') ? 'image' : 
                    selectedImage.type.startsWith('video/') ? 'video' : 
                    selectedImage.type.startsWith('audio/') ? 'audio' : 'document';
      }

      const { error } = await supabase
        .from('messages')
        .insert({
          conversation_id: selectedConversation.id,
          account_id: selectedConversation.account_id,
          content: messageInput.trim() || (mediaUrl ? '' : ''),
          direction: 'outgoing',
          status: 'pending',
          priority: 10,
          media_url: mediaUrl,
          media_type: mediaType
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

  // Get avatar initials from phone number or username
  const getAvatarInitial = (conv: Conversation) => {
    // First try to get name initials
    if (conv.recipient_name) {
      const parts = conv.recipient_name.split(' ');
      if (parts.length >= 2) {
        return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
      }
      return conv.recipient_name.slice(0, 2).toUpperCase();
    }
    // Then try phone digits
    if (conv.recipient_phone) {
      const digits = conv.recipient_phone.replace(/\D/g, '');
      if (digits.length >= 2) {
        return digits.slice(-2);
      }
      // If it's a username (no digits), use first 2 chars after @
      const username = conv.recipient_phone.replace('@', '');
      if (username.length >= 2) {
        return username.slice(0, 2).toUpperCase();
      }
    }
    // Fallback to username
    if (conv.recipient_username) {
      const username = conv.recipient_username.replace('@', '');
      return username.slice(0, 2).toUpperCase();
    }
    return '??';
  };

  // Format last seen time
  const formatLastSeen = (conv: Conversation) => {
    if (!conv.last_message_at) return '';
    const lastMsg = new Date(conv.last_message_at);
    const mins = differenceInMinutes(new Date(), lastMsg);
    if (mins < 5) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return format(lastMsg, 'MMM d');
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

  if (isLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Send className="w-8 h-8 text-primary-foreground" />
          </div>
          <p className="text-muted-foreground font-medium">Loading workspace...</p>
        </div>
      </div>
    );
  }

  if (error) {
    const getErrorContent = () => {
      switch (error) {
        case 'revoked':
          return {
            title: 'Link Revoked',
            subtitle: 'Access Denied',
            message: 'This link has been revoked and you can no longer access this chat.',
            action: 'Please ask your administrator for a new link.',
            iconBg: 'from-destructive/25 to-destructive/10',
            iconColor: 'text-destructive',
          };
        case 'deactivated':
          return {
            title: 'Workspace Inactive',
            subtitle: 'Temporarily Unavailable',
            message: 'This workspace has been deactivated by the administrator.',
            action: 'Contact your administrator to reactivate access.',
            iconBg: 'from-primary/25 to-primary/10',
            iconColor: 'text-primary',
          };
        case 'invalid_link':
          return {
            title: 'Invalid Link',
            subtitle: 'Page Not Found',
            message: 'The link you are trying to access is invalid or expired.',
            action: 'Please check the URL or request a new link.',
            iconBg: 'from-destructive/25 to-destructive/10',
            iconColor: 'text-destructive',
          };
        default:
          return {
            title: 'Something Went Wrong',
            subtitle: 'Connection Error',
            message: "We couldn't load this workspace at the moment.",
            action: 'Please try again later or contact support.',
            iconBg: 'from-destructive/25 to-destructive/10',
            iconColor: 'text-destructive',
          };
      }
    };

    const errorContent = getErrorContent();

    return (
      <div className="min-h-screen relative overflow-hidden bg-gradient-to-br from-background via-background to-muted/40 flex items-center justify-center p-6">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-24 -left-24 w-96 h-96 bg-primary/10 rounded-full blur-3xl animate-pulse" />
          <div className="absolute -bottom-24 -right-24 w-80 h-80 bg-destructive/10 rounded-full blur-3xl animate-pulse delay-1000" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] h-[520px] bg-muted/30 rounded-full blur-3xl" />
        </div>

        <div className="relative max-w-lg w-full">
          {/* Main Card */}
          <div className="relative bg-card/80 backdrop-blur-xl rounded-3xl border border-border/60 shadow-2xl overflow-hidden">
            {/* Top decorative bar */}
            <div className="h-1.5 bg-gradient-to-r from-primary via-primary/70 to-destructive" />

            <div className="p-10 text-center space-y-8">
              {/* Icon with animated rings */}
              <div className="relative mx-auto w-28 h-28">
                <div
                  className={`absolute inset-0 bg-gradient-to-br ${errorContent.iconBg} rounded-full animate-ping opacity-20`}
                />
                <div
                  className={`absolute inset-2 bg-gradient-to-br ${errorContent.iconBg} rounded-full animate-pulse`}
                />
                <div className="relative w-full h-full rounded-full bg-background/70 border border-border/60 flex items-center justify-center shadow-xl">
                  <AlertCircle className={`w-12 h-12 ${errorContent.iconColor}`} />
                </div>
              </div>

              {/* Content */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                    {errorContent.subtitle}
                  </p>
                  <h1 className="text-3xl font-bold text-foreground tracking-tight">
                    {errorContent.title}
                  </h1>
                </div>

                <div className="max-w-sm mx-auto space-y-2">
                  <p className="text-foreground/80 text-base leading-relaxed">
                    {errorContent.message}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {errorContent.action}
                  </p>
                </div>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-4">
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
                <span className="text-muted-foreground/70 text-xs font-medium tracking-wide">NEED HELP?</span>
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
              </div>

              {/* Footer */}
              <div className="space-y-4">
                <p className="text-muted-foreground/80 text-sm">
                  Contact your workspace administrator for assistance
                </p>

                <div className="flex justify-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/20" />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                </div>
              </div>
            </div>
          </div>

          {/* Bottom glow accent */}
          <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-3/4 h-8 bg-primary/15 blur-2xl rounded-full" />
        </div>
      </div>
    );
  }

  const messageGroups = groupMessagesByDate(filteredMessages);

  return (
    <div className="h-screen flex bg-gradient-to-br from-muted/30 via-background to-muted/20 overflow-hidden">
      {/* Left Sidebar Navigation - Professional Design */}
      <aside className="w-64 bg-gradient-to-b from-card via-card to-card/95 backdrop-blur-xl border-r border-border/30 flex flex-col flex-shrink-0 shadow-2xl">
        {/* Header with Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-border/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary via-primary to-primary/80 flex items-center justify-center shadow-lg shadow-primary/30">
              <Send className="w-5 h-5 text-primary-foreground rotate-[-45deg]" />
            </div>
            <div>
              <h1 className="font-bold text-base text-foreground tracking-tight leading-none">{seat?.name || 'Workspace'}</h1>
              <p className="text-xs text-muted-foreground/80 font-medium uppercase tracking-wider mt-0.5">Console</p>
            </div>
          </div>
          <ThemeToggle className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted/80 rounded-lg" />
        </div>

        {/* Stats Cards */}
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="relative overflow-hidden bg-gradient-to-br from-primary/10 via-primary/5 to-transparent rounded-xl p-3 border border-primary/10">
              <p className="text-2xl font-bold text-foreground tracking-tight">{stats.total_conversations}</p>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Chats</p>
            </div>
            <div className="relative overflow-hidden bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent rounded-xl p-3 border border-emerald-500/10">
              <p className="text-2xl font-bold text-foreground tracking-tight">{stats.responses_received}</p>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Replies</p>
            </div>
          </div>
          
          {/* Messages Sent in Last 24h - Prominent Display */}
          <div className="bg-gradient-to-r from-blue-500/10 via-blue-500/5 to-transparent rounded-xl p-4 border border-blue-500/10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                  <Send className="w-5 h-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Sent Today</p>
                  <p className="text-xl font-bold text-foreground tracking-tight leading-none mt-1">{stats.messages_sent_today}</p>
                </div>
              </div>
              <span className="text-xs text-muted-foreground/70 font-medium">24h</span>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-3 px-4">
          <p className="px-2 py-2 text-xs font-bold text-muted-foreground/60 uppercase tracking-widest">Navigation</p>
          
          <div className="space-y-2">
            <button
              onClick={() => setCurrentView('chats')}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group",
                currentView === 'chats'
                  ? "bg-gradient-to-r from-primary to-primary/90 text-primary-foreground shadow-md shadow-primary/25"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              )}
            >
              <div className={cn(
                "w-9 h-9 rounded-lg flex items-center justify-center transition-all",
                currentView === 'chats' ? "bg-white/20" : "bg-muted/80"
              )}>
                <MessageSquare className="w-5 h-5" />
              </div>
              <span className="text-base font-medium">Conversations</span>
              {conversations.filter(c => (c.unread_count || 0) > 0).length > 0 && (
                <span className="ml-auto min-w-[22px] h-[22px] rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center px-1.5 shadow-sm">
                  {conversations.filter(c => (c.unread_count || 0) > 0).length}
                </span>
              )}
            </button>

            <button
              onClick={() => setCurrentView('reports')}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group",
                currentView === 'reports'
                  ? "bg-gradient-to-r from-primary to-primary/90 text-primary-foreground shadow-md shadow-primary/25"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              )}
            >
              <div className={cn(
                "w-9 h-9 rounded-lg flex items-center justify-center transition-all",
                currentView === 'reports' ? "bg-white/20" : "bg-muted/80"
              )}>
                <BarChart3 className="w-5 h-5" />
              </div>
              <span className="text-base font-medium">Analytics</span>
            </button>
          </div>
        </nav>

        {/* Seat Profile */}
        <div className="p-4 border-t border-border/50">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-gradient-to-r from-muted/60 to-muted/30 hover:from-muted/80 hover:to-muted/50 transition-colors">
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary via-primary/90 to-primary/70 flex items-center justify-center text-primary-foreground font-bold text-sm shadow-md">
                {seat?.name?.charAt(0).toUpperCase() || 'S'}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-card" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{seat?.name}</p>
              <p className="text-xs text-green-500 font-medium">Active</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Message Search Dialog */}
        <Dialog open={isMessageSearchOpen} onOpenChange={setIsMessageSearchOpen}>
          <DialogContent className="max-w-md bg-card border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-foreground">
                <Search className="w-5 h-5" />
                Search Messages
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                placeholder="Type to search messages..."
                value={messageSearchQuery}
                onChange={(e) => setMessageSearchQuery(e.target.value)}
                className="bg-muted border-0 text-foreground placeholder:text-muted-foreground focus:ring-primary"
                autoFocus
              />
              {messageSearchQuery && (
                <div className="text-sm text-muted-foreground">
                  Found {filteredMessages.length} message{filteredMessages.length !== 1 ? 's' : ''} matching "{messageSearchQuery}"
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Header */}
        <header className="bg-card/60 backdrop-blur-md border-b border-border/30 flex-shrink-0 px-4 py-2.5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-bold text-foreground text-base tracking-tight">
                {currentView === 'chats' ? 'Conversations' : 'Analytics'}
              </h1>
              <p className="text-[11px] text-muted-foreground/80">
                {currentView === 'chats' 
                  ? `${filteredConversations.length} chats` 
                  : 'Performance metrics'}
              </p>
            </div>
            
            <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[10px] px-2.5 py-1 font-semibold rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />
              Live
            </Badge>
          </div>
        </header>

        {/* View Content */}
        {currentView === 'chats' ? (
          /* Chats View */
          <div className="flex-1 flex overflow-hidden">
            {/* Conversation Sidebar */}
            <div className="w-[364px] lg:w-[416px] bg-card/40 backdrop-blur-sm border-r border-border/30 flex flex-col flex-shrink-0">
              {/* Chat Tabs */}
              <div className="p-2.5 border-b border-border/30">
                <Tabs value={chatTab} onValueChange={(v) => setChatTab(v as ChatTab)} className="w-full">
                  <TabsList className="w-full h-9 bg-muted/50 p-0.5 rounded-lg grid grid-cols-3">
                    <TabsTrigger 
                      value="all" 
                      className="text-xs font-medium rounded-md data-[state=active]:bg-card data-[state=active]:shadow-sm"
                    >
                      All {allCount > 0 && <span className="ml-1 text-muted-foreground">({allCount})</span>}
                    </TabsTrigger>
                    <TabsTrigger 
                      value="pinned" 
                      className="text-xs font-medium rounded-md data-[state=active]:bg-card data-[state=active]:shadow-sm"
                    >
                      <Pin className="w-3 h-3 mr-1" />
                      {pinnedCount > 0 && <span className="text-muted-foreground">{pinnedCount}</span>}
                    </TabsTrigger>
                    <TabsTrigger 
                      value="hidden" 
                      className="text-xs font-medium rounded-md data-[state=active]:bg-card data-[state=active]:shadow-sm"
                    >
                      <EyeOff className="w-3 h-3 mr-1" />
                      {hiddenCount > 0 && <span className="text-muted-foreground">{hiddenCount}</span>}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {/* Search & Filter */}
              <div className="p-2.5 space-y-2">
                {/* Time Filters */}
                <div className="flex gap-0.5 p-0.5 bg-muted/40 rounded-lg border border-border/30">
                  {(['today', '3d', '5d', '7d'] as TimeFilter[]).map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setTimeFilter(filter)}
                      className={cn(
                        "flex-1 px-2 py-1 text-[10px] font-semibold rounded-md transition-all duration-200",
                        timeFilter === filter 
                          ? "bg-card text-foreground shadow-sm border border-border/50" 
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {filter === 'today' ? 'Today' : filter}
                    </button>
                  ))}
                </div>

                {/* Replied Filter Toggle */}
                <button
                  onClick={() => setShowRepliedOnly(!showRepliedOnly)}
                  className={cn(
                    "w-full flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold rounded-lg transition-all duration-200 border",
                    showRepliedOnly 
                      ? "bg-primary/10 text-primary border-primary/30" 
                      : "bg-muted/40 text-muted-foreground border-border/30 hover:text-foreground hover:bg-muted/60"
                  )}
                >
                  <MessageSquare className="w-4 h-4" />
                  {showRepliedOnly ? 'Replied Only' : 'Show Replied Only'}
                </button>

                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
                  <Input
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 h-10 bg-muted/40 border-border/30 text-foreground placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-primary/30 focus:border-primary/50 rounded-lg text-sm"
                  />
                </div>
              </div>

              {/* Conversation List */}
              <div className="flex-1 overflow-y-auto px-1.5">
                {filteredConversations.length === 0 ? (
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
                ) : (
                  <div className="space-y-0.5 py-1.5">
                    {filteredConversations.map((conv) => (
                      <div
                        key={conv.id}
                        className={cn(
                          "flex items-center gap-3.5 px-3 py-4 cursor-pointer transition-all duration-200 group rounded-xl",
                          selectedConversation?.id === conv.id
                            ? "bg-primary/10 border border-primary/30 shadow-sm shadow-primary/10"
                            : "hover:bg-muted/60 border border-transparent"
                        )}
                        onClick={() => setSelectedConversation(conv)}
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
                            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-primary border-2 border-card animate-pulse" />
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
                              {formatConversationTime(conv.last_message_at)}
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
                                togglePinConversation(conv.id, !!conv.is_pinned);
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
                                toggleHideConversation(conv.id, !!conv.is_hidden);
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
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Message Area with Contact Details */}
            <div className="flex-1 flex overflow-hidden">
              {/* Chat Container */}
              <div className="flex-1 flex flex-col overflow-hidden p-4 lg:p-6">
                {selectedConversation ? (
                  <div className="flex-1 flex flex-col bg-gradient-to-b from-card to-card/95 rounded-2xl shadow-2xl border border-border/30 overflow-hidden animate-scale-in">
                    {/* Chat Header */}
                    <div className="bg-card/80 backdrop-blur-sm border-b border-border/30 px-5 py-4 flex items-center justify-between flex-shrink-0">
                      <div className="flex items-center gap-4">
                        <div className="relative group">
                          <Avatar className="w-12 h-12 ring-2 ring-primary/20 ring-offset-2 ring-offset-card shadow-lg transition-transform group-hover:scale-105">
                            <AvatarImage src={selectedConversation.recipient_avatar || ''} />
                            <AvatarFallback className={cn(
                              "bg-gradient-to-br text-white text-base font-semibold",
                              getAvatarColor(selectedConversation.recipient_phone)
                            )}>
                              {getAvatarInitial(selectedConversation)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 rounded-full border-2 border-card shadow-sm" />
                        </div>
                        <div>
                          <p className="font-bold text-foreground text-lg tracking-tight">
                            {getDisplayName(selectedConversation)}
                          </p>
                          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                            {formatLastSeen(selectedConversation)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => setIsMessageSearchOpen(true)}
                          className="text-muted-foreground hover:text-foreground hover:bg-muted/60 h-10 w-10 rounded-xl transition-colors"
                        >
                          <Search className="w-5 h-5" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button 
                              variant="ghost" 
                              size="icon"
                              className="text-muted-foreground hover:text-foreground hover:bg-muted/60 h-10 w-10 rounded-xl transition-colors"
                            >
                              <MoreVertical className="w-5 h-5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="bg-popover border-border text-popover-foreground w-48">
                            <DropdownMenuItem 
                              onClick={() => togglePinConversation(selectedConversation.id, !!selectedConversation.is_pinned)}
                              className="text-muted-foreground hover:bg-muted focus:bg-muted cursor-pointer"
                            >
                              {selectedConversation.is_pinned ? (
                                <>
                                  <PinOff className="w-4 h-4 mr-2" />
                                  Unpin conversation
                                </>
                              ) : (
                                <>
                                  <Pin className="w-4 h-4 mr-2" />
                                  Pin conversation
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => toggleHideConversation(selectedConversation.id, !!selectedConversation.is_hidden)}
                              className="text-muted-foreground hover:bg-muted focus:bg-muted cursor-pointer"
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
                      className="flex-1 overflow-y-auto px-4 md:px-6 py-6 scrollbar-thin"
                      style={{
                        backgroundImage: `radial-gradient(circle at 50% 0%, hsl(var(--primary) / 0.03) 0%, transparent 50%), 
                                          radial-gradient(circle at 100% 100%, hsl(var(--primary) / 0.02) 0%, transparent 40%)`
                      }}
                    >
                      <div className="max-w-4xl mx-auto space-y-1">
                        {messageGroups.length === 0 ? (
                          <div className="flex flex-col items-center justify-center h-full py-20 animate-fade-in">
                            <div className="relative mb-6">
                              <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                                <MessageSquare className="w-10 h-10 text-primary/40" />
                              </div>
                              <div className="absolute inset-0 rounded-full bg-primary/5 animate-ping" style={{ animationDuration: '2s' }} />
                            </div>
                            <p className="text-foreground font-semibold text-lg">
                              {messageSearchQuery ? 'No messages match your search' : 'Start the conversation'}
                            </p>
                            <p className="text-muted-foreground text-sm mt-2 max-w-xs text-center">
                              Send a message to begin chatting with {getDisplayName(selectedConversation)}
                            </p>
                          </div>
                        ) : (
                          messageGroups.map((group, groupIndex) => (
                            <div key={groupIndex} className="animate-fade-in" style={{ animationDelay: `${groupIndex * 40}ms` }}>
                              {/* Date Separator */}
                              <div className="flex items-center justify-center my-6">
                                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
                                <span className="bg-background text-muted-foreground text-xs font-medium px-4 py-1.5 rounded-full border border-border/50 shadow-sm mx-4">
                                  {formatDateSeparator(group.date)}
                                </span>
                                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
                              </div>
                              
                              {/* Messages */}
                              <div className="space-y-3">
                                {group.messages.map((msg, msgIndex) => {
                                  const isOutgoing = msg.direction === 'outgoing';
                                  return (
                                    <div
                                      key={msg.id}
                                      className={cn(
                                        "flex animate-fade-in group",
                                        isOutgoing ? 'justify-end' : 'justify-start'
                                      )}
                                      style={{ animationDelay: `${msgIndex * 20}ms` }}
                                    >
                                      {/* Incoming message avatar */}
                                      {!isOutgoing && (
                                        <Avatar className="w-8 h-8 mr-2 mt-1 flex-shrink-0 ring-2 ring-background shadow-sm">
                                          <AvatarImage src={selectedConversation?.recipient_avatar || ''} />
                                          <AvatarFallback className={cn(
                                            "bg-gradient-to-br text-white text-xs font-semibold",
                                            getAvatarColor(selectedConversation?.recipient_phone || null)
                                          )}>
                                            {getAvatarInitial(selectedConversation!)}
                                          </AvatarFallback>
                                        </Avatar>
                                      )}
                                      
                                      <div
                                        className={cn(
                                          "relative max-w-[75%] md:max-w-[65%] transition-all duration-200",
                                          "group-hover:scale-[1.01]"
                                        )}
                                      >
                                        <div className={cn(
                                          "rounded-2xl px-4 py-3 shadow-sm",
                                          isOutgoing
                                            ? 'bg-gradient-to-br from-primary to-primary/90 text-primary-foreground rounded-tr-sm ml-auto shadow-lg shadow-primary/20'
                                            : 'bg-card text-card-foreground rounded-tl-sm border border-border/50'
                                        )}>
                                          {msg.media_url && (
                                            <img
                                              src={msg.media_url}
                                              alt="Media"
                                              className="max-w-[200px] max-h-[200px] object-cover rounded-lg mb-2 shadow-md cursor-pointer hover:opacity-90 transition-opacity"
                                              onClick={() => window.open(msg.media_url!, '_blank')}
                                            />
                                          )}
                                          <p className={cn(
                                            "text-[15px] leading-relaxed whitespace-pre-wrap break-words",
                                            isOutgoing ? "text-primary-foreground" : "text-foreground"
                                          )}>
                                            <LinkifiedText text={msg.content} />
                                          </p>
                                        </div>
                                        
                                        {/* Message footer */}
                                        <div className={cn(
                                          "flex items-center gap-1.5 mt-1.5 px-1",
                                          isOutgoing ? 'justify-end' : 'justify-start'
                                        )}>
                                          <span className="text-[11px] text-muted-foreground/70">
                                            {formatMessageTime(msg.created_at)}
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
                                })}
                              </div>
                            </div>
                          ))
                        )}
                        <div ref={messagesEndRef} />
                      </div>
                    </div>

                    {/* Image Preview */}
                    {imagePreview && (
                      <div className="bg-muted/50 border-t border-border/50 p-3 flex-shrink-0">
                        <div className="relative inline-block">
                          <img 
                            src={imagePreview} 
                            alt="Selected" 
                            className="max-h-24 rounded-xl shadow-md"
                          />
                          <Button
                            variant="destructive"
                            size="icon"
                            className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive hover:bg-destructive/90 shadow-lg"
                            onClick={clearSelectedImage}
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Message Input */}
                    <div className="bg-card/80 backdrop-blur-sm border-t border-border/30 px-4 md:px-6 py-4 flex-shrink-0">
                      <div className="max-w-4xl mx-auto flex items-end gap-3">
                        {/* Left Actions */}
                        <div className="flex items-center gap-1 pb-1">
                          <EmojiPicker onEmojiSelect={handleEmojiSelect} className="flex-shrink-0" />
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
                            className="text-muted-foreground hover:text-foreground hover:bg-muted/80 h-10 w-10 flex-shrink-0 rounded-xl transition-colors"
                          >
                            <Paperclip className="w-5 h-5" />
                          </Button>
                        </div>

                        {/* Input Container */}
                        <div className="flex-1 relative">
                          <Input
                            placeholder="Type your message..."
                            value={messageInput}
                            onChange={(e) => setMessageInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                            disabled={isSending}
                            className="w-full bg-muted/40 border-border/50 text-foreground placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-primary/30 focus:border-primary/50 h-12 rounded-2xl text-[15px] pl-5 pr-5 transition-all shadow-inner"
                          />
                        </div>

                        {/* Send Button */}
                        <Button 
                          onClick={handleSendMessage} 
                          disabled={isSending || (!messageInput.trim() && !selectedImage)}
                          className={cn(
                            "h-12 w-12 rounded-2xl flex-shrink-0 transition-all duration-300",
                            messageInput.trim() || selectedImage
                              ? "bg-gradient-to-br from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground shadow-lg shadow-primary/30 hover:shadow-xl hover:shadow-primary/40 hover:scale-105"
                              : "bg-muted text-muted-foreground hover:bg-muted/80"
                          )}
                          size="icon"
                        >
                          {isSending ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <Send className={cn(
                              "w-5 h-5 transition-transform",
                              messageInput.trim() || selectedImage ? "translate-x-0.5 -translate-y-0.5" : ""
                            )} />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-card via-card to-muted/20 rounded-2xl shadow-xl border border-border/30 animate-fade-in">
                    <div className="text-center px-8">
                      <div className="w-32 h-32 mx-auto mb-8 relative">
                        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-primary/5 rounded-full animate-pulse" style={{ animationDuration: '3s' }} />
                        <div className="absolute inset-4 bg-gradient-to-br from-primary/30 to-primary/10 rounded-full" />
                        <div className="absolute inset-8 bg-gradient-to-br from-primary to-primary/80 rounded-full flex items-center justify-center shadow-xl shadow-primary/30">
                          <MessageSquare className="w-8 h-8 text-primary-foreground" />
                        </div>
                      </div>
                      <h2 className="text-2xl font-bold text-foreground tracking-tight">{seat?.name}</h2>
                      <p className="text-base text-muted-foreground mt-3 max-w-sm mx-auto leading-relaxed">
                        Select a conversation from the sidebar to start messaging
                      </p>
                      <div className="flex items-center justify-center gap-2 mt-6">
                        <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <div className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Contact Details Panel */}
              {selectedConversation && (
                <div className="w-80 bg-gradient-to-b from-card to-card/95 border-l border-border/30 flex-shrink-0 overflow-y-auto animate-slide-in-right hidden xl:block">
                  {/* Contact Header */}
                  <div className="p-6 text-center border-b border-border/30 bg-gradient-to-br from-primary/5 to-transparent">
                    <div className="relative inline-block mb-4">
                      <Avatar className="w-24 h-24 ring-4 ring-primary/20 ring-offset-4 ring-offset-card shadow-xl">
                        <AvatarImage src={selectedConversation.recipient_avatar || ''} />
                        <AvatarFallback className={cn(
                          "bg-gradient-to-br text-white text-2xl font-bold",
                          getAvatarColor(selectedConversation.recipient_phone)
                        )}>
                          {getAvatarInitial(selectedConversation)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="absolute bottom-1 right-1 w-5 h-5 bg-green-500 rounded-full border-3 border-card shadow-md" />
                    </div>
                    <h3 className="text-xl font-bold text-foreground">
                      {getDisplayName(selectedConversation)}
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1 flex items-center justify-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      {formatLastSeen(selectedConversation)}
                    </p>
                  </div>

                  {/* Contact Info */}
                  <div className="p-5 space-y-3">
                    <div className="bg-muted/40 rounded-xl p-4 border border-border/30 hover:bg-muted/60 transition-colors">
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Phone Number</p>
                      <p className="text-foreground font-medium flex items-center gap-2 text-sm">
                        <Phone className="w-4 h-4 text-primary" />
                        {selectedConversation.recipient_phone || 'Not available'}
                      </p>
                    </div>

                    {selectedConversation.recipient_username && (
                      <div className="bg-muted/40 rounded-xl p-4 border border-border/30 hover:bg-muted/60 transition-colors">
                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Username</p>
                        <p className="text-foreground font-medium text-sm">
                          @{selectedConversation.recipient_username.replace(/^@/, '')}
                        </p>
                      </div>
                    )}

                    <div className="bg-muted/40 rounded-xl p-4 border border-border/30">
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Status</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className="bg-primary/10 text-primary border-primary/20 text-xs font-medium">
                          Campaign Contact
                        </Badge>
                        {selectedConversation.has_reply && (
                          <Badge className="bg-green-500/10 text-green-600 border-green-500/20 text-xs font-medium">
                            Replied
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Quick Actions */}
                    <div className="pt-4 space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Actions</p>
                      <Button 
                        variant="outline" 
                        className="w-full justify-start gap-2 h-11 rounded-xl"
                        onClick={() => togglePinConversation(selectedConversation.id, !!selectedConversation.is_pinned)}
                      >
                        {selectedConversation.is_pinned ? (
                          <>
                            <PinOff className="w-4 h-4" />
                            Unpin Conversation
                          </>
                        ) : (
                          <>
                            <Pin className="w-4 h-4" />
                            Pin Conversation
                          </>
                        )}
                      </Button>
                      <Button 
                        variant="outline" 
                        className="w-full justify-start gap-2 h-11 rounded-xl"
                        onClick={() => toggleHideConversation(selectedConversation.id, !!selectedConversation.is_hidden)}
                      >
                        <EyeOff className="w-4 h-4" />
                        Hide Conversation
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Reports View */
          <div className="flex-1 overflow-y-auto p-6 lg:p-8 bg-muted/30">
            <div className="w-full space-y-6">
              {/* Page Header */}
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-foreground tracking-tight">Analytics Dashboard</h2>
                <p className="text-muted-foreground text-base mt-1">Track your conversation performance and engagement metrics</p>
              </div>
              
              {/* Stats Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
                <div className="bg-card rounded-xl p-5 border border-border shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                      <MessageSquare className="w-6 h-6 text-primary" />
                    </div>
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full uppercase">Total</span>
                  </div>
                  <p className="text-3xl font-bold text-foreground tracking-tight">{stats.total_conversations}</p>
                  <p className="text-sm text-muted-foreground mt-1">Conversations</p>
                </div>
                
                <div className="bg-card rounded-xl p-5 border border-border shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-500/5 flex items-center justify-center">
                      <Send className="w-6 h-6 text-blue-500" />
                    </div>
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full uppercase">24h</span>
                  </div>
                  <p className="text-3xl font-bold text-foreground tracking-tight">{stats.messages_sent_today}</p>
                  <p className="text-sm text-muted-foreground mt-1">Messages Sent</p>
                </div>
                
                <div className="bg-card rounded-xl p-5 border border-border shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500/20 to-purple-500/5 flex items-center justify-center">
                      <Eye className="w-6 h-6 text-purple-500" />
                    </div>
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full uppercase">Read</span>
                  </div>
                  <p className="text-3xl font-bold text-foreground tracking-tight">{stats.messages_read}</p>
                  <p className="text-sm text-muted-foreground mt-1">Messages Read</p>
                </div>
                
                <div className="bg-card rounded-xl p-5 border border-border shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-green-500/20 to-green-500/5 flex items-center justify-center">
                      <Users className="w-6 h-6 text-green-500" />
                    </div>
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full uppercase">Replies</span>
                  </div>
                  <p className="text-3xl font-bold text-foreground tracking-tight">{stats.responses_received}</p>
                  <p className="text-sm text-muted-foreground mt-1">Responses</p>
                </div>
              </div>
              
              {/* Response Rate Card */}
              <div className="bg-card rounded-xl p-6 border border-border shadow-sm">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">Response Rate</h3>
                    <p className="text-sm text-muted-foreground mt-1">Percentage of conversations with replies</p>
                  </div>
                  <div className="text-right">
                    <p className="text-4xl font-bold text-primary">
                      {stats.total_conversations > 0 
                        ? Math.round((stats.responses_received / stats.total_conversations) * 100) 
                        : 0}%
                    </p>
                  </div>
                </div>
                <div className="relative h-3 bg-muted rounded-full overflow-hidden">
                  <div 
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary to-primary/70 rounded-full transition-all duration-700 ease-out"
                    style={{ 
                      width: `${stats.total_conversations > 0 
                        ? Math.round((stats.responses_received / stats.total_conversations) * 100) 
                        : 0}%` 
                    }}
                  />
                </div>
                <div className="flex justify-between mt-3 text-sm text-muted-foreground">
                  <span>{stats.responses_received} responses</span>
                  <span>{stats.total_conversations} total</span>
                </div>
              </div>
              
              {/* Seat Info Card */}
              <div className="bg-card rounded-xl p-6 border border-border shadow-sm">
                <h3 className="text-lg font-semibold text-foreground mb-4">Workspace Details</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Workspace</p>
                    <p className="text-foreground font-semibold text-base mt-1">{seat?.name}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="w-2 h-2 rounded-full bg-green-500"></span>
                      <span className="text-foreground font-semibold text-base">Active</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Efficiency</p>
                    <p className="text-foreground font-semibold text-base mt-1">
                      {stats.messages_sent_today > 0 ? 'High' : 'Normal'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Session</p>
                    <p className="text-foreground font-semibold text-base mt-1">Live</p>
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
