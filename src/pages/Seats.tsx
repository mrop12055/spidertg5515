import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Plus, Copy, Trash2, Users, MessageSquare, Send, Eye, 
  ExternalLink, RefreshCw, CheckCircle, RotateCcw 
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

  return (
    <DashboardLayout>
      <PageHeader 
        title="Seats Management" 
        description="Create and manage worker seats for chat operations"
      />

      <div className="space-y-6">
        {/* Overview Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
        </div>

        {/* Seats Table */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Worker Seats</CardTitle>
              <CardDescription>Share seat links with your workers for chat operations</CardDescription>
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
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create New Seat</DialogTitle>
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
                        A unique link will be generated for this seat
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
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : seats.length === 0 ? (
              <div className="text-center py-8">
                <Users className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-lg font-medium">No seats created yet</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Create your first seat to share with workers
                </p>
                <Button onClick={() => setIsCreateOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Seat
                </Button>
              </div>
            ) : (
              <ScrollArea className="h-[400px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Conversations</TableHead>
                      <TableHead>Sent Today</TableHead>
                      <TableHead>Responses</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {seats.map((seat) => {
                      const stats = seatStats.get(seat.id);
                      return (
                        <TableRow key={seat.id}>
                          <TableCell className="font-medium">{seat.name}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={seat.is_active}
                                onCheckedChange={() => handleToggleActive(seat)}
                              />
                              <Badge variant={seat.is_active ? "default" : "secondary"}>
                                {seat.is_active ? 'Active' : 'Inactive'}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>{stats?.total_conversations || 0}</TableCell>
                          <TableCell>{stats?.messages_sent_today || 0}</TableCell>
                          <TableCell>{stats?.responses_received || 0}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {format(new Date(seat.created_at), 'MMM d, yyyy')}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => copyToClipboard(getSeatLink(seat), seat.id)}
                                title="Copy link"
                              >
                                {copiedToken === seat.id ? (
                                  <CheckCircle className="w-4 h-4 text-green-500" />
                                ) : (
                                  <Copy className="w-4 h-4" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openSeatPreview(seat)}
                                title="Open in new tab"
                              >
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleResetLink(seat)}
                                className="text-orange-500 hover:text-orange-600"
                                title="Reset link"
                              >
                                <RotateCcw className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteSeat(seat.id)}
                                className="text-destructive hover:text-destructive"
                                title="Delete seat"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

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
    </DashboardLayout>
  );
};

export default Seats;
