import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  Plus, Copy, Trash2, Users, MessageSquare, Send, 
  ExternalLink, RefreshCw, CheckCircle, RotateCcw,
  Link2, MessageCircle, Clock, TrendingUp, Zap
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

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
}

const Seats: React.FC = () => {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [seatStats, setSeatStats] = useState<Map<string, SeatStats>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newSeatName, setNewSeatName] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const fetchSeats = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('seats')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setSeats(data || []);

      // Fetch stats for each seat
      const { data: statsData, error: statsError } = await supabase
        .from('seat_stats')
        .select('*');

      if (!statsError && statsData) {
        const statsMap = new Map<string, SeatStats>();
        statsData.forEach((s: SeatStats) => {
          statsMap.set(s.seat_id, s);
        });
        setSeatStats(statsMap);
      }
    } catch (error) {
      console.error('Error fetching seats:', error);
      toast.error('Failed to load seats');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSeats();
    
    // Subscribe to real-time changes
    const channel = supabase
      .channel('seats-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'seats'
        },
        () => {
          fetchSeats();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchSeats]);

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

  const handleDeleteSeat = async (seatId: string) => {
    if (!confirm('Are you sure you want to delete this seat? This cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('seats')
        .delete()
        .eq('id', seatId);

      if (error) throw error;
      
      toast.success('Seat deleted');
      fetchSeats();
    } catch (error) {
      console.error('Error deleting seat:', error);
      toast.error('Failed to delete seat');
    }
  };

  const handleResetLink = async (seat: Seat) => {
    if (!confirm(`Reset link for "${seat.name}"? The old link will stop working immediately.`)) {
      return;
    }

    try {
      // Generate a new UUID for access_token
      const newToken = crypto.randomUUID();
      
      const { error } = await supabase
        .from('seats')
        .update({ access_token: newToken, updated_at: new Date().toISOString() })
        .eq('id', seat.id);

      if (error) throw error;
      
      toast.success('Link reset successfully. Share the new link with your worker.');
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

  // Calculate totals
  const totalConversations = Array.from(seatStats.values()).reduce((sum, s) => sum + (s.total_conversations || 0), 0);
  const totalSentToday = Array.from(seatStats.values()).reduce((sum, s) => sum + (s.messages_sent_today || 0), 0);
  const totalResponses = Array.from(seatStats.values()).reduce((sum, s) => sum + (s.responses_received || 0), 0);

  return (
    <DashboardLayout>
      <PageHeader 
        title="Worker Seats" 
        description="Create and manage worker seats for chat operations"
      />

      <div className="space-y-6">
        {/* Quick Stats Bar */}
        <div className="flex items-center gap-6 p-4 rounded-xl bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 border border-primary/20">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/20">
              <Users className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{seats.length}</p>
              <p className="text-xs text-muted-foreground">Total Seats</p>
            </div>
          </div>
          <div className="w-px h-10 bg-border" />
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-green-500/20">
              <Zap className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{seats.filter(s => s.is_active).length}</p>
              <p className="text-xs text-muted-foreground">Active</p>
            </div>
          </div>
          <div className="w-px h-10 bg-border" />
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-500/20">
              <MessageCircle className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalConversations}</p>
              <p className="text-xs text-muted-foreground">Conversations</p>
            </div>
          </div>
          <div className="w-px h-10 bg-border" />
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-orange-500/20">
              <Send className="w-5 h-5 text-orange-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalSentToday}</p>
              <p className="text-xs text-muted-foreground">Sent Today</p>
            </div>
          </div>
          <div className="w-px h-10 bg-border" />
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-purple-500/20">
              <TrendingUp className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalResponses}</p>
              <p className="text-xs text-muted-foreground">Responses</p>
            </div>
          </div>
          
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchSeats}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-2">
                  <Plus className="w-4 h-4" />
                  New Seat
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Worker Seat</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="seatName">Seat Name</Label>
                    <Input
                      id="seatName"
                      placeholder="e.g., Worker 1, Sales Team, Support"
                      value={newSeatName}
                      onChange={(e) => setNewSeatName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateSeat()}
                    />
                    <p className="text-xs text-muted-foreground">
                      A unique access link will be generated for this seat
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateSeat}>
                    Create Seat
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Worker Seats Grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : seats.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                <Users className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-1">No Worker Seats Yet</h3>
              <p className="text-sm text-muted-foreground text-center max-w-sm mb-6">
                Create your first seat to generate a unique link for your workers to access the chat interface
              </p>
              <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
                <Plus className="w-4 h-4" />
                Create First Seat
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {seats.map((seat) => {
              const stats = seatStats.get(seat.id);
              const isActive = seat.is_active;
              
              return (
                <Card 
                  key={seat.id} 
                  className={`relative overflow-hidden transition-all hover:shadow-lg ${
                    isActive 
                      ? 'border-primary/30 bg-gradient-to-br from-card to-primary/5' 
                      : 'opacity-60 border-muted'
                  }`}
                >
                  {/* Status indicator bar */}
                  <div className={`absolute top-0 left-0 right-0 h-1 ${isActive ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                  
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold ${
                          isActive 
                            ? 'bg-primary text-primary-foreground' 
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {seat.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <CardTitle className="text-base">{seat.name}</CardTitle>
                          <CardDescription className="flex items-center gap-1 text-xs">
                            <Clock className="w-3 h-3" />
                            Created {format(new Date(seat.created_at), 'MMM d, yyyy')}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={seat.is_active}
                          onCheckedChange={() => handleToggleActive(seat)}
                        />
                        <Badge 
                          variant={isActive ? "default" : "secondary"}
                          className={isActive ? 'bg-green-500/20 text-green-600 border-green-500/30' : ''}
                        >
                          {isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  
                  <CardContent className="space-y-4">
                    {/* Stats Grid */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <MessageSquare className="w-4 h-4 mx-auto mb-1 text-blue-500" />
                        <p className="text-lg font-bold">{stats?.total_conversations || 0}</p>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Chats</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <Send className="w-4 h-4 mx-auto mb-1 text-orange-500" />
                        <p className="text-lg font-bold">{stats?.messages_sent_today || 0}</p>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Sent</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <TrendingUp className="w-4 h-4 mx-auto mb-1 text-purple-500" />
                        <p className="text-lg font-bold">{stats?.responses_received || 0}</p>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Replies</p>
                      </div>
                    </div>
                    
                    {/* Link Section */}
                    <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                      <div className="flex items-center gap-2 mb-2">
                        <Link2 className="w-4 h-4 text-primary" />
                        <span className="text-xs font-medium">Access Link</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input 
                          value={getSeatLink(seat)} 
                          readOnly 
                          className="text-xs h-8 bg-background/50 font-mono"
                        />
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
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
                            </TooltipTrigger>
                            <TooltipContent>Copy Link</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>
                    
                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-2">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1 gap-2"
                        onClick={() => openSeatPreview(seat)}
                      >
                        <ExternalLink className="w-4 h-4" />
                        Open Chat
                      </Button>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8 text-orange-500 hover:text-orange-600 hover:border-orange-500/50"
                              onClick={() => handleResetLink(seat)}
                            >
                              <RotateCcw className="w-4 h-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Reset Link</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive hover:border-destructive/50"
                              onClick={() => handleDeleteSeat(seat.id)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete Seat</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* How it works - Compact */}
        <Card className="bg-muted/30">
          <CardContent className="py-4">
            <div className="flex items-center gap-8">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">1</div>
                <div className="text-sm">
                  <span className="font-medium">Create</span>
                  <span className="text-muted-foreground ml-1">a seat for your worker</span>
                </div>
              </div>
              <div className="text-muted-foreground">→</div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">2</div>
                <div className="text-sm">
                  <span className="font-medium">Share</span>
                  <span className="text-muted-foreground ml-1">the unique link</span>
                </div>
              </div>
              <div className="text-muted-foreground">→</div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
                <div className="text-sm">
                  <span className="font-medium">Workers chat</span>
                  <span className="text-muted-foreground ml-1">with assigned conversations</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default Seats;
