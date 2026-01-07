import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PageHeader } from "@/components/layout/PageHeader";
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
  XCircle,
  Settings,
  Layers,
  Save,
  Link2,
  Tag,
  UserPlus,
  MousePointerClick,
  CheckSquare
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  cycles_completed_today: number;
  last_cycle_date: string | null;
  failed_reason: string | null;
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
  todayMessagesCount: number; // Messages exchanged today
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
  const initialLoadDoneRef = useRef(false);
  const [messagesPerPair, setMessagesPerPair] = useState([20, 30]);
  const [isStarting, setIsStarting] = useState(false);
  const [startingPairId, setStartingPairId] = useState<string | null>(null);
  const [stoppingPairId, setStoppingPairId] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [warmupBatchSize, setWarmupBatchSize] = useState(100);
  const [isSavingBatchSize, setIsSavingBatchSize] = useState(false);
  
  // Pairing dialog state
  const [isPairDialogOpen, setIsPairDialogOpen] = useState(false);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState<string>("all");
  const [idleAccounts, setIdleAccounts] = useState<{ id: string; phone_number: string; first_name: string | null; tags: string[] | null }[]>([]);
  const [isPairing, setIsPairing] = useState(false);
  const [addToContacts, setAddToContacts] = useState(true);
  const [pairingMode, setPairingMode] = useState<"auto" | "manual">("auto");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);

  // Warmup selection dialog state
  const [isWarmupDialogOpen, setIsWarmupDialogOpen] = useState(false);
  const [warmupSelectedTag, setWarmupSelectedTag] = useState<string>("all");
  const [warmupSelectedPairs, setWarmupSelectedPairs] = useState<string[]>([]);
  const [warmupSelectMode, setWarmupSelectMode] = useState<"all" | "selected">("all");

  const fetchData = useCallback(async (isInitial = false) => {
    // Only show loading spinner on first load / manual refresh (avoid flicker during polling)
    if (isInitial || !initialLoadDoneRef.current) {
      setLoading(true);
    }
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
            cycles_completed_today,
            last_cycle_date,
            failed_reason,
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
        .limit(100);

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

      // Fetch failed messages - also limit to 100 most recent (will be combined with sent)
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
        .limit(100);

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
      
      // Fetch today's messages count per pair
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const { data: todayMessagesData } = await supabase
        .from("warmup_messages")
        .select("sender_account_id, receiver_account_id")
        .eq("status", "sent")
        .gte("sent_at", todayStart.toISOString());
      
      // Count messages per account pair
      const pairMessageCounts = new Map<string, number>();
      if (todayMessagesData) {
        for (const msg of todayMessagesData) {
          const pairKey = [msg.sender_account_id, msg.receiver_account_id].sort().join("-");
          pairMessageCounts.set(pairKey, (pairMessageCounts.get(pairKey) || 0) + 1);
        }
      }
      
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
            
            // Get today's message count for this pair
            const todayMsgCount = pairMessageCounts.get(pairKey) || 0;
            
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
              todayMessagesCount: todayMsgCount,
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

      // Calculate remaining time based on the last scheduled pending message
      let estimatedMinutesRemaining = 0;
      if (pendingMessages && pendingMessages > 0) {
        const { data: lastPendingMessage } = await supabase
          .from("warmup_messages")
          .select("scheduled_at")
          .eq("status", "pending")
          .order("scheduled_at", { ascending: false })
          .limit(1)
          .single();
        
        if (lastPendingMessage?.scheduled_at) {
          const lastScheduledTime = new Date(lastPendingMessage.scheduled_at).getTime();
          const now = Date.now();
          const remainingMs = lastScheduledTime - now;
          estimatedMinutesRemaining = remainingMs > 0 ? Math.ceil(remainingMs / 60000) : 0;
        }
      }

      setStats({
        totalPairs: sessionData ? (activePairsInSession || 0) : prePairedCount,
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
      initialLoadDoneRef.current = true;
    }
  }, []);

  // Load warmup batch size from settings
  useEffect(() => {
    const loadBatchSize = async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'warmup_batch_size')
        .single();
      
      if (data?.value) {
        const value = data.value as { batchSize?: number };
        setWarmupBatchSize(value.batchSize || 100);
      }
    };
    loadBatchSize();
  }, []);

  // Debounce fetchData to prevent excessive API calls during rapid realtime updates
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedFetchData = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      fetchData();
    }, 2000); // Wait 2 seconds after last change before fetching
  }, [fetchData]);

  useEffect(() => {
    fetchData(true); // Initial load

    // Subscribe to realtime updates for all warmup tables with debounced refresh
    const channel = supabase
      .channel("warmup-updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_messages" },
        () => {
          // Debounce - don't fetch immediately on every message change
          debouncedFetchData();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_pairs" },
        () => {
          debouncedFetchData();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "warmup_sessions" },
        () => {
          // Session changes are rare - fetch immediately
          fetchData();
        }
      )
      .subscribe();

    // Also poll every 10 seconds as backup
    const pollInterval = setInterval(fetchData, 10000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [debouncedFetchData, fetchData]);

  const handleSaveBatchSize = async () => {
    setIsSavingBatchSize(true);
    try {
      await supabase
        .from('app_settings')
        .upsert({
          key: 'warmup_batch_size',
          value: { batchSize: warmupBatchSize },
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });
      toast.success('Batch size saved');
    } catch (error) {
      toast.error('Failed to save batch size');
    } finally {
      setIsSavingBatchSize(false);
    }
  };

  const handleStartWarmup = async (specificPairIds?: string[]) => {
    setIsStarting(true);
    try {
      const body: any = {
        messagesPerPairMin: messagesPerPair[0],
        messagesPerPairMax: messagesPerPair[1],
      };
      
      // If specific pairs selected, extract account IDs
      if (specificPairIds && specificPairIds.length > 0) {
        const accountIds: string[] = [];
        specificPairIds.forEach(pairKey => {
          const pair = prePairedAccounts.find(p => p.id === pairKey);
          if (pair) {
            accountIds.push(pair.id);
            accountIds.push(pair.warmup_pair_id);
          }
        });
        body.specificPairAccountIds = accountIds;
      }
      
      const { data, error } = await supabase.functions.invoke("start-warmup-chat", {
        body,
      });

      if (error) throw error;

      if (data.unpaired_account) {
        toast.success(`Warmup started! ${data.pairs_created} pairs, ${data.messages_scheduled} messages. Account ${data.unpaired_account} waiting for pair.`);
      } else {
        toast.success(`Warmup started! Created ${data.pairs_created} pairs with ${data.messages_scheduled} messages (~${data.estimated_duration_minutes || 10} min)`);
      }
      setIsWarmupDialogOpen(false);
      fetchData();
    } catch (error: any) {
      console.error("Error starting warmup:", error);
      toast.error(error.message || "Failed to start warmup");
    } finally {
      setIsStarting(false);
    }
  };

  // Open warmup dialog
  const handleOpenWarmupDialog = () => {
    setWarmupSelectedTag("all");
    setWarmupSelectedPairs([]);
    setWarmupSelectMode("all");
    setIsWarmupDialogOpen(true);
  };

  // Get filtered pairs by tag for warmup
  const warmupFilteredPairs = useMemo(() => {
    if (warmupSelectedTag === "all") return prePairedAccounts;
    // Filter pairs where at least one account has the tag
    return prePairedAccounts.filter(pair => {
      const account = idleAccounts.find(a => a.id === pair.id);
      return account && (account.tags || []).includes(warmupSelectedTag);
    });
  }, [prePairedAccounts, warmupSelectedTag, idleAccounts]);

  // Toggle pair selection for warmup
  const toggleWarmupPairSelection = (pairId: string) => {
    setWarmupSelectedPairs(prev => {
      if (prev.includes(pairId)) {
        return prev.filter(id => id !== pairId);
      }
      return [...prev, pairId];
    });
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

        // Update both accounts to point to each other and clear unpaired flag
        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account2.id, warmup_unpaired: false })
          .eq("id", account1.id);

        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account1.id, warmup_unpaired: false })
          .eq("id", account2.id);
      }

      toast.success(`Re-paired ${Math.floor(orphanedAccounts.length / 2)} pairs!`);
      fetchData();
    } catch (error: any) {
      console.error("Error re-pairing accounts:", error);
      toast.error(error.message || "Failed to re-pair accounts");
    }
  };

  // Pair orphaned accounts with unpaired accounts
  const handlePairOrphanedWithUnpaired = async () => {
    // Combine orphaned + unpaired, pair them up
    const allToPair = [
      ...sessionExpiredAccounts.map(a => ({ id: a.id, phone: a.phone_number })),
      ...dedupedUnpairedAccounts.map(a => ({ id: a.id, phone: a.phone_number }))
    ];

    if (allToPair.length < 2) {
      toast.error("Need at least 2 accounts to create a pair");
      return;
    }

    try {
      let pairsCreated = 0;
      for (let i = 0; i < allToPair.length - 1; i += 2) {
        const account1 = allToPair[i];
        const account2 = allToPair[i + 1];

        // Update both accounts to point to each other
        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account2.id, warmup_unpaired: false })
          .eq("id", account1.id);

        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account1.id, warmup_unpaired: false })
          .eq("id", account2.id);
        
        pairsCreated++;
      }

      toast.success(`Created ${pairsCreated} new pair(s)!`);
      fetchData();
    } catch (error: any) {
      console.error("Error pairing accounts:", error);
      toast.error(error.message || "Failed to pair accounts");
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

  // Fetch idle accounts (active accounts without warmup_pair_id)
  const fetchIdleAccounts = async () => {
    const { data } = await supabase
      .from("telegram_accounts")
      .select("id, phone_number, first_name, tags")
      .eq("status", "active")
      .is("warmup_pair_id", null);
    
    if (data) {
      setIdleAccounts(data);
      // Extract unique tags
      const tags = new Set<string>();
      data.forEach(acc => {
        (acc.tags || []).forEach(tag => tags.add(tag));
      });
      setAvailableTags(Array.from(tags).sort());
    }
  };

  // Open pair dialog
  const handleOpenPairDialog = () => {
    fetchIdleAccounts();
    setSelectedTag("all");
    setPairingMode("auto");
    setSelectedAccounts([]);
    setAddToContacts(true);
    setIsPairDialogOpen(true);
  };

  // Toggle account selection for manual pairing
  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccounts(prev => {
      if (prev.includes(accountId)) {
        return prev.filter(id => id !== accountId);
      }
      if (prev.length >= 2) {
        return [prev[1], accountId]; // Replace first with second, add new
      }
      return [...prev, accountId];
    });
  };

  // Get filtered idle accounts by tag
  const filteredIdleAccounts = useMemo(() => {
    if (selectedTag === "all") return idleAccounts;
    return idleAccounts.filter(acc => (acc.tags || []).includes(selectedTag));
  }, [idleAccounts, selectedTag]);

  // Pair idle accounts
  const handlePairIdleAccounts = async () => {
    let accountsToPair: typeof idleAccounts = [];
    
    if (pairingMode === "manual") {
      if (selectedAccounts.length !== 2) {
        toast.error("Select exactly 2 accounts for manual pairing");
        return;
      }
      accountsToPair = idleAccounts.filter(a => selectedAccounts.includes(a.id));
    } else {
      accountsToPair = filteredIdleAccounts;
      if (accountsToPair.length < 2) {
        toast.error("Need at least 2 accounts to create pairs");
        return;
      }
    }

    setIsPairing(true);
    try {
      let pairsCreated = 0;
      for (let i = 0; i < accountsToPair.length - 1; i += 2) {
        const account1 = accountsToPair[i];
        const account2 = accountsToPair[i + 1];

        // Create pair in warmup_pairs table if addToContacts is true
        if (addToContacts) {
          // Insert a warmup pair record with contacts_exchanged = false
          // The Python runner will handle adding contacts when it sees this
          const { data: sessionData } = await supabase
            .from("warmup_sessions")
            .select("id")
            .eq("status", "active")
            .limit(1)
            .single();

          if (sessionData) {
            await supabase
              .from("warmup_pairs")
              .insert({
                session_id: sessionData.id,
                account_a_id: account1.id,
                account_b_id: account2.id,
                contacts_exchanged: false,
                status: "pending"
              });
          }
        }

        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account2.id, warmup_unpaired: false })
          .eq("id", account1.id);

        await supabase
          .from("telegram_accounts")
          .update({ warmup_pair_id: account1.id, warmup_unpaired: false })
          .eq("id", account2.id);
        
        pairsCreated++;
      }

      toast.success(`Created ${pairsCreated} new pair(s)${addToContacts ? " - will add to contacts" : ""}!`);
      setIsPairDialogOpen(false);
      fetchData();
    } catch (error: any) {
      console.error("Error pairing accounts:", error);
      toast.error(error.message || "Failed to pair accounts");
    } finally {
      setIsPairing(false);
    }
  };

  const formatPhone = (phone: string) => {
    if (!phone) return "Unknown";
    return phone;
  };

  // Find pair number for a message based on sender/receiver phones
  const getPairNumber = (senderPhone: string, receiverPhone: string): number | null => {
    const index = prePairedAccounts.findIndex(
      (p) =>
        (p.phone_number === senderPhone && p.pair_phone === receiverPhone) ||
        (p.phone_number === receiverPhone && p.pair_phone === senderPhone)
    );
    return index >= 0 ? index + 1 : null;
  };

  // Compute combined messages for Sent tab (only 100 most recent)
  const displayedSentActivity = useMemo(() => {
    const combined = [...recentErrors, ...sentMessages]
      .sort((a, b) => {
        const dateA = new Date(a.sent_at || a.scheduled_at).getTime();
        const dateB = new Date(b.sent_at || b.scheduled_at).getTime();
        return dateB - dateA;
      })
      .slice(0, 100);
    
    const sentCount = combined.filter(m => m.status === 'sent').length;
    const failedCount = combined.filter(m => m.status === 'failed').length;
    
    return { messages: combined, sentCount, failedCount };
  }, [recentErrors, sentMessages]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "sent":
        return "bg-green-500";
      case "pending":
        return "bg-yellow-500";
      case "failed":
        return "bg-red-500";
      case "cancelled":
        return "bg-gray-500";
      default:
        return "bg-muted";
    }
  };

  const sessionExpiredAccounts = useMemo(() => {
    return orphanedAccounts.filter((a) => a.inactive_pair_reason?.toLowerCase().includes("session"));
  }, [orphanedAccounts]);

  const otherInactiveAccounts = useMemo(() => {
    return orphanedAccounts.filter((a) => !a.inactive_pair_reason?.toLowerCase().includes("session"));
  }, [orphanedAccounts]);

  // Avoid showing the same account in both warnings if data is inconsistent
  const dedupedUnpairedAccounts = useMemo(() => {
    const orphanedIds = new Set(orphanedAccounts.map((o) => o.id));
    return unpairedAccounts.filter((u) => !orphanedIds.has(u.id));
  }, [orphanedAccounts, unpairedAccounts]);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Account Warmup"
          description="1-to-1 pair chat system (10-15 min conversations)"
          icon={Flame}
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => fetchData(true)}
                disabled={loading}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
              {session?.status === "active" && (
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
              )}
            </div>
          }
        />

        {/* Pairing Alerts (Needs re-pairing + Unpaired) */}
        {(sessionExpiredAccounts.length > 0 || dedupedUnpairedAccounts.length > 0) && (
          <Card
            className={
              sessionExpiredAccounts.length > 0
                ? "border-orange-500/50 bg-orange-500/5"
                : "border-yellow-500/50 bg-yellow-500/5"
            }
          >
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                {sessionExpiredAccounts.length > 0 ? (
                  <AlertTriangle className="h-5 w-5 text-orange-500 mt-0.5" />
                ) : (
                  <UserX className="h-5 w-5 text-yellow-500 mt-0.5" />
                )}
                <div className="flex-1">
                  <p className="font-medium">
                    Pairing Alerts ({sessionExpiredAccounts.length + dedupedUnpairedAccounts.length})
                  </p>

                  {sessionExpiredAccounts.length > 0 && (
                    <div className="mt-1">
                      <p className="text-sm text-muted-foreground mb-3">
                        These accounts are paired with accounts that have expired sessions and need to be re-paired.
                      </p>
                      <div className="space-y-2">
                        {sessionExpiredAccounts.map((account) => (
                          <div
                            key={account.id}
                            className="flex items-center justify-between bg-background/50 p-2 rounded"
                          >
                            <div className="text-sm">
                              <span className="font-mono">{formatPhone(account.phone_number)}</span>
                              {account.first_name && (
                                <span className="text-muted-foreground ml-2">({account.first_name})</span>
                              )}
                              <span className="text-muted-foreground mx-2">↔</span>
                              <span className="font-mono text-red-400 line-through">
                                {formatPhone(account.inactive_pair_phone)}
                              </span>
                              <span className="text-xs text-red-400 ml-1">(session expired)</span>
                            </div>
                          </div>
                        ))}
                      </div>

                    </div>
                  )}

                  {dedupedUnpairedAccounts.length > 0 && (
                    <div
                      className={
                        sessionExpiredAccounts.length > 0
                          ? "mt-4 pt-4 border-t border-border/50"
                          : "mt-1"
                      }
                    >
                      <p className="font-medium text-sm">Unpaired Accounts</p>
                      <p className="text-sm text-muted-foreground">
                        {dedupedUnpairedAccounts.map((a) => formatPhone(a.phone_number)).join(", ")}
                        {" — waiting for another active account to pair."}
                      </p>
                    </div>
                  )}

                  {/* Pair Together button when we have orphaned + unpaired that can be combined */}
                  {(sessionExpiredAccounts.length + dedupedUnpairedAccounts.length) >= 2 && (
                    <Button size="sm" className="mt-3" onClick={handlePairOrphanedWithUnpaired}>
                      <ArrowLeftRight className="h-4 w-4 mr-2" />
                      Pair Together ({Math.floor((sessionExpiredAccounts.length + dedupedUnpairedAccounts.length) / 2)} pairs)
                    </Button>
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
                  <p className="text-sm text-muted-foreground mb-3">These accounts have inactive partners.</p>
                  <div className="space-y-2">
                    {otherInactiveAccounts.map((account) => (
                      <div
                        key={account.id}
                        className="flex items-center justify-between bg-background/50 p-2 rounded"
                      >
                        <div className="text-sm">
                          <span className="font-mono">{formatPhone(account.phone_number)}</span>
                          {account.first_name && (
                            <span className="text-muted-foreground ml-2">({account.first_name})</span>
                          )}
                          <span className="text-muted-foreground mx-2">↔</span>
                          <span className="font-mono text-gray-400 line-through">
                            {formatPhone(account.inactive_pair_phone)}
                          </span>
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

        {/* Settings - Always visible */}
        <Card className="overflow-hidden">
          <CardHeader className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 border-b border-border/50 py-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="h-5 w-5 text-orange-500" />
              Warmup Settings
              {session?.status === "active" && (
                <Badge variant="secondary" className="ml-2 text-xs">Read-only while running</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Messages per Pair */}
              <div className="space-y-4 p-4 rounded-lg bg-muted/30 border border-border/50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-full bg-primary/10">
                      <MessageCircle className="h-4 w-4 text-primary" />
                    </div>
                    <Label className="font-medium">Messages per Pair</Label>
                  </div>
                  <Badge variant="secondary" className="font-mono">
                    {messagesPerPair[0]} - {messagesPerPair[1]}
                  </Badge>
                </div>
                <Slider
                  value={messagesPerPair}
                  onValueChange={setMessagesPerPair}
                  min={10}
                  max={30}
                  step={1}
                  className="w-full"
                  disabled={session?.status === "active"}
                />
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  ~{Math.ceil(messagesPerPair[1] * 0.5)} min per conversation
                </p>
              </div>
              
              {/* Batch Size */}
              <div className="space-y-4 p-4 rounded-lg bg-muted/30 border border-border/50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-full bg-blue-500/10">
                      <Layers className="h-4 w-4 text-blue-500" />
                    </div>
                    <Label className="font-medium">Batch Size</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="font-mono">
                      {warmupBatchSize}
                    </Badge>
                    <Button 
                      onClick={handleSaveBatchSize}
                      disabled={isSavingBatchSize || session?.status === "active"}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                    >
                      {isSavingBatchSize ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>
                <Slider
                  value={[warmupBatchSize]}
                  onValueChange={([v]) => setWarmupBatchSize(v)}
                  min={10}
                  max={500}
                  step={10}
                  className="w-full"
                  disabled={session?.status === "active"}
                />
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Users className="h-3 w-3" />
                  Parallel pairs: 10-500
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Paired Accounts - Always show all pairs */}
          <Card className="overflow-hidden">
            <CardHeader className="bg-gradient-to-r from-primary/5 to-primary/10 border-b border-border/50 py-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  Paired Accounts
                  <Badge variant="secondary" className="font-mono">{prePairedAccounts.length}</Badge>
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenPairDialog}
                    className="h-8"
                  >
                    <Link2 className="h-4 w-4 mr-1.5" />
                    Pair Idle Accounts
                  </Button>
                  {session?.status !== "active" && prePairedAccounts.length > 0 && (
                    <Button
                      size="sm"
                      onClick={handleOpenWarmupDialog}
                      className="h-8 bg-orange-500 hover:bg-orange-600"
                    >
                      <Play className="h-4 w-4 mr-1.5" />
                      Start Warmup
                    </Button>
                  )}
                  {session?.status === "active" && pairs.filter(p => p.status === "active").length > 0 && (
                    <Badge className="bg-green-500 text-white">
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      {pairs.filter(p => p.status === "active").length} running
                    </Badge>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[400px]">
                <div className="divide-y divide-border/50">
                  {prePairedAccounts.length === 0 ? (
                    <div className="text-muted-foreground text-center py-12">
                      <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No paired accounts yet</p>
                      <p className="text-sm">Pairs are created when accounts become active</p>
                    </div>
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
                      
                      // Get cycle count for today
                      const today = new Date().toLocaleDateString('en-CA');
                      const pairCycles = activePair?.last_cycle_date === today 
                        ? (activePair?.cycles_completed_today || 0) 
                        : 0;
                      
                      return (
                        <div
                          key={account.id}
                          className={`flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 gap-3 transition-colors hover:bg-muted/30 ${
                            isRunning ? "bg-green-500/5" : ""
                          }`}
                        >
                          {/* Pair Info */}
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <Badge variant="outline" className={`h-6 px-2 justify-center font-semibold shrink-0 ${
                              isRunning 
                                ? "bg-green-500/10 text-green-600 border-green-500/30" 
                                : activePair?.status === "completed" 
                                  ? "bg-primary/10 text-primary border-primary/30"
                                  : activePair?.status === "failed"
                                    ? "bg-red-500/10 text-red-500 border-red-500/30"
                                    : ""
                            }`}>
                              #{index + 1}
                            </Badge>
                            
                            {/* Account A */}
                            <div className="text-left min-w-0">
                              <span className={`font-mono text-sm block truncate ${
                                account.timeoutAccountPhone === account.phone_number ? 'text-blue-500' : ''
                              }`}>
                                {formatPhone(account.phone_number)}
                              </span>
                              {account.first_name && (
                                <span className="text-xs text-muted-foreground truncate block">{account.first_name}</span>
                              )}
                            </div>
                            
                            {/* Arrow */}
                            <ArrowLeftRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            
                            {/* Account B */}
                            <div className="text-left min-w-0">
                              <span className={`font-mono text-sm block truncate ${
                                account.timeoutAccountPhone === account.pair_phone ? 'text-blue-500' : ''
                              }`}>
                                {formatPhone(account.pair_phone)}
                              </span>
                              {account.pair_first_name && (
                                <span className="text-xs text-muted-foreground truncate block">{account.pair_first_name}</span>
                              )}
                            </div>
                          </div>
                          
                          {/* Stats & Actions */}
                          <div className="flex items-center gap-2 shrink-0">
                            {/* Today's Messages Count */}
                            {account.todayMessagesCount > 0 && (
                              <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 text-primary text-xs">
                                <MessageCircle className="h-3 w-3" />
                                <span className="font-medium">{account.todayMessagesCount}</span>
                                <span className="text-muted-foreground">today</span>
                              </div>
                            )}
                            
                            {/* Cycles Count */}
                            {pairCycles > 0 && (
                              <Badge variant="outline" className="text-xs px-1.5 bg-blue-500/10 text-blue-600 border-blue-500/30">
                                {pairCycles} cycle{pairCycles !== 1 ? 's' : ''}
                              </Badge>
                            )}
                            
                            {/* Timeout Badge */}
                            {account.hasConnectionTimeout && (
                              <Badge variant="outline" className="text-xs px-1.5 bg-blue-500/10 text-blue-500 border-blue-500/30">
                                <Clock className="h-3 w-3 mr-1" />
                                Timeout
                              </Badge>
                            )}
                            
                            {/* Status & Action Buttons */}
                            {isRunning ? (
                              <>
                                <Badge variant="secondary" className="text-xs px-1.5">
                                  {activePair?.messages_exchanged || 0} msgs
                                </Badge>
                                <Button
                                  size="icon"
                                  variant="destructive"
                                  onClick={() => activePair && handleStopSinglePair(activePair.id)}
                                  disabled={stoppingPairId === activePair?.id}
                                  className="h-7 w-7"
                                >
                                  {stoppingPairId === activePair?.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Square className="h-3 w-3" />
                                  )}
                                </Button>
                                <Badge className="bg-green-500 text-white text-xs px-2">
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                  Running
                                </Badge>
                              </>
                            ) : activePair?.status === "failed" ? (
                              <>
                                <Badge variant="destructive" className="text-xs px-1.5 truncate max-w-[100px]">
                                  {activePair.failed_reason || "Failed"}
                                </Badge>
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
                                    <RefreshCw className="h-3 w-3 mr-1" />
                                  )}
                                  Retry
                                </Button>
                              </>
                            ) : activePair?.status === "completed" ? (
                              <>
                                <Badge className="bg-green-500/20 text-green-600 text-xs px-2">
                                  ✓ Done
                                </Badge>
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
                                  Again
                                </Button>
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
                    {displayedSentActivity.messages.length > 0 && (
                      <div className="flex items-center gap-1 ml-1">
                        {displayedSentActivity.sentCount > 0 && (
                          <Badge variant="secondary" className="h-5 px-1.5 text-xs bg-green-500/20 text-green-600">
                            {displayedSentActivity.sentCount}
                          </Badge>
                        )}
                        {displayedSentActivity.failedCount > 0 && (
                          <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                            {displayedSentActivity.failedCount}
                          </Badge>
                        )}
                      </div>
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
                      {displayedSentActivity.messages.length === 0 ? (
                        <p className="text-muted-foreground text-center py-8">
                          No sent messages yet.
                        </p>
                      ) : (
                        displayedSentActivity.messages.map((msg, index) => {
                          const pairNum = getPairNumber(msg.sender?.phone_number || '', msg.receiver?.phone_number || '');
                          const isFailed = msg.status === 'failed';
                          return (
                            <div
                              key={msg.id}
                              className={`p-3 rounded-lg space-y-1 ${
                                isFailed 
                                  ? "bg-red-500/10 border border-red-500/30" 
                                  : "bg-green-500/5 border border-green-500/20"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm">
                                  <Badge variant="outline" className={`h-5 px-1.5 font-semibold shrink-0 ${isFailed ? 'bg-red-500/10 text-red-500 border-red-500/30' : 'bg-green-500/10 text-green-600 border-green-500/30'}`}>
                                    {index + 1}/{displayedSentActivity.messages.length}
                                  </Badge>
                                  {pairNum && (
                                    <Badge variant="outline" className="h-5 px-1.5 font-semibold shrink-0">
                                      P#{pairNum}
                                    </Badge>
                                  )}
                                  <span className="font-mono">
                                    {formatPhone(msg.sender?.phone_number || "Unknown")}
                                  </span>
                                  <span className="text-muted-foreground">→</span>
                                  <span className="font-mono">
                                    {formatPhone(msg.receiver?.phone_number || "Unknown")}
                                  </span>
                                </div>
                                {isFailed ? (
                                  <Badge variant="destructive">Failed</Badge>
                                ) : (
                                  <Badge variant="secondary" className="bg-green-500/20 text-green-600">Sent</Badge>
                                )}
                              </div>
                              <p className="text-sm truncate">{msg.message_content}</p>
                              {isFailed && msg.error_message && (
                                <p className="text-xs text-red-400 truncate">Reason: {msg.error_message}</p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                {format(new Date(msg.sent_at || msg.scheduled_at), "MMM d, HH:mm")}
                              </p>
                            </div>
                          );
                        })
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
                        pendingMessages.map((msg, index) => {
                          const pairNum = getPairNumber(msg.sender?.phone_number || '', msg.receiver?.phone_number || '');
                          return (
                            <div
                              key={msg.id}
                              className="p-3 bg-yellow-500/5 border border-yellow-500/20 rounded-lg space-y-1"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm">
                                  <Badge variant="outline" className="h-5 px-1.5 font-semibold shrink-0 bg-yellow-500/10 text-yellow-600 border-yellow-500/30">
                                    {index + 1}/{stats.pendingMessages}
                                  </Badge>
                                  {pairNum && (
                                    <Badge variant="outline" className="h-5 px-1.5 font-semibold shrink-0">
                                      P#{pairNum}
                                    </Badge>
                                  )}
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
                          );
                        })
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

      {/* Pair Idle Accounts Dialog */}
      <Dialog open={isPairDialogOpen} onOpenChange={setIsPairDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-primary" />
              Pair Idle Accounts
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {/* Pairing Mode Toggle */}
            <div className="flex gap-2">
              <Button
                variant={pairingMode === "auto" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => {
                  setPairingMode("auto");
                  setSelectedAccounts([]);
                }}
              >
                <Layers className="h-4 w-4 mr-2" />
                Auto Pair All
              </Button>
              <Button
                variant={pairingMode === "manual" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => setPairingMode("manual")}
              >
                <MousePointerClick className="h-4 w-4 mr-2" />
                Manual Select
              </Button>
            </div>

            {/* Add to Contacts Toggle */}
            <div 
              className="flex items-center justify-between p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => setAddToContacts(!addToContacts)}
            >
              <div className="flex items-center gap-3">
                <UserPlus className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Add each other to contacts</p>
                  <p className="text-xs text-muted-foreground">Accounts will save each other as contacts when warmup starts</p>
                </div>
              </div>
              <div className={`h-5 w-5 rounded border-2 flex items-center justify-center transition-colors ${addToContacts ? "bg-primary border-primary" : "border-muted-foreground"}`}>
                {addToContacts && <CheckSquare className="h-4 w-4 text-primary-foreground" />}
              </div>
            </div>

            {/* Tag Filter - Only show in auto mode */}
            {pairingMode === "auto" && (
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Tag className="h-4 w-4" />
                  Filter by Tag
                </label>
                <Select value={selectedTag} onValueChange={setSelectedTag}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select tag" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Idle Accounts ({idleAccounts.length})</SelectItem>
                    {availableTags.map(tag => {
                      const count = idleAccounts.filter(a => (a.tags || []).includes(tag)).length;
                      return (
                        <SelectItem key={tag} value={tag}>
                          {tag} ({count})
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Auto Mode Preview */}
            {pairingMode === "auto" && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Accounts to pair: <span className="text-primary">{filteredIdleAccounts.length}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  Will create <span className="font-medium text-foreground">{Math.floor(filteredIdleAccounts.length / 2)}</span> pair(s)
                  {filteredIdleAccounts.length % 2 === 1 && (
                    <span className="text-yellow-500 ml-1">(1 account will remain unpaired)</span>
                  )}
                </p>
                <div className="flex items-center gap-2 text-sm text-blue-500 bg-blue-500/10 px-3 py-2 rounded-md">
                  <UserPlus className="h-4 w-4" />
                  <span>Contacts will be added automatically when warmup starts</span>
                </div>
                
                {filteredIdleAccounts.length > 0 && (
                  <ScrollArea className="h-[150px] border rounded-md p-2">
                    <div className="space-y-1">
                      {filteredIdleAccounts.map((acc, idx) => (
                        <div key={acc.id} className="flex items-center gap-2 text-sm">
                          <Badge variant="outline" className="h-5 px-1.5 text-xs">
                            {idx % 2 === 0 ? `P${Math.floor(idx / 2) + 1}` : "↔"}
                          </Badge>
                          <span className="font-mono text-xs">{acc.phone_number}</span>
                          {acc.first_name && (
                            <span className="text-muted-foreground text-xs">({acc.first_name})</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
                
                {filteredIdleAccounts.length === 0 && (
                  <div className="text-center py-6 text-muted-foreground">
                    <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No idle accounts found</p>
                    <p className="text-xs">All active accounts are already paired</p>
                  </div>
                )}
              </div>
            )}

            {/* Manual Mode - Account Selection */}
            {pairingMode === "manual" && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Select 2 accounts to pair: <span className={selectedAccounts.length === 2 ? "text-green-500" : "text-primary"}>{selectedAccounts.length}/2</span>
                </p>
                
                {idleAccounts.length > 0 ? (
                  <ScrollArea className="h-[200px] border rounded-md p-2">
                    <div className="space-y-1">
                      {idleAccounts.map((acc) => {
                        const isSelected = selectedAccounts.includes(acc.id);
                        const selectionIndex = selectedAccounts.indexOf(acc.id);
                        return (
                          <div 
                            key={acc.id} 
                            className={`flex items-center gap-2 text-sm p-2 rounded cursor-pointer transition-colors ${
                              isSelected ? "bg-primary/20 border border-primary" : "hover:bg-muted"
                            }`}
                            onClick={() => toggleAccountSelection(acc.id)}
                          >
                            <div className={`h-5 w-5 rounded border-2 flex items-center justify-center text-xs font-bold ${
                              isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground"
                            }`}>
                              {isSelected ? selectionIndex + 1 : ""}
                            </div>
                            <span className="font-mono text-xs">{acc.phone_number}</span>
                            {acc.first_name && (
                              <span className="text-muted-foreground text-xs">({acc.first_name})</span>
                            )}
                            {acc.tags && acc.tags.length > 0 && (
                              <Badge variant="secondary" className="text-xs h-4 px-1">
                                {acc.tags[0]}
                              </Badge>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                ) : (
                  <div className="text-center py-6 text-muted-foreground">
                    <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">No idle accounts found</p>
                    <p className="text-xs">All active accounts are already paired</p>
                  </div>
                )}

                {/* Selected Pair Preview */}
                {selectedAccounts.length === 2 && (
                  <div className="flex items-center justify-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <span className="font-mono text-sm">{idleAccounts.find(a => a.id === selectedAccounts[0])?.phone_number}</span>
                    <ArrowLeftRight className="h-4 w-4 text-green-500" />
                    <span className="font-mono text-sm">{idleAccounts.find(a => a.id === selectedAccounts[1])?.phone_number}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsPairDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handlePairIdleAccounts} 
              disabled={
                isPairing || 
                (pairingMode === "auto" && filteredIdleAccounts.length < 2) ||
                (pairingMode === "manual" && selectedAccounts.length !== 2)
              }
            >
              {isPairing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Link2 className="h-4 w-4 mr-2" />
              )}
              {pairingMode === "auto" 
                ? `Create ${Math.floor(filteredIdleAccounts.length / 2)} Pair(s)`
                : "Create Pair"
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Start Warmup Dialog */}
      <Dialog open={isWarmupDialogOpen} onOpenChange={setIsWarmupDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="h-5 w-5 text-orange-500" />
              Start Warmup
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {/* Selection Mode Toggle */}
            <div className="flex gap-2">
              <Button
                variant={warmupSelectMode === "all" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => {
                  setWarmupSelectMode("all");
                  setWarmupSelectedPairs([]);
                }}
              >
                <Layers className="h-4 w-4 mr-2" />
                All Pairs ({prePairedAccounts.length})
              </Button>
              <Button
                variant={warmupSelectMode === "selected" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => setWarmupSelectMode("selected")}
              >
                <MousePointerClick className="h-4 w-4 mr-2" />
                Select Pairs
              </Button>
            </div>

            {/* Tag Filter - Only in selected mode */}
            {warmupSelectMode === "selected" && (
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Tag className="h-4 w-4" />
                  Filter by Tag
                </label>
                <Select value={warmupSelectedTag} onValueChange={setWarmupSelectedTag}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select tag" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Paired Accounts ({prePairedAccounts.length})</SelectItem>
                    {availableTags.map(tag => (
                      <SelectItem key={tag} value={tag}>
                        {tag}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* All Mode Preview */}
            {warmupSelectMode === "all" && (
              <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Total Pairs</span>
                  <Badge variant="secondary" className="font-mono">{prePairedAccounts.length}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  All {prePairedAccounts.length} paired accounts will start warmup with {messagesPerPair[0]}-{messagesPerPair[1]} messages per pair.
                </p>
              </div>
            )}

            {/* Selected Mode - Pair Selection */}
            {warmupSelectMode === "selected" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    Selected: <span className={warmupSelectedPairs.length > 0 ? "text-green-500" : "text-primary"}>{warmupSelectedPairs.length}</span>
                  </p>
                  {warmupSelectedPairs.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setWarmupSelectedPairs([])}
                      className="h-6 px-2 text-xs"
                    >
                      Clear
                    </Button>
                  )}
                </div>
                
                <ScrollArea className="h-[250px] border rounded-md p-2">
                  <div className="space-y-1">
                    {prePairedAccounts.map((pair, idx) => {
                      const isSelected = warmupSelectedPairs.includes(pair.id);
                      return (
                        <div 
                          key={pair.id} 
                          className={`flex items-center gap-2 text-sm p-2 rounded cursor-pointer transition-colors ${
                            isSelected ? "bg-orange-500/20 border border-orange-500/50" : "hover:bg-muted"
                          }`}
                          onClick={() => toggleWarmupPairSelection(pair.id)}
                        >
                          <div className={`h-5 w-5 rounded border-2 flex items-center justify-center text-xs font-bold ${
                            isSelected ? "bg-orange-500 border-orange-500 text-white" : "border-muted-foreground"
                          }`}>
                            {isSelected ? "✓" : ""}
                          </div>
                          <Badge variant="outline" className="h-5 px-1.5 text-xs">
                            #{idx + 1}
                          </Badge>
                          <span className="font-mono text-xs">{pair.phone_number}</span>
                          <ArrowLeftRight className="h-3 w-3 text-muted-foreground" />
                          <span className="font-mono text-xs">{pair.pair_phone}</span>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
            )}

            {/* Messages per pair info */}
            <div className="p-3 bg-muted/30 rounded-lg border border-border/50">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Messages per pair</span>
                <Badge variant="secondary" className="font-mono">{messagesPerPair[0]} - {messagesPerPair[1]}</Badge>
              </div>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsWarmupDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={() => {
                if (warmupSelectMode === "all") {
                  handleStartWarmup();
                } else {
                  handleStartWarmup(warmupSelectedPairs);
                }
              }}
              disabled={isStarting || (warmupSelectMode === "selected" && warmupSelectedPairs.length === 0)}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {isStarting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Start {warmupSelectMode === "all" ? `All ${prePairedAccounts.length} Pairs` : `${warmupSelectedPairs.length} Pair(s)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
