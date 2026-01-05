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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  Plus, Copy, Trash2, Users, MessageSquare, Send, 
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
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 animate-fade-in">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-primary/20 ring-2 ring-primary/10">
                  <Users className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{seats.length}</p>
                  <p className="text-sm text-muted-foreground">Total Seats</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-green-500/10 to-green-500/5 border-green-500/20 hover:shadow-lg hover:shadow-green-500/5 transition-all duration-300 animate-fade-in" style={{ animationDelay: '50ms' }}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-green-500/20 ring-2 ring-green-500/10">
                  <CheckCircle className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{seats.filter(s => s.is_active).length}</p>
                  <p className="text-sm text-muted-foreground">Active Seats</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border-blue-500/20 hover:shadow-lg hover:shadow-blue-500/5 transition-all duration-300 animate-fade-in" style={{ animationDelay: '100ms' }}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-blue-500/20 ring-2 ring-blue-500/10">
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
          
          <Card className="bg-gradient-to-br from-orange-500/10 to-orange-500/5 border-orange-500/20 hover:shadow-lg hover:shadow-orange-500/5 transition-all duration-300 animate-fade-in" style={{ animationDelay: '150ms' }}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-orange-500/20 ring-2 ring-orange-500/10">
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
        <Card className="border-border/50 shadow-sm animate-fade-in overflow-hidden" style={{ animationDelay: '200ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-4 bg-gradient-to-r from-muted/50 to-transparent border-b border-border/50">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-primary/10 ring-1 ring-primary/20">
                <Users className="w-5 h-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg font-semibold">Worker Seats</CardTitle>
                <CardDescription className="text-sm">Share seat links with your workers for chat operations</CardDescription>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={fetchSeats} className="hover:bg-muted/80 transition-colors border-border/60">
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
              <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="shadow-sm hover:shadow-md transition-all bg-primary hover:bg-primary/90">
                    <Plus className="w-4 h-4 mr-2" />
                    Create Seat
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
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
                        className="focus-visible:ring-primary"
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
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : seats.length === 0 ? (
              <div className="text-center py-16 px-4">
                <div className="w-16 h-16 mx-auto rounded-full bg-muted/50 flex items-center justify-center mb-4">
                  <Users className="w-8 h-8 text-muted-foreground/50" />
                </div>
                <p className="text-lg font-medium">No seats created yet</p>
                <p className="text-sm text-muted-foreground mb-6">
                  Create your first seat to share with workers
                </p>
                <Button onClick={() => setIsCreateOpen(true)} className="shadow-sm">
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Seat
                </Button>
              </div>
            ) : (
              <ScrollArea className="h-[450px]">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableHead className="font-semibold">Name</TableHead>
                      <TableHead className="font-semibold">Status</TableHead>
                      <TableHead className="font-semibold">Conversations</TableHead>
                      <TableHead className="font-semibold">Sent Today</TableHead>
                      <TableHead className="font-semibold">Responses</TableHead>
                      <TableHead className="font-semibold">Created</TableHead>
                      <TableHead className="text-right font-semibold">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {seats.map((seat, index) => {
                      const stats = seatStats.get(seat.id);
                      return (
                        <TableRow 
                          key={seat.id} 
                          className="group hover:bg-muted/50 transition-colors animate-fade-in"
                          style={{ animationDelay: `${index * 30}ms` }}
                        >
                          <TableCell className="font-medium">{seat.name}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={seat.is_active}
                                onCheckedChange={() => handleToggleActive(seat)}
                                className="data-[state=checked]:bg-primary"
                              />
                              <Badge 
                                variant={seat.is_active ? "default" : "secondary"}
                                className={seat.is_active ? "bg-primary/90 hover:bg-primary" : ""}
                              >
                                {seat.is_active ? 'Active' : 'Inactive'}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums">{stats?.total_conversations || 0}</TableCell>
                          <TableCell className="tabular-nums">{stats?.messages_sent_today || 0}</TableCell>
                          <TableCell className="tabular-nums">{stats?.responses_received || 0}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {format(new Date(seat.created_at), 'MMM d, yyyy')}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => copyToClipboard(getSeatLink(seat), seat.id)}
                                    className="h-8 w-8 hover:bg-muted"
                                  >
                                    {copiedToken === seat.id ? (
                                      <CheckCircle className="w-4 h-4 text-green-500" />
                                    ) : (
                                      <Copy className="w-4 h-4" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copy link</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openSeatPreview(seat)}
                                    className="h-8 w-8 hover:bg-muted"
                                  >
                                    <ExternalLink className="w-4 h-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Open in new tab</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleResetLink(seat)}
                                    className="h-8 w-8 text-orange-500 hover:text-orange-600 hover:bg-orange-500/10"
                                  >
                                    <RotateCcw className="w-4 h-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Reset link</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleDeleteSeat(seat.id)}
                                    className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Delete seat</TooltipContent>
                              </Tooltip>
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
      </div>
    </DashboardLayout>
  );
};

export default Seats;
