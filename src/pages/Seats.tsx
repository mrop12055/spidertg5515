import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Plus, Copy, Trash2, Users, MessageSquare, Send, Eye, 
  ExternalLink, RefreshCw, CheckCircle, RotateCcw, Sparkles, Link2, AlertTriangle, Clock, TrendingUp
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { motion } from 'framer-motion';

interface Seat {
  id: string;
  name: string;
  access_token: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface SeatStats {
  seat_id: string;
  seat_name: string;
  total_conversations: number;
  messages_sent_today: number;
  messages_read: number;
  responses_received: number;
  responses_today: number;
}

interface PendingRepliesMap {
  [seatId: string]: number;
}

interface UnreadRepliesMap {
  [seatId: string]: number;
}

const Seats: React.FC = () => {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [seatStats, setSeatStats] = useState<Map<string, SeatStats>>(new Map());
  const [pendingReplies, setPendingReplies] = useState<PendingRepliesMap>({});
  const [unreadReplies, setUnreadReplies] = useState<UnreadRepliesMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newSeatName, setNewSeatName] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Seat | null>(null);
  const [resetConfirm, setResetConfirm] = useState<Seat | null>(null);

  const fetchSeats = useCallback(async () => {
    try {
      // PARALLEL: Run all 4 queries simultaneously instead of sequentially
      const [seatsResult, statsResult, pendingResult, unreadResult] = await Promise.all([
        supabase
          .from('seats')
          .select('*')
          .order('created_at', { ascending: false }),
        supabase
          .from('seat_stats')
          .select('*'),
        supabase
          .from('campaign_recipients')
          .select('seat_id')
          .eq('status', 'pending')
          .not('seat_id', 'is', null),
        supabase
          .from('conversations')
          .select('id, seat_id')
          .eq('has_reply', true)
          .gt('unread_count', 0)
          .not('seat_id', 'is', null),
      ]);

      if (seatsResult.error) throw seatsResult.error;
      setSeats(seatsResult.data || []);

      if (!statsResult.error && statsResult.data) {
        const statsMap = new Map<string, SeatStats>();
        statsResult.data.forEach((s: SeatStats) => {
          statsMap.set(s.seat_id, s);
        });
        setSeatStats(statsMap);
      }

      if (!pendingResult.error && pendingResult.data) {
        const pendingMap: PendingRepliesMap = {};
        pendingResult.data.forEach((r) => {
          if (r.seat_id) {
            pendingMap[r.seat_id] = (pendingMap[r.seat_id] || 0) + 1;
          }
        });
        setPendingReplies(pendingMap);
      }

      if (!unreadResult.error && unreadResult.data) {
        const unreadMap: UnreadRepliesMap = {};
        const seenConversations = new Set<string>();
        unreadResult.data.forEach((c) => {
          if (c.seat_id && c.id && !seenConversations.has(c.id)) {
            seenConversations.add(c.id);
            unreadMap[c.seat_id] = (unreadMap[c.seat_id] || 0) + 1;
          }
        });
        setUnreadReplies(unreadMap);
      }
    } catch (error) {
      console.error('Error fetching seats:', error);
      toast.error('Failed to load seats');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Debounced stats refetch for realtime events
  const statsDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedStatsRefetch = useCallback(() => {
    if (statsDebounceRef.current) clearTimeout(statsDebounceRef.current);
    statsDebounceRef.current = setTimeout(async () => {
      const { data, error } = await supabase.from('seat_stats').select('*');
      if (!error && data) {
        const statsMap = new Map<string, SeatStats>();
        data.forEach((s: SeatStats) => statsMap.set(s.seat_id, s));
        setSeatStats(statsMap);
      }
    }, 2000);
  }, []);

  useEffect(() => {
    fetchSeats();
    
    // Realtime: seats table changes
    const seatsChannel = supabase
      .channel('seats-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'seats' },
        () => { fetchSeats(); }
      )
      .subscribe();

    // Realtime: conversations changes → update unreadReplies incrementally + debounce stats
    const convsChannel = supabase
      .channel('seats-conversations-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (payload) => {
          if (payload.eventType === 'UPDATE') {
            const c = payload.new as any;
            if (c.seat_id && c.has_reply) {
              setUnreadReplies(prev => {
                const newMap = { ...prev };
                // Recalculate would be expensive; just adjust based on unread_count
                // If unread_count > 0, ensure seat is counted; if 0, we need a full recount
                // For simplicity, debounce a full stats refetch
                return newMap;
              });
            }
          }
          debouncedStatsRefetch();
        }
      )
      .subscribe();

    // Realtime: campaign_recipients changes → update pendingReplies + debounce stats
    const recipientsChannel = supabase
      .channel('seats-recipients-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaign_recipients' },
        (payload) => {
          if (payload.eventType === 'UPDATE') {
            const r = payload.new as any;
            const oldR = payload.old as any;
            if (r.seat_id) {
              setPendingReplies(prev => {
                const newMap = { ...prev };
                // If status changed from pending → something else, decrement
                if (oldR?.status === 'pending' && r.status !== 'pending') {
                  newMap[r.seat_id] = Math.max(0, (newMap[r.seat_id] || 0) - 1);
                }
                // If status changed to pending, increment
                if (oldR?.status !== 'pending' && r.status === 'pending') {
                  newMap[r.seat_id] = (newMap[r.seat_id] || 0) + 1;
                }
                return newMap;
              });
            }
          } else if (payload.eventType === 'INSERT') {
            const r = payload.new as any;
            if (r.seat_id && r.status === 'pending') {
              setPendingReplies(prev => ({
                ...prev,
                [r.seat_id]: (prev[r.seat_id] || 0) + 1,
              }));
            }
          }
          debouncedStatsRefetch();
        }
      )
      .subscribe();

    return () => {
      if (statsDebounceRef.current) clearTimeout(statsDebounceRef.current);
      supabase.removeChannel(seatsChannel);
      supabase.removeChannel(convsChannel);
      supabase.removeChannel(recipientsChannel);
    };
  }, [fetchSeats, debouncedStatsRefetch]);

  const handleCreateSeat = async () => {
    if (!newSeatName.trim()) {
      toast.error('Please enter a seat name');
      return;
    }

    try {
      const { data, error } = await supabase
        .from('seats')
        .insert({ name: newSeatName.trim() })
        .select()
        .single();

      if (error) throw error;

      toast.success('Seat created successfully');
      setNewSeatName('');
      setIsCreateOpen(false);
      fetchSeats();
    } catch (error) {
      console.error('Error creating seat:', error);
      toast.error('Failed to create seat');
    }
  };

  const handleToggleActive = async (seat: Seat) => {
    try {
      const { error } = await supabase
        .from('seats')
        .update({ is_active: !seat.is_active, updated_at: new Date().toISOString() })
        .eq('id', seat.id);

      if (error) throw error;
      
      toast.success(seat.is_active ? 'Seat deactivated' : 'Seat activated');
      fetchSeats();
    } catch (error) {
      console.error('Error toggling seat:', error);
      toast.error('Failed to update seat');
    }
  };

const handleDeleteSeat = async (seat: Seat) => {
    try {
      const { error } = await supabase
        .from('seats')
        .delete()
        .eq('id', seat.id);

      if (error) throw error;
      
      toast.success('Seat deleted successfully');
      setDeleteConfirm(null);
      fetchSeats();
    } catch (error) {
      console.error('Error deleting seat:', error);
      toast.error('Failed to delete seat');
    }
  };

  const handleResetLink = async (seat: Seat) => {
    try {
      // Generate a new UUID for access_token
      const newToken = crypto.randomUUID();
      
      const { error } = await supabase
        .from('seats')
        .update({ access_token: newToken, updated_at: new Date().toISOString() })
        .eq('id', seat.id);

      if (error) throw error;
      
      toast.success('Link reset successfully');
      setResetConfirm(null);
      fetchSeats();
    } catch (error) {
      console.error('Error resetting link:', error);
      toast.error('Failed to reset link');
    }
  };

  const getSeatLink = (seat: Seat) => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/seat/${seat.access_token}`;
  };

  const copyToClipboard = async (text: string, tokenId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedToken(tokenId);
      toast.success('Link copied to clipboard');
      setTimeout(() => setCopiedToken(null), 2000);
    } catch (error) {
      toast.error('Failed to copy');
    }
  };

  const openSeatPreview = (seat: Seat) => {
    window.open(getSeatLink(seat), '_blank');
  };

  return (
    <DashboardLayout>
      <PageHeader 
        title="Seats Management" 
        description="Create and manage worker seats for chat operations"
        icon={Users}
      />

      <div className="space-y-6">
        {/* Overview Stats */}
        <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/20">
                  <Users className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{seats.length}</p>
                  <p className="text-sm text-muted-foreground">Total Seats</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-green-500/10 to-green-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/20">
                  <CheckCircle className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{seats.filter(s => s.is_active).length}</p>
                  <p className="text-sm text-muted-foreground">Active Seats</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-blue-500/10 to-blue-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/20">
                  <MessageSquare className="w-5 h-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {Array.from(seatStats.values()).reduce((sum, s) => sum + s.total_conversations, 0)}
                  </p>
                  <p className="text-sm text-muted-foreground">Total Conversations</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-orange-500/10 to-orange-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/20">
                  <Send className="w-5 h-5 text-orange-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {Array.from(seatStats.values()).reduce((sum, s) => sum + s.messages_sent_today, 0)}
                  </p>
                  <p className="text-sm text-muted-foreground">Sent Today</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-violet-500/10 to-violet-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-violet-500/20">
                  <MessageSquare className="w-5 h-5 text-violet-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {Array.from(seatStats.values()).reduce((sum, s) => sum + (s.responses_today || 0), 0)}
                  </p>
                  <p className="text-sm text-muted-foreground">Replies Today</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className={`bg-gradient-to-br ${
            (() => {
              const totalSent = Array.from(seatStats.values()).reduce((sum, s) => sum + s.messages_sent_today, 0);
              const totalReplies = Array.from(seatStats.values()).reduce((sum, s) => sum + (s.responses_today || 0), 0);
              const rate = totalSent > 0 ? (totalReplies / totalSent) * 100 : 0;
              return rate >= 5 ? 'from-green-500/10 to-green-500/5' : 'from-amber-500/10 to-amber-500/5';
            })()
          }`}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${
                  (() => {
                    const totalSent = Array.from(seatStats.values()).reduce((sum, s) => sum + s.messages_sent_today, 0);
                    const totalReplies = Array.from(seatStats.values()).reduce((sum, s) => sum + (s.responses_today || 0), 0);
                    const rate = totalSent > 0 ? (totalReplies / totalSent) * 100 : 0;
                    return rate >= 5 ? 'bg-green-500/20' : 'bg-amber-500/20';
                  })()
                }`}>
                  <TrendingUp className={`w-5 h-5 ${
                    (() => {
                      const totalSent = Array.from(seatStats.values()).reduce((sum, s) => sum + s.messages_sent_today, 0);
                      const totalReplies = Array.from(seatStats.values()).reduce((sum, s) => sum + (s.responses_today || 0), 0);
                      const rate = totalSent > 0 ? (totalReplies / totalSent) * 100 : 0;
                      return rate >= 5 ? 'text-green-500' : 'text-amber-500';
                    })()
                  }`} />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {(() => {
                      const totalSent = Array.from(seatStats.values()).reduce((sum, s) => sum + s.messages_sent_today, 0);
                      const totalReplies = Array.from(seatStats.values()).reduce((sum, s) => sum + (s.responses_today || 0), 0);
                      return totalSent > 0 ? ((totalReplies / totalSent) * 100).toFixed(1) : '0.0';
                    })()}%
                  </p>
                  <p className="text-sm text-muted-foreground">Reply Rate</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Seats Grid */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Static Logo - no animation to prevent blinking */}
              <div className="relative">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary via-primary/80 to-violet-600 shadow-lg shadow-primary/25 flex items-center justify-center">
                  <Users className="w-7 h-7 text-white" />
                  {/* Static particles */}
                  <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-green-400 opacity-80" />
                  <div className="absolute -bottom-1 -left-1 w-2 h-2 rounded-full bg-violet-400 opacity-70" />
                </div>
                
                {/* Glow effect */}
                <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/40 to-violet-600/40 blur-xl -z-10" />
              </div>
              
              <div>
                <h2 className="text-xl font-semibold">Worker Seats</h2>
                <p className="text-sm text-muted-foreground">Share seat links with your workers for chat operations</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={fetchSeats}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
              <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="w-4 h-4 mr-2" />
                    Create Seat
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader className="text-center sm:text-center">
                    <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-violet-600 flex items-center justify-center mb-4">
                      <Sparkles className="w-8 h-8 text-white" />
                    </div>
                    <DialogTitle className="text-xl">Create New Seat</DialogTitle>
                    <DialogDescription>
                      Set up a workspace for your team member
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-3">
                      <Label htmlFor="seatName" className="text-sm font-medium">Seat Name</Label>
                      <Input
                        id="seatName"
                        placeholder="e.g., Worker 1, Sales Team, Support"
                        value={newSeatName}
                        onChange={(e) => setNewSeatName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleCreateSeat()}
                        className="h-11"
                      />
                    </div>
                    <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                      <div className="flex items-center gap-2 text-sm">
                        <Link2 className="w-4 h-4 text-primary" />
                        <span className="font-medium">Unique access link generated</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Share this link with your worker to give them access to their chat workspace
                      </p>
                    </div>
                  </div>
                  <DialogFooter className="gap-2 sm:gap-0">
                    <Button variant="outline" onClick={() => setIsCreateOpen(false)} className="flex-1 sm:flex-none">
                      Cancel
                    </Button>
                    <Button onClick={handleCreateSeat} className="flex-1 sm:flex-none bg-gradient-to-r from-primary to-violet-600 hover:from-primary/90 hover:to-violet-600/90">
                      <Plus className="w-4 h-4 mr-2" />
                      Create Seat
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : seats.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                  <Users className="w-8 h-8 text-muted-foreground" />
                </div>
                <p className="text-lg font-medium mb-1">No seats created yet</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Create your first seat to share with workers
                </p>
                <Button onClick={() => setIsCreateOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Seat
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {seats.map((seat) => {
                const stats = seatStats.get(seat.id);
                return (
                  <Card 
                    key={seat.id} 
                    className={`relative overflow-hidden transition-all hover:shadow-lg ${
                      seat.is_active 
                        ? 'border-primary/30 bg-gradient-to-br from-primary/5 to-transparent' 
                        : 'opacity-60'
                    }`}
                  >
                    {/* Status indicator bar */}
                    <div className={`absolute top-0 left-0 right-0 h-1 ${
                      seat.is_active ? 'bg-gradient-to-r from-green-500 to-emerald-400' : 'bg-muted'
                    }`} />
                    
                    <CardContent className="pt-6">
                      {/* Header */}
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold ${
                            seat.is_active 
                              ? 'bg-gradient-to-br from-primary to-primary/70 text-primary-foreground' 
                              : 'bg-muted text-muted-foreground'
                          }`}>
                            {seat.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <h3 className="font-semibold text-lg">{seat.name}</h3>
                            <p className="text-xs text-muted-foreground">
                              Created {format(new Date(seat.created_at), 'MMM d, yyyy')}
                            </p>
                          </div>
                        </div>
                        <motion.button
                          onClick={() => handleToggleActive(seat)}
                          className={`relative flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300 ${
                            seat.is_active 
                              ? 'bg-green-500/15 text-green-600 hover:bg-green-500/25' 
                              : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          }`}
                          whileTap={{ scale: 0.95 }}
                        >
                          <div
                            className={`w-2 h-2 rounded-full ${
                              seat.is_active ? 'bg-green-500' : 'bg-muted-foreground/50'
                            }`}
                          />
                          <span>{seat.is_active ? 'Active' : 'Inactive'}</span>
                        </motion.button>
                      </div>

                      {/* Stats Grid */}
                      <div className="grid grid-cols-6 gap-1.5 mb-4">
                        <div className="bg-muted/50 rounded-lg p-2 text-center">
                          <p className="text-sm font-bold">{stats?.total_conversations || 0}</p>
                          <p className="text-[8px] text-muted-foreground uppercase tracking-wide">Chats</p>
                        </div>
                        <div className="bg-muted/50 rounded-lg p-2 text-center">
                          <p className="text-sm font-bold">{stats?.messages_sent_today || 0}</p>
                          <p className="text-[8px] text-muted-foreground uppercase tracking-wide">Sent</p>
                        </div>
                        <div className="bg-muted/50 rounded-lg p-2 text-center">
                          <p className="text-sm font-bold">{stats?.responses_today || 0}</p>
                          <p className="text-[8px] text-muted-foreground uppercase tracking-wide">Today</p>
                        </div>
                        <div className="bg-muted/50 rounded-lg p-2 text-center">
                          <p className="text-sm font-bold">{stats?.responses_received || 0}</p>
                          <p className="text-[8px] text-muted-foreground uppercase tracking-wide">Replies</p>
                        </div>
                        <div className={`rounded-lg p-2 text-center ${
                          ((stats?.responses_today || 0) / (stats?.messages_sent_today || 1) * 100) >= 5
                            ? 'bg-green-500/10 border border-green-500/30'
                            : 'bg-muted/50'
                        }`}>
                          <p className={`text-sm font-bold ${
                            ((stats?.responses_today || 0) / (stats?.messages_sent_today || 1) * 100) >= 5
                              ? 'text-green-600'
                              : ''
                          }`}>
                            {stats?.messages_sent_today 
                              ? ((stats.responses_today || 0) / stats.messages_sent_today * 100).toFixed(1)
                              : '0.0'}%
                          </p>
                          <p className="text-[8px] text-muted-foreground uppercase tracking-wide">Rate</p>
                        </div>
                        <div className={`rounded-lg p-2 text-center ${
                          (unreadReplies[seat.id] || 0) > 0 
                            ? 'bg-red-500/10 border border-red-500/30' 
                            : 'bg-muted/50'
                        }`}>
                          <div className="flex items-center justify-center gap-0.5">
                            {(unreadReplies[seat.id] || 0) > 0 && (
                              <MessageSquare className="w-2.5 h-2.5 text-red-500" />
                            )}
                            <p className={`text-sm font-bold ${
                              (unreadReplies[seat.id] || 0) > 0 ? 'text-red-500' : ''
                            }`}>
                              {unreadReplies[seat.id] || 0}
                            </p>
                          </div>
                          <p className="text-[8px] text-muted-foreground uppercase tracking-wide">Unseen</p>
                        </div>
                      </div>

                      {/* Link section */}
                      <div className="bg-muted/30 rounded-lg p-3 mb-4">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Seat Link</p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 truncate border">
                            {getSeatLink(seat)}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => copyToClipboard(getSeatLink(seat), seat.id)}
                          >
                            {copiedToken === seat.id ? (
                              <CheckCircle className="w-4 h-4 text-green-500" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </Button>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => openSeatPreview(seat)}
                        >
                          <ExternalLink className="w-4 h-4 mr-2" />
                          Open
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-orange-500 hover:text-orange-600 hover:bg-orange-500/10"
                          onClick={() => setResetConfirm(seat)}
                          title="Reset link"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteConfirm(seat)}
                          title="Delete seat"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* How it works */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How Seats Work</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-3 gap-4 text-sm">
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold flex-shrink-0">
                  1
                </div>
                <div>
                  <p className="font-medium">Create a Seat</p>
                  <p className="text-muted-foreground">Give it a name for your worker or team</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold flex-shrink-0">
                  2
                </div>
                <div>
                  <p className="font-medium">Share the Link</p>
                  <p className="text-muted-foreground">Copy and share the unique link with your worker</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold flex-shrink-0">
                  3
                </div>
                <div>
                  <p className="font-medium">Workers Chat</p>
                  <p className="text-muted-foreground">Workers only see chats & stats for their seat</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-center sm:text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
              <AlertTriangle className="w-8 h-8 text-destructive" />
            </div>
            <AlertDialogTitle className="text-xl">Delete Seat?</AlertDialogTitle>
            <AlertDialogDescription className="text-center">
              Are you sure you want to delete <span className="font-semibold text-foreground">"{deleteConfirm?.name}"</span>? 
              This action cannot be undone and the access link will stop working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0 mt-4">
            <AlertDialogCancel className="flex-1 sm:flex-none">Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => deleteConfirm && handleDeleteSeat(deleteConfirm)}
              className="flex-1 sm:flex-none bg-destructive hover:bg-destructive/90"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete Seat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset Link Confirmation Dialog */}
      <AlertDialog open={!!resetConfirm} onOpenChange={(open) => !open && setResetConfirm(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-center sm:text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-orange-500/10 flex items-center justify-center mb-4">
              <RotateCcw className="w-8 h-8 text-orange-500" />
            </div>
            <AlertDialogTitle className="text-xl">Reset Access Link?</AlertDialogTitle>
            <AlertDialogDescription className="text-center">
              The current link for <span className="font-semibold text-foreground">"{resetConfirm?.name}"</span> will stop working immediately. 
              You'll need to share the new link with your worker.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0 mt-4">
            <AlertDialogCancel className="flex-1 sm:flex-none">Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => resetConfirm && handleResetLink(resetConfirm)}
              className="flex-1 sm:flex-none bg-orange-500 hover:bg-orange-600"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Reset Link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
};

export default Seats;
