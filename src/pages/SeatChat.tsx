import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { 
  Send, MessageSquare, Users, Eye, CheckCheck, Check, 
  RefreshCw, AlertCircle, Clock
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { format, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';

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
  recipient_avatar: string | null;
  unread_count: number;
  last_message_at: string | null;
  is_active: boolean;
  seat_id: string | null;
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
  const [stats, setStats] = useState<SeatStats>({
    total_conversations: 0,
    messages_sent_today: 0,
    messages_read: 0,
    responses_received: 0
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        .eq('first_message_sent', true)
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
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
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
    if (!messageInput.trim() || !selectedConversation || isSending) return;

    setIsSending(true);
    try {
      const { error } = await supabase
        .from('messages')
        .insert({
          conversation_id: selectedConversation.id,
          account_id: selectedConversation.account_id,
          content: messageInput.trim(),
          direction: 'outgoing',
          status: 'pending',
          priority: 10  // High priority for seat messages - picked up faster than campaigns
        });

      if (error) throw error;
      
      setMessageInput('');
      fetchMessages();
    } catch (err) {
      console.error('Error sending message:', err);
      toast.error('Failed to send message');
    } finally {
      setIsSending(false);
    }
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
        return <CheckCheck className="w-3 h-3 text-blue-500" />;
      case 'delivered':
        return <CheckCheck className="w-3 h-3 text-muted-foreground" />;
      case 'sent':
        return <Check className="w-3 h-3 text-muted-foreground" />;
      case 'pending':
        return <Clock className="w-3 h-3 text-muted-foreground" />;
      case 'failed':
        return <AlertCircle className="w-3 h-3 text-destructive" />;
      default:
        return null;
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-500">Loading seat...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Card className="max-w-md bg-white border-slate-200 shadow-lg">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2 text-slate-800">Access Error</h2>
            <p className="text-slate-500">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b bg-white shadow-sm">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-blue-500 flex items-center justify-center shadow-md">
                <Send className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="font-bold text-lg text-slate-900">{seat?.name}</h1>
                <p className="text-xs text-slate-500">Chat Workspace</p>
              </div>
            </div>
            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
              ● Online
            </Badge>
          </div>
        </div>
      </header>

      {/* Stats Bar */}
      <div className="border-b bg-white">
        <div className="container mx-auto px-4 py-2.5">
          <div className="flex gap-6 text-sm">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-slate-800">{stats.total_conversations}</span>
              <span className="text-slate-500">Conversations</span>
            </div>
            <div className="flex items-center gap-2">
              <Send className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-slate-800">{stats.messages_sent_today}</span>
              <span className="text-slate-500">Sent Today</span>
            </div>
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-slate-800">{stats.messages_read}</span>
              <span className="text-slate-500">Read</span>
            </div>
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-slate-400" />
              <span className="font-semibold text-slate-800">{stats.responses_received}</span>
              <span className="text-slate-500">Responses</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="container mx-auto px-4 py-4">
        <div className="grid grid-cols-12 gap-4 h-[calc(100vh-180px)]">
          {/* Conversation List */}
          <div className="col-span-4 lg:col-span-3">
            <Card className="h-full flex flex-col bg-white border-slate-200 shadow-sm">
              <CardHeader className="py-3 px-4 bg-slate-50/50">
                <CardTitle className="text-sm font-semibold text-slate-700">Conversations</CardTitle>
              </CardHeader>
              <Separator className="bg-slate-100" />
              <ScrollArea className="flex-1">
                {conversations.length === 0 ? (
                  <div className="p-4 text-center text-slate-400 text-sm">
                    No conversations yet
                  </div>
                ) : (
                  <div className="space-y-1 p-2">
                    {conversations.map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => setSelectedConversation(conv)}
                        className={cn(
                          "w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left",
                          selectedConversation?.id === conv.id
                            ? "bg-blue-50 border border-blue-200"
                            : "hover:bg-slate-50 border border-transparent"
                        )}
                      >
                        <Avatar className="w-10 h-10 border-2 border-white shadow-sm">
                          <AvatarImage src={conv.recipient_avatar || ''} />
                          <AvatarFallback className="bg-gradient-to-br from-blue-500 to-blue-600 text-white text-sm font-medium">
                            {(conv.recipient_name || conv.recipient_phone || '?')[0].toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <p className="font-medium text-sm truncate text-slate-800">
                              {conv.recipient_name || conv.recipient_phone || 'Unknown'}
                            </p>
                            {conv.unread_count > 0 && (
                              <Badge className="bg-blue-600 text-white text-xs px-1.5 min-w-[20px] h-5 shadow-sm">
                                {conv.unread_count}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 truncate">
                            {conv.recipient_phone}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </Card>
          </div>

          {/* Message Area */}
          <div className="col-span-8 lg:col-span-9">
            <Card className="h-full flex flex-col bg-white border-slate-200 shadow-sm">
              {selectedConversation ? (
                <>
                  {/* Chat Header */}
                  <CardHeader className="py-3 px-4 border-b border-slate-100 bg-slate-50/50">
                    <div className="flex items-center gap-3">
                      <Avatar className="border-2 border-white shadow-sm">
                        <AvatarImage src={selectedConversation.recipient_avatar || ''} />
                        <AvatarFallback className="bg-gradient-to-br from-blue-500 to-blue-600 text-white font-medium">
                          {(selectedConversation.recipient_name || selectedConversation.recipient_phone || '?')[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-semibold text-slate-800">
                          {selectedConversation.recipient_name || selectedConversation.recipient_phone || 'Unknown'}
                        </p>
                        <p className="text-xs text-slate-400">
                          {selectedConversation.recipient_phone}
                        </p>
                      </div>
                    </div>
                  </CardHeader>

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto p-4 bg-slate-50/30" style={{ maxHeight: 'calc(100vh - 340px)' }}>
                    <div className="space-y-3 min-h-full flex flex-col justify-end">
                      {messages.length === 0 ? (
                        <div className="flex items-center justify-center text-slate-400 text-sm py-8">
                          No messages yet. Start the conversation!
                        </div>
                      ) : (
                        messages.map((msg) => (
                          <div
                            key={msg.id}
                            className={cn(
                              "flex animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
                              msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'
                            )}
                          >
                            <div
                              className={cn(
                                "max-w-[70%] rounded-2xl px-4 py-2.5 shadow-sm",
                                msg.direction === 'outgoing'
                                  ? 'bg-blue-600 text-white rounded-br-md'
                                  : 'bg-white border border-slate-100 text-slate-800 rounded-bl-md'
                              )}
                            >
                              {msg.media_url && (
                                <img
                                  src={msg.media_url}
                                  alt="Media"
                                  className="max-w-full rounded-lg mb-2"
                                />
                              )}
                              <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                              <div className={cn(
                                "flex items-center gap-1 mt-1",
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

                  {/* Message Input */}
                  <div className="p-4 border-t border-slate-100 bg-white">
                    <div className="flex gap-2">
                      <Input
                        placeholder="Type a message..."
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                        disabled={isSending}
                        className="bg-slate-50 border-slate-200 focus:border-blue-400 focus:ring-blue-400"
                      />
                      <Button 
                        onClick={handleSendMessage} 
                        disabled={!messageInput.trim() || isSending}
                        className="bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center bg-slate-50/50">
                  <div className="text-center text-slate-400">
                    <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p className="font-medium">Select a conversation to start chatting</p>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SeatChat;
