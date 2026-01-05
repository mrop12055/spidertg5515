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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Flame, 
  Play, 
  Square, 
  Users, 
  MessageCircle, 
  Clock,
  ArrowLeftRight,
  RefreshCw,
  Loader2,
  AlertTriangle,
  UserX,
  Timer,
  XCircle
} from "lucide-react";
import { format } from "date-fns";

interface WarmupSession {
  id: string;
  status: string;
  total_pairs: number;
  started_at: string;
  messages_per_pair_min: number;
  messages_per_pair_max: number;
}

interface WarmupPair {
  id: string;
  account_a: { phone_number: string; first_name: string | null };
  account_b: { phone_number: string; first_name: string | null };
  messages_exchanged: number;
  status: string;
}

interface PrePairedAccount {
  id: string;
  phone_number: string;
  first_name: string | null;
  status: string;
  warmup_pair_id: string;
  pair_phone: string;
  pair_first_name: string | null;
  pair_status: string;
  pairIsInactive: boolean;
  hasConnectionTimeout: boolean; // Either account has connection timeout
  timeoutAccountPhone: string | null; // Which account has the timeout
}

interface WarmupMessage {
  id: string;
  message_content: string;
  status: string;
  scheduled_at: string;
  sent_at: string | null;
  error_message: string | null;
  sender: { phone_number: string };
  receiver: { phone_number: string };
}

interface WarmupError {
  id: string;
  error_message: string;
  error_type: string | null;
  created_at: string;
  account: { phone_number: string } | null;
}

interface UnpairedAccount {
  id: string;
  phone_number: string;
  first_name: string | null;
}

interface OrphanedAccount {
  id: string;
  phone_number: string;
  first_name: string | null;
  inactive_pair_phone: string;
  inactive_pair_reason: string | null; // "Connection timeout" or "Session expired"
}

export default function Warmup() {
  const [session, setSession] = useState<WarmupSession | null>(null);
  const [pairs, setPairs] = useState<WarmupPair[]>([]);
  const [prePairedAccounts, setPrePairedAccounts] = useState<PrePairedAccount[]>([]);
  const [orphanedAccounts, setOrphanedAccounts] = useState<OrphanedAccount[]>([]);
  const [sentMessages, setSentMessages] = useState<WarmupMessage[]>([]);
  const [pendingMessages, setPendingMessages] = useState<WarmupMessage[]>([]);
  const [recentErrors, setRecentErrors] = useState<WarmupMessage[]>([]);
  const [unpairedAccounts, setUnpairedAccounts] = useState<UnpairedAccount[]>([]);
  const [stats, setStats] = useState({ 
    totalPairs: 0, 
    messagesScheduled: 0, 
    messagesSent: 0,
    pendingMessages: 0,
    failedMessages: 0,
    estimatedMinutesRemaining: 0
  });
  const [loading, setLoading] = useState(false);
  const [messagesPerPair, setMessagesPerPair] = useState([20, 30]);
  const [isStarting, setIsStarting] = useState(false);
  const [startingPairId, setStartingPairId] = useState<string | null>(null);
  const [stoppingPairId, setStoppingPairId] = useState<string | null>(null);
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

      // Fetch sent messages
      const { data: sentData } = await supabase
        .from("warmup_messages")
        .select(`
          id,
          message_content,
          status,
          scheduled_at,
          sent_at,
          error_message,
          sender:telegram_accounts!warmup_messages_sender_account_id_fkey(phone_number),
          receiver:telegram_accounts!warmup_messages_receiver_account_id_fkey(phone_number)
        `)
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(50);

      setSentMessages((sentData as unknown as WarmupMessage[]) || []);

      // Fetch pending messages
      const { data: pendingData } = await supabase
        .from("warmup_messages")
        .select(`
          id,
          message_content,
          status,
          scheduled_at,
          sent_at,
          error_message,
          sender:telegram_accounts!warmup_messages_sender_account_id_fkey(phone_number),
          receiver:telegram_accounts!warmup_messages_receiver_account_id_fkey(phone_number)
        `)
        .eq("status", "pending")
        .order("scheduled_at", { ascending: true })
        .limit(50);

      setPendingMessages((pendingData as unknown as WarmupMessage[]) || []);

      // Fetch failed messages (errors)
      const { data: errorData } = await supabase
        .from("warmup_messages")
        .select(`
          id,
          message_content,
          status,
          scheduled_at,
          sent_at,
          error_message,
          sender:telegram_accounts!warmup_messages_sender_account_id_fkey(phone_number),
          receiver:telegram_accounts!warmup_messages_receiver_account_id_fkey(phone_number)
        `)
        .eq("status", "failed")
        .order("scheduled_at", { ascending: false })
        .limit(10);

      setRecentErrors((errorData as unknown as WarmupMessage[]) || []);

      // Fetch unpaired accounts
      const { data: unpairedData } = await supabase
        .from("telegram_accounts")
        .select("id, phone_number, first_name")
        .eq("warmup_unpaired", true)
        .eq("status", "active");

      setUnpairedAccounts((unpairedData as UnpairedAccount[]) || []);

      // Fetch ALL accounts with pairs (to detect orphaned ones)
      const { data: allPairedData } = await supabase
        .from("telegram_accounts")
        .select("id, phone_number, first_name, status, warmup_pair_id, ban_reason")
        .not("warmup_pair_id", "is", null);

      // Create unique pairs and detect orphaned accounts
      const seenPairs = new Set<string>();
      const uniquePairs: PrePairedAccount[] = [];
      const orphaned: OrphanedAccount[] = [];
      const usableStatuses = ["active", "restricted"];
      
      // Helper to check if an account is usable for warmup
      // Connection timeout accounts are still considered usable (may recover)
      const isUsableForWarmup = (acc: any) => {
        if (usableStatuses.includes(acc.status)) return true;
        // Connection timeout is still usable (temporary issue)
        if (acc.status === 'disconnected' && acc.ban_reason?.toLowerCase().includes('timeout')) return true;
        return false;
      };
      
      if (allPairedData) {
        for (const account of allPairedData) {
          // Skip if this account is not usable
          if (!isUsableForWarmup(account)) continue;
          
          const pairKey = [account.id, account.warmup_pair_id].sort().join("-");
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          
          // Find the paired account
          const pairedAccount = allPairedData.find(a => a.id === account.warmup_pair_id);
          
          if (pairedAccount && isUsableForWarmup(pairedAccount)) {
            // Check if either account has connection timeout
            const accountHasTimeout = account.status === 'disconnected' && 
              (account as any).ban_reason?.toLowerCase().includes('timeout');
            const pairHasTimeout = pairedAccount.status === 'disconnected' && 
              (pairedAccount as any).ban_reason?.toLowerCase().includes('timeout');
            const hasTimeout = accountHasTimeout || pairHasTimeout;
            const timeoutPhone = accountHasTimeout ? account.phone_number : 
              (pairHasTimeout ? pairedAccount.phone_number : null);
            
            // Both accounts are usable - valid pair
            uniquePairs.push({
              id: account.id,
              phone_number: account.phone_number,
              first_name: account.first_name,
              status: account.status,
              warmup_pair_id: account.warmup_pair_id,
              pair_phone: pairedAccount.phone_number,
              pair_first_name: pairedAccount.first_name,
              pair_status: pairedAccount.status,
              pairIsInactive: false,
              hasConnectionTimeout: hasTimeout,
              timeoutAccountPhone: timeoutPhone,
            });
          } else {
            // Partner is truly inactive (session expired, banned, etc.) - needs re-pairing
            orphaned.push({
              id: account.id,
              phone_number: account.phone_number,
              first_name: account.first_name,
              inactive_pair_phone: pairedAccount?.phone_number || "Unknown",
              inactive_pair_reason: (pairedAccount as any)?.ban_reason || null,
            });
          }
        }
      }
      
      setPrePairedAccounts(uniquePairs);
      setOrphanedAccounts(orphaned);

      // Calculate stats - count pre-paired accounts as pairs
      const prePairedCount = uniquePairs.length;
      
      const { count: activePairsInSession } = await supabase
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

      const { count: failedMessages } = await supabase
        .from("warmup_messages")
        .select("*", { count: "exact", head: true })
        .eq("status", "failed");

      // Estimate remaining time (avg 30 seconds per message)
      const estimatedMinutesRemaining = Math.ceil((pendingMessages || 0) * 0.5);

      setStats({
        totalPairs: session ? (activePairsInSession || 0) : prePairedCount,
        messagesScheduled: messagesScheduled || 0,
        messagesSent: messagesSent || 0,
        pendingMessages: pendingMessages || 0,
        failedMessages: failedMessages || 0,
        estimatedMinutesRemaining,
      });
    } catch (error) {
      console.error("Error fetching warmup data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Subscribe to realtime updates for all warmup tables
    const channel = supabase
      .channel("warmup-updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_messages" },
        (payload) => {
          console.log("Warmup message change:", payload);
          fetchData();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_pairs" },
        (payload) => {
          console.log("Warmup pair change:", payload);
          fetchData();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_sessions" },
        (payload) => {
          console.log("Warmup session change:", payload);
          fetchData();
        }
      )
      .subscribe((status) => {
        console.log("Warmup realtime subscription status:", status);
      });

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

      if (data.unpaired_account) {
        toast.success(`Warmup started! ${data.pairs_created} pairs, ${data.messages_scheduled} messages. Account ${data.unpaired_account} waiting for pair.`);
      } else {
        toast.success(`Warmup started! Created ${data.pairs_created} pairs with ${data.messages_scheduled} messages (~${data.estimated_duration_minutes || 10} min)`);
      }
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

  const handleStopSinglePair = async (pairId: string) => {
    setStoppingPairId(pairId);
    try {
      const { data, error } = await supabase.functions.invoke("stop-warmup-chat", {
        body: { pairId },
      });

      if (error) throw error;

      toast.success(`Pair stopped! Cancelled ${data.messages_cancelled} pending messages`);
      fetchData();
    } catch (error: any) {
      console.error("Error stopping pair:", error);
      toast.error(error.message || "Failed to stop this pair");
    } finally {
      setStoppingPairId(null);
    }
  };

  const handleRepairOrphanedAccounts = async () => {
    if (orphanedAccounts.length < 2) {
      toast.error("Need at least 2 orphaned accounts to re-pair");
      return;
    }

    try {
      // Pair orphaned accounts with each other
      for (let i = 0; i < orphanedAccounts.length - 1; i += 2) {
        const account1 = orphanedAccounts[i];
        const account2 = orphanedAccounts[i + 1];

        // Update both accounts to point to each other
        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account2.id })
          .eq("id", account1.id);

        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account1.id })
          .eq("id", account2.id);
      }

      toast.success(`Re-paired ${Math.floor(orphanedAccounts.length / 2)} pairs!`);
      fetchData();
    } catch (error: any) {
      console.error("Error re-pairing accounts:", error);
      toast.error(error.message || "Failed to re-pair accounts");
    }
  };

  const handleStartSinglePairWarmup = async (accountId: string, pairAccountId: string) => {
    setStartingPairId(accountId);
    try {
      const { data, error } = await supabase.functions.invoke("start-warmup-chat", {
        body: {
          messagesPerPairMin: messagesPerPair[0],
          messagesPerPairMax: messagesPerPair[1],
          specificPairAccountIds: [accountId, pairAccountId],
        },
      });

      if (error) throw error;

      toast.success(`Warmup started for pair! ${data.messages_scheduled} messages scheduled (~${data.estimated_duration_minutes} min)`);
      fetchData();
    } catch (error: any) {
      console.error("Error starting single pair warmup:", error);
      toast.error(error.message || "Failed to start warmup for this pair");
    } finally {
      setStartingPairId(null);
    }
  };

  const formatPhone = (phone: string) => {
    if (!phone) return "Unknown";
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
              <p className="text-muted-foreground">1-to-1 pair chat system (10-15 min conversations)</p>
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

        {/* Orphaned Accounts - Active accounts paired with session-expired accounts */}
        {orphanedAccounts.length > 0 && (() => {
          // Session expired accounts need repairing
          const sessionExpiredAccounts = orphanedAccounts.filter(a => 
            a.inactive_pair_reason?.toLowerCase().includes('session')
          );
          const otherInactiveAccounts = orphanedAccounts.filter(a => 
            !a.inactive_pair_reason?.toLowerCase().includes('session')
          );
          
          return (
            <>
              {/* Session Expired - Needs re-pairing */}
              {sessionExpiredAccounts.length > 0 && (
                <Card className="border-orange-500/50 bg-orange-500/5">
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-orange-500 mt-0.5" />
                      <div className="flex-1">
                        <p className="font-medium">Accounts Need Re-pairing ({sessionExpiredAccounts.length})</p>
                        <p className="text-sm text-muted-foreground mb-3">
                          These accounts are paired with accounts that have expired sessions and need to be re-paired.
                        </p>
                        <div className="space-y-2">
                          {sessionExpiredAccounts.map((account) => (
                            <div key={account.id} className="flex items-center justify-between bg-background/50 p-2 rounded">
                              <div className="text-sm">
                                <span className="font-mono">{formatPhone(account.phone_number)}</span>
                                {account.first_name && <span className="text-muted-foreground ml-2">({account.first_name})</span>}
                                <span className="text-muted-foreground mx-2">↔</span>
                                <span className="font-mono text-red-400 line-through">{formatPhone(account.inactive_pair_phone)}</span>
                                <span className="text-xs text-red-400 ml-1">(session expired)</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        {sessionExpiredAccounts.length >= 2 && (
                          <Button 
                            size="sm" 
                            className="mt-3"
                            onClick={handleRepairOrphanedAccounts}
                          >
                            Re-pair All ({Math.floor(sessionExpiredAccounts.length / 2)} pairs)
                          </Button>
                        )}
                        {sessionExpiredAccounts.length === 1 && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Waiting for another orphaned account to pair with
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
              
              {/* Other inactive accounts (banned, etc.) */}
              {otherInactiveAccounts.length > 0 && (
                <Card className="border-gray-500/50 bg-gray-500/5">
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-gray-500 mt-0.5" />
                      <div className="flex-1">
                        <p className="font-medium">Inactive Partners ({otherInactiveAccounts.length})</p>
                        <p className="text-sm text-muted-foreground mb-3">
                          These accounts have inactive partners.
                        </p>
                        <div className="space-y-2">
                          {otherInactiveAccounts.map((account) => (
                            <div key={account.id} className="flex items-center justify-between bg-background/50 p-2 rounded">
                              <div className="text-sm">
                                <span className="font-mono">{formatPhone(account.phone_number)}</span>
                                {account.first_name && <span className="text-muted-foreground ml-2">({account.first_name})</span>}
                                <span className="text-muted-foreground mx-2">↔</span>
                                <span className="font-mono text-gray-400 line-through">{formatPhone(account.inactive_pair_phone)}</span>
                                <span className="text-xs text-gray-400 ml-1">(inactive)</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          );
        })()}

        {/* Unpaired Accounts Warning */}
        {unpairedAccounts.length > 0 && (
          <Card className="border-yellow-500/50 bg-yellow-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <UserX className="h-5 w-5 text-yellow-500" />
                <div>
                  <p className="font-medium">Unpaired Accounts</p>
                  <p className="text-sm text-muted-foreground">
                    {unpairedAccounts.map(a => formatPhone(a.phone_number)).join(", ")} waiting for new accounts to pair with
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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
                <div className="p-3 bg-red-500/10 rounded-full">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.failedMessages}</p>
                  <p className="text-sm text-muted-foreground">Failed</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-blue-500/10 rounded-full">
                  <Timer className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">~{stats.estimatedMinutesRemaining}m</p>
                  <p className="text-sm text-muted-foreground">Remaining</p>
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
                  min={10}
                  max={30}
                  step={1}
                  className="w-full max-w-md"
                />
                <p className="text-sm text-muted-foreground">
                  Each pair will exchange {messagesPerPair[0]}-{messagesPerPair[1]} messages (~{Math.ceil(messagesPerPair[1] * 0.5)} min per conversation)
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Paired Accounts - Always show all pairs */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5" />
                Paired Accounts ({prePairedAccounts.length})
                {session?.status === "active" && pairs.filter(p => p.status === "active").length > 0 && (
                  <Badge className="ml-2 bg-green-500">{pairs.filter(p => p.status === "active").length} running</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[350px]">
                <div className="space-y-2">
                  {prePairedAccounts.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">
                      No paired accounts yet. Pairs are created when accounts become active.
                    </p>
                  ) : (
                    prePairedAccounts.map((account, index) => {
                      // Check if this pair is currently running in active session
                      const isRunning = pairs.some(
                        p => (p.account_a?.phone_number === account.phone_number || 
                              p.account_b?.phone_number === account.phone_number) &&
                             p.status === "active"
                      );
                      const activePair = pairs.find(
                        p => p.account_a?.phone_number === account.phone_number || 
                             p.account_b?.phone_number === account.phone_number
                      );
                      
                      return (
                        <div
                          key={account.id}
                          className={`flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-lg gap-2 ${
                            isRunning ? "bg-green-500/10 border border-green-500/30" : "bg-muted/50"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <Badge variant="outline" className="h-6 w-8 justify-center font-semibold shrink-0">
                              #{index + 1}
                            </Badge>
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="text-left min-w-0">
                                <span className={`font-mono text-sm block truncate ${account.timeoutAccountPhone === account.phone_number ? 'text-blue-500' : ''}`}>
                                  {formatPhone(account.phone_number)}
                                </span>
                                {account.first_name && (
                                  <span className="text-xs text-muted-foreground truncate block">{account.first_name}</span>
                                )}
                              </div>
                              <ArrowLeftRight className="h-4 w-4 text-muted-foreground shrink-0" />
                              <div className="text-left min-w-0">
                                <span className={`font-mono text-sm block truncate ${account.timeoutAccountPhone === account.pair_phone ? 'text-blue-500' : ''}`}>
                                  {formatPhone(account.pair_phone)}
                                </span>
                                {account.pair_first_name && (
                                  <span className="text-xs text-muted-foreground truncate block">{account.pair_first_name}</span>
                                )}
                              </div>
                              {account.hasConnectionTimeout && (
                                <Badge variant="outline" className="shrink-0 text-xs px-1.5 bg-blue-500/10 text-blue-500 border-blue-500/30">
                                  <Clock className="h-3 w-3 mr-1" />
                                  Timeout
                                </Badge>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {isRunning ? (
                              <>
                                <Badge variant="secondary" className="shrink-0 text-xs px-1.5">
                                  {activePair?.messages_exchanged || 0}
                                </Badge>
                                <Button
                                  size="icon"
                                  variant="destructive"
                                  onClick={() => activePair && handleStopSinglePair(activePair.id)}
                                  disabled={stoppingPairId === activePair?.id}
                                  className="h-7 w-7 shrink-0"
                                >
                                  {stoppingPairId === activePair?.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Square className="h-3 w-3" />
                                  )}
                                </Button>
                                <div className="flex items-center gap-1 bg-green-500 text-white px-2 py-1 rounded-md text-xs shrink-0">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                </div>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleStartSinglePairWarmup(account.id, account.warmup_pair_id)}
                                disabled={startingPairId === account.id}
                                className="h-7 text-xs"
                              >
                                {startingPairId === account.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Play className="h-3 w-3 mr-1" />
                                )}
                                Warmup
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Recent Activity with Tabs */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <MessageCircle className="h-5 w-5" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="sent" className="w-full">
                <TabsList className="grid w-full grid-cols-3 mb-3">
                  <TabsTrigger value="sent" className="flex items-center gap-1">
                    <MessageCircle className="h-3 w-3" />
                    Sent
                    {sentMessages.length > 0 && (
                      <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs bg-green-500/20 text-green-600">
                        {sentMessages.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="pending" className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Pending
                    {pendingMessages.length > 0 && (
                      <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
                        {pendingMessages.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="failed" className="flex items-center gap-1">
                    <XCircle className="h-3 w-3" />
                    Failed
                    {recentErrors.length > 0 && (
                      <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-xs">
                        {recentErrors.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                </TabsList>
                
                <TabsContent value="sent" className="mt-0">
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-2">
                      {sentMessages.length === 0 ? (
                        <p className="text-muted-foreground text-center py-8">
                          No sent messages yet.
                        </p>
                      ) : (
                        sentMessages.map((msg) => (
                          <div
                            key={msg.id}
                            className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg space-y-1"
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
                              <Badge variant="secondary" className="bg-green-500/20 text-green-600">Sent</Badge>
                            </div>
                            <p className="text-sm truncate">{msg.message_content}</p>
                            <p className="text-xs text-muted-foreground">
                              {msg.sent_at && format(new Date(msg.sent_at), "MMM d, HH:mm")}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>
                
                <TabsContent value="pending" className="mt-0">
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-2">
                      {pendingMessages.length === 0 ? (
                        <p className="text-muted-foreground text-center py-8">
                          No pending messages.
                        </p>
                      ) : (
                        pendingMessages.map((msg) => (
                          <div
                            key={msg.id}
                            className="p-3 bg-yellow-500/5 border border-yellow-500/20 rounded-lg space-y-1"
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
                              <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600">Pending</Badge>
                            </div>
                            <p className="text-sm truncate">{msg.message_content}</p>
                            <p className="text-xs text-muted-foreground">
                              Scheduled: {format(new Date(msg.scheduled_at), "MMM d, HH:mm")}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>
                
                <TabsContent value="failed" className="mt-0">
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-2">
                      {recentErrors.length === 0 ? (
                        <p className="text-muted-foreground text-center py-8">
                          No failed messages.
                        </p>
                      ) : (
                        recentErrors.map((msg) => (
                          <div
                            key={msg.id}
                            className="p-3 bg-red-500/5 border border-red-500/20 rounded-lg space-y-1"
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
                              <Badge variant="destructive">Failed</Badge>
                            </div>
                            <p className="text-sm text-red-400 truncate">{msg.error_message || "Unknown error"}</p>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(msg.scheduled_at), "MMM d, HH:mm")}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
