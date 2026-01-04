import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { 
  Flame, 
  Play, 
  Square, 
  Users, 
  MessageCircle, 
  Clock,
  ArrowLeftRight,
  RefreshCw,
  Loader2
} from "lucide-react";
import { format } from "date-fns";

interface WarmupSession {
  id: string;
  status: string;
  total_pairs: number;
  started_at: string;
}

interface WarmupPair {
  id: string;
  account_a: { phone_number: string; first_name: string | null };
  account_b: { phone_number: string; first_name: string | null };
  messages_exchanged: number;
  status: string;
}

interface WarmupMessage {
  id: string;
  message_content: string;
  status: string;
  scheduled_at: string;
  sent_at: string | null;
  sender: { phone_number: string };
  receiver: { phone_number: string };
}

export default function Warmup() {
  const [session, setSession] = useState<WarmupSession | null>(null);
  const [pairs, setPairs] = useState<WarmupPair[]>([]);
  const [recentMessages, setRecentMessages] = useState<WarmupMessage[]>([]);
  const [stats, setStats] = useState({ 
    totalPairs: 0, 
    messagesScheduled: 0, 
    messagesSent: 0,
    pendingMessages: 0 
  });
  const [loading, setLoading] = useState(false);
  const [messagesPerPair, setMessagesPerPair] = useState([5, 10]);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch active session
      const { data: sessionData } = await supabase
        .from("warmup_sessions")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      setSession(sessionData);

      if (sessionData) {
        // Fetch pairs for this session
        const { data: pairsData } = await supabase
          .from("warmup_pairs")
          .select(`
            id,
            messages_exchanged,
            status,
            account_a:telegram_accounts!warmup_pairs_account_a_id_fkey(phone_number, first_name),
            account_b:telegram_accounts!warmup_pairs_account_b_id_fkey(phone_number, first_name)
          `)
          .eq("session_id", sessionData.id)
          .order("created_at", { ascending: false });

        setPairs((pairsData as unknown as WarmupPair[]) || []);
      } else {
        setPairs([]);
      }

      // Fetch recent messages
      const { data: messagesData } = await supabase
        .from("warmup_messages")
        .select(`
          id,
          message_content,
          status,
          scheduled_at,
          sent_at,
          sender:telegram_accounts!warmup_messages_sender_account_id_fkey(phone_number),
          receiver:telegram_accounts!warmup_messages_receiver_account_id_fkey(phone_number)
        `)
        .order("scheduled_at", { ascending: false })
        .limit(20);

      setRecentMessages((messagesData as unknown as WarmupMessage[]) || []);

      // Calculate stats
      const { count: totalPairs } = await supabase
        .from("warmup_pairs")
        .select("*", { count: "exact", head: true })
        .eq("status", "active");

      const { count: messagesScheduled } = await supabase
        .from("warmup_messages")
        .select("*", { count: "exact", head: true });

      const { count: messagesSent } = await supabase
        .from("warmup_messages")
        .select("*", { count: "exact", head: true })
        .eq("status", "sent");

      const { count: pendingMessages } = await supabase
        .from("warmup_messages")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");

      setStats({
        totalPairs: totalPairs || 0,
        messagesScheduled: messagesScheduled || 0,
        messagesSent: messagesSent || 0,
        pendingMessages: pendingMessages || 0,
      });
    } catch (error) {
      console.error("Error fetching warmup data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Subscribe to realtime updates
    const channel = supabase
      .channel("warmup-updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_messages" },
        () => fetchData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_pairs" },
        () => fetchData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleStartWarmup = async () => {
    setIsStarting(true);
    try {
      const { data, error } = await supabase.functions.invoke("start-warmup-chat", {
        body: {
          messagesPerPairMin: messagesPerPair[0],
          messagesPerPairMax: messagesPerPair[1],
        },
      });

      if (error) throw error;

      toast.success(`Warmup started! Created ${data.pairs_created} pairs with ${data.messages_scheduled} scheduled messages`);
      fetchData();
    } catch (error: any) {
      console.error("Error starting warmup:", error);
      toast.error(error.message || "Failed to start warmup");
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopWarmup = async () => {
    setIsStopping(true);
    try {
      const { data, error } = await supabase.functions.invoke("stop-warmup-chat");

      if (error) throw error;

      toast.success(`Warmup stopped! Cancelled ${data.messages_cancelled} pending messages`);
      fetchData();
    } catch (error: any) {
      console.error("Error stopping warmup:", error);
      toast.error(error.message || "Failed to stop warmup");
    } finally {
      setIsStopping(false);
    }
  };

  const formatPhone = (phone: string) => {
    if (phone.length > 8) {
      return phone.slice(0, 4) + "..." + phone.slice(-4);
    }
    return phone;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "sent": return "bg-green-500";
      case "pending": return "bg-yellow-500";
      case "failed": return "bg-red-500";
      case "cancelled": return "bg-gray-500";
      default: return "bg-muted";
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-500/10 rounded-lg">
              <Flame className="h-6 w-6 text-orange-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Account Warmup</h1>
              <p className="text-muted-foreground">1-to-1 pair chat system</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={fetchData}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            {session?.status === "active" ? (
              <Button
                variant="destructive"
                onClick={handleStopWarmup}
                disabled={isStopping}
              >
                {isStopping ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Square className="h-4 w-4 mr-2" />
                )}
                Stop Warmup
              </Button>
            ) : (
              <Button
                onClick={handleStartWarmup}
                disabled={isStarting}
                className="bg-orange-500 hover:bg-orange-600"
              >
                {isStarting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Start Warmup
              </Button>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-primary/10 rounded-full">
                  <Users className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.totalPairs}</p>
                  <p className="text-sm text-muted-foreground">Active Pairs</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-green-500/10 rounded-full">
                  <MessageCircle className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.messagesSent}</p>
                  <p className="text-sm text-muted-foreground">Messages Sent</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-yellow-500/10 rounded-full">
                  <Clock className="h-5 w-5 text-yellow-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.pendingMessages}</p>
                  <p className="text-sm text-muted-foreground">Pending</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-blue-500/10 rounded-full">
                  <ArrowLeftRight className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.messagesScheduled}</p>
                  <p className="text-sm text-muted-foreground">Total Scheduled</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Settings */}
        {!session?.status || session.status !== "active" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Warmup Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Messages per pair: {messagesPerPair[0]} - {messagesPerPair[1]}</Label>
                <Slider
                  value={messagesPerPair}
                  onValueChange={setMessagesPerPair}
                  min={3}
                  max={15}
                  step={1}
                  className="w-full max-w-md"
                />
                <p className="text-sm text-muted-foreground">
                  Each pair will exchange between {messagesPerPair[0]} and {messagesPerPair[1]} messages
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Active Pairs */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5" />
                Active Pairs ({pairs.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px]">
                <div className="space-y-2">
                  {pairs.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">
                      No active pairs. Start warmup to create pairs.
                    </p>
                  ) : (
                    pairs.map((pair) => (
                      <div
                        key={pair.id}
                        className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">
                            {formatPhone(pair.account_a?.phone_number || "Unknown")}
                          </span>
                          <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                          <span className="font-mono text-sm">
                            {formatPhone(pair.account_b?.phone_number || "Unknown")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">
                            {pair.messages_exchanged} msgs
                          </Badge>
                          <Badge variant={pair.status === "active" ? "default" : "secondary"}>
                            {pair.status}
                          </Badge>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <MessageCircle className="h-5 w-5" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px]">
                <div className="space-y-2">
                  {recentMessages.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">
                      No messages yet.
                    </p>
                  ) : (
                    recentMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className="p-3 bg-muted/50 rounded-lg space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="font-mono">
                              {formatPhone(msg.sender?.phone_number || "Unknown")}
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <span className="font-mono">
                              {formatPhone(msg.receiver?.phone_number || "Unknown")}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${getStatusColor(msg.status)}`} />
                            <span className="text-xs text-muted-foreground">
                              {msg.status}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm">{msg.message_content}</p>
                        <p className="text-xs text-muted-foreground">
                          {msg.sent_at 
                            ? `Sent: ${format(new Date(msg.sent_at), "MMM d, HH:mm")}`
                            : `Scheduled: ${format(new Date(msg.scheduled_at), "MMM d, HH:mm")}`
                          }
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
