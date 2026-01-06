import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatCard } from '@/components/ui/stat-card';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { motion } from 'framer-motion';
import { 
  RefreshCw, 
  Trash2, 
  Database, 
  CheckCircle, 
  Clock, 
  AlertCircle,
  Activity,
  Users,
  MessageSquare,
  Shield,
  Zap,
  Send,
  UserCheck,
  Phone,
  ListTodo,
  Ban,
  Upload,
  Flame,
  AlertTriangle
} from 'lucide-react';
import { format } from 'date-fns';

interface SystemHealth {
  active_accounts: number;
  active_proxies: number;
  pending_messages: number;
  stuck_messages: number;
  pending_recipients: number;
  pending_account_tasks: number;
  pending_block_tasks: number;
  pending_import_tasks: number;
  total_conversations: number;
}

interface Task {
  id: string;
  account_id: string;
  status: string;
  task_type?: string;
  action?: string;
  created_at: string;
  result?: string;
  phone_number?: string;
  day_number?: number;
  task_description?: string;
}

interface Recipient {
  id: string;
  phone_number: string;
  name: string | null;
  status: string | null;
  campaign_id: string;
  failed_reason: string | null;
}

interface PendingMessage {
  id: string;
  content: string;
  status: string | null;
  created_at: string | null;
  conversation_id: string;
  failed_reason: string | null;
}


const DatabaseHealth = () => {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [accountTasks, setAccountTasks] = useState<Task[]>([]);
  const [blockTasks, setBlockTasks] = useState<Task[]>([]);
  const [importTasks, setImportTasks] = useState<Task[]>([]);
  const [warmupTasks, setWarmupTasks] = useState<Task[]>([]);
  const [pendingRecipients, setPendingRecipients] = useState<Recipient[]>([]);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  // Completed tasks state
  const [completedAccountTasks, setCompletedAccountTasks] = useState<Task[]>([]);
  const [completedBlockTasks, setCompletedBlockTasks] = useState<Task[]>([]);
  const [completedImportTasks, setCompletedImportTasks] = useState<Task[]>([]);
  const [completedWarmupTasks, setCompletedWarmupTasks] = useState<Task[]>([]);
  const [completedRecipients, setCompletedRecipients] = useState<Recipient[]>([]);
  const [completedMessages, setCompletedMessages] = useState<PendingMessage[]>([]);
  // Recent individual errors with timestamps from ALL sources
  const [recentErrors, setRecentErrors] = useState<{id: string; phone: string; reason: string; timestamp: string; source: string}[]>([]);
  const [restrictedAccountsCount, setRestrictedAccountsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async () => {
    try {
      // Fetch system health
      const { data: healthData } = await supabase
        .from('system_health')
        .select('*')
        .maybeSingle();

      if (healthData) {
        setHealth(healthData as SystemHealth);
      }

      // Fetch pending and completed tasks
      const [
        accountRes, blockRes, importRes, warmupRes, recipientsRes, messagesRes,
        completedAccountRes, completedBlockRes, completedImportRes, completedWarmupRes, 
        completedRecipientsRes, completedMessagesRes
      ] = await Promise.all([
        // Pending tasks
        supabase
          .from('account_check_tasks')
          .select('id, account_id, status, task_type, created_at, result')
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),
        supabase
          .from('block_contact_tasks')
          .select('id, account_id, status, action, target_phone, created_at, result')
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),
        supabase
          .from('contact_import_tasks')
          .select('id, account_id, status, created_at, result')
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),
        supabase
          .from('warmup_schedule')
          .select('id, account_id, status, task_type, day_number, task_description, created_at')
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),
        supabase
          .from('campaign_recipients')
          .select('id, phone_number, name, status, campaign_id, failed_reason')
          .eq('status', 'pending'),
        supabase
          .from('messages')
          .select('id, content, status, created_at, conversation_id, failed_reason')
          .in('status', ['pending', 'sending'])
          .order('created_at', { ascending: false }),
        // Completed tasks
        supabase
          .from('account_check_tasks')
          .select('id, account_id, status, task_type, created_at, result')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false }),
        supabase
          .from('block_contact_tasks')
          .select('id, account_id, status, action, target_phone, created_at, result')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false }),
        supabase
          .from('contact_import_tasks')
          .select('id, account_id, status, created_at, result')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false }),
        supabase
          .from('warmup_schedule')
          .select('id, account_id, status, task_type, day_number, task_description, created_at')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false }),
        supabase
          .from('campaign_recipients')
          .select('id, phone_number, name, status, campaign_id, failed_reason')
          .in('status', ['sent', 'failed'])
          .order('sent_at', { ascending: false }),
        supabase
          .from('messages')
          .select('id, content, status, created_at, conversation_id, failed_reason')
          .in('status', ['sent', 'delivered', 'read', 'failed'])
          .order('created_at', { ascending: false })
      ]);

      // Set pending tasks
      if (accountRes.data) setAccountTasks(accountRes.data);
      if (blockRes.data) setBlockTasks(blockRes.data.map(t => ({ ...t, phone_number: t.target_phone })));
      if (importRes.data) setImportTasks(importRes.data);
      if (warmupRes.data) setWarmupTasks(warmupRes.data);
      if (recipientsRes.data) setPendingRecipients(recipientsRes.data);
      if (messagesRes.data) setPendingMessages(messagesRes.data);

      // Set completed tasks
      if (completedAccountRes.data) setCompletedAccountTasks(completedAccountRes.data);
      if (completedBlockRes.data) setCompletedBlockTasks(completedBlockRes.data.map(t => ({ ...t, phone_number: t.target_phone })));
      if (completedImportRes.data) setCompletedImportTasks(completedImportRes.data);
      if (completedWarmupRes.data) setCompletedWarmupTasks(completedWarmupRes.data);
      if (completedRecipientsRes.data) setCompletedRecipients(completedRecipientsRes.data);
      if (completedMessagesRes.data) setCompletedMessages(completedMessagesRes.data);


      // Fetch recent individual errors from ALL sources (last 100 each)
      const [
        failedRecipientsRes,
        failedMessagesRes,
        failedAccountTasksRes,
        failedBlockTasksRes,
        failedImportTasksRes,
        failedWarmupRes,
        accountErrorsRes,
        restrictedCountRes
      ] = await Promise.all([
        supabase
          .from('campaign_recipients')
          .select('id, phone_number, failed_reason, sent_at')
          .eq('status', 'failed')
          .not('failed_reason', 'is', null)
          .order('sent_at', { ascending: false, nullsFirst: false })
          .limit(100),
        supabase
          .from('messages')
          .select('id, failed_reason, created_at, conversation_id')
          .eq('status', 'failed')
          .not('failed_reason', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('account_check_tasks')
          .select('id, account_id, result, created_at')
          .eq('status', 'failed')
          .not('result', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('block_contact_tasks')
          .select('id, target_phone, result, created_at')
          .eq('status', 'failed')
          .not('result', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('contact_import_tasks')
          .select('id, result, created_at')
          .eq('status', 'failed')
          .not('result', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('warmup_schedule')
          .select('id, account_id, task_type, created_at')
          .eq('status', 'failed')
          .order('created_at', { ascending: false })
          .limit(100),
        // Account errors - accounts with ban_reason (restricted, banned, frozen, disconnected)
        supabase
          .from('telegram_accounts')
          .select('id, phone_number, status, ban_reason, restricted_until, created_at')
          .not('ban_reason', 'is', null)
          .neq('ban_reason', '')
          .order('restricted_until', { ascending: false, nullsFirst: false })
          .limit(100),
        // Count restricted accounts
        supabase
          .from('telegram_accounts')
          .select('id', { count: 'exact', head: true })
          .in('status', ['restricted', 'cooldown'])
      ]);

      // Set restricted accounts count
      setRestrictedAccountsCount(restrictedCountRes.count || 0);

      // Combine all errors into a single array
      const allErrors: {id: string; phone: string; reason: string; timestamp: string; source: string}[] = [];

      // Campaign recipients errors
      (failedRecipientsRes.data || []).forEach(r => {
        allErrors.push({
          id: r.id,
          phone: r.phone_number,
          reason: r.failed_reason || 'Unknown error',
          timestamp: r.sent_at || new Date().toISOString(),
          source: 'Campaign'
        });
      });

      // Message errors
      (failedMessagesRes.data || []).forEach(m => {
        allErrors.push({
          id: m.id,
          phone: m.conversation_id?.substring(0, 8) || 'Unknown',
          reason: m.failed_reason || 'Unknown error',
          timestamp: m.created_at || new Date().toISOString(),
          source: 'Message'
        });
      });

      // Account check task errors
      (failedAccountTasksRes.data || []).forEach(t => {
        allErrors.push({
          id: t.id,
          phone: t.account_id?.substring(0, 8) || 'Unknown',
          reason: t.result || 'Account check failed',
          timestamp: t.created_at || new Date().toISOString(),
          source: 'Account Check'
        });
      });

      // Block task errors
      (failedBlockTasksRes.data || []).forEach(t => {
        allErrors.push({
          id: t.id,
          phone: t.target_phone || 'Unknown',
          reason: t.result || 'Block task failed',
          timestamp: t.created_at || new Date().toISOString(),
          source: 'Block Task'
        });
      });

      // Import task errors
      (failedImportTasksRes.data || []).forEach(t => {
        allErrors.push({
          id: t.id,
          phone: 'Import',
          reason: t.result || 'Import failed',
          timestamp: t.created_at || new Date().toISOString(),
          source: 'Import'
        });
      });

      // Warmup errors
      (failedWarmupRes.data || []).forEach(w => {
        allErrors.push({
          id: w.id,
          phone: w.account_id?.substring(0, 8) || 'Unknown',
          reason: `Warmup ${w.task_type} failed`,
          timestamp: w.created_at || new Date().toISOString(),
          source: 'Warmup'
        });
      });

      // Account errors (restricted, banned, frozen, disconnected with ban_reason)
      (accountErrorsRes.data || []).forEach(a => {
        allErrors.push({
          id: a.id,
          phone: a.phone_number,
          reason: `[${a.status?.toUpperCase()}] ${a.ban_reason}`,
          timestamp: a.restricted_until || a.created_at || new Date().toISOString(),
          source: 'Account'
        });
      });

      // Sort by timestamp descending and take latest 300
      allErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setRecentErrors(allErrors.slice(0, 300));

    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Set up real-time subscriptions
    const channel = supabase
      .channel('database-health-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'account_check_tasks' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'block_contact_tasks' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contact_import_tasks' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'warmup_schedule' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_recipients' }, () => fetchData())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
    toast({ title: 'Data refreshed' });
  };

  const clearPendingTasks = async (table: 'account_check_tasks' | 'block_contact_tasks' | 'contact_import_tasks' | 'warmup_schedule') => {
    try {
      const { error } = await supabase.from(table).delete().eq('status', 'pending');
      if (error) throw error;
      toast({ title: `Cleared pending tasks` });
      fetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };


  const deleteTask = async (table: 'account_check_tasks' | 'block_contact_tasks' | 'contact_import_tasks' | 'warmup_schedule', id: string) => {
    try {
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) throw error;
      toast({ title: 'Task deleted' });
      fetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const clearPendingRecipients = async () => {
    try {
      const { error } = await supabase.from('campaign_recipients').delete().eq('status', 'pending');
      if (error) throw error;
      toast({ title: 'Cleared pending recipients' });
      fetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const deleteRecipient = async (id: string) => {
    try {
      const { error } = await supabase.from('campaign_recipients').delete().eq('id', id);
      if (error) throw error;
      toast({ title: 'Recipient deleted' });
      fetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const clearPendingMessages = async () => {
    try {
      const { error } = await supabase.from('messages').delete().in('status', ['pending', 'sending']);
      if (error) throw error;
      toast({ title: 'Cleared pending messages' });
      fetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const deleteMessage = async (id: string) => {
    try {
      const { error } = await supabase.from('messages').delete().eq('id', id);
      if (error) throw error;
      toast({ title: 'Message deleted' });
      fetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      case 'completed':
        return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>;
      case 'failed':
        return <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/30"><AlertCircle className="w-3 h-3 mr-1" />Failed</Badge>;
      case 'in_progress':
      case 'sending':
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/30"><Activity className="w-3 h-3 mr-1" />In Progress</Badge>;
      case 'sent':
        return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30"><CheckCircle className="w-3 h-3 mr-1" />Sent</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const TaskTable = ({ 
    tasks, 
    tableName, 
    showDayNumber = false,
    isPending = true 
  }: { 
    tasks: Task[], 
    tableName: 'account_check_tasks' | 'block_contact_tasks' | 'contact_import_tasks' | 'warmup_schedule',
    showDayNumber?: boolean,
    isPending?: boolean
  }) => {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Badge variant="outline" className={isPending ? "bg-yellow-500/10 text-yellow-500" : "bg-green-500/10 text-green-500"}>
            {tasks.length} {isPending ? 'pending' : 'completed/failed'}
          </Badge>
          {isPending && tasks.length > 0 && (
            <Button variant="destructive" size="sm" onClick={() => clearPendingTasks(tableName)}>
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All Pending
            </Button>
          )}
        </div>
        
        <div className="rounded-md border max-h-[400px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                {showDayNumber && <TableHead>Day</TableHead>}
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Result/Description</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={showDayNumber ? 6 : 5} className="text-center text-muted-foreground py-8">
                    No {isPending ? 'pending' : 'completed'} tasks
                  </TableCell>
                </TableRow>
              ) : (
                tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-mono text-xs">
                      {task.task_type || task.action || 'import'}
                    </TableCell>
                    {showDayNumber && (
                      <TableCell className="text-xs">
                        {task.day_number !== undefined ? `Day ${task.day_number}` : '-'}
                      </TableCell>
                    )}
                    <TableCell>{getStatusBadge(task.status)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(task.created_at), 'MMM d, HH:mm')}
                    </TableCell>
                    <TableCell className={`text-xs max-w-[200px] truncate ${task.status === 'failed' || task.result ? 'text-red-500' : task.status === 'completed' ? 'text-green-500' : ''}`}>
                      {task.result || task.task_description || '-'}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => deleteTask(tableName, task.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  };

  const TaskTabContent = ({ 
    pendingTasks, 
    completedTasks, 
    tableName, 
    showDayNumber = false 
  }: { 
    pendingTasks: Task[], 
    completedTasks: Task[], 
    tableName: 'account_check_tasks' | 'block_contact_tasks' | 'contact_import_tasks' | 'warmup_schedule',
    showDayNumber?: boolean 
  }) => (
    <Tabs defaultValue="pending" className="w-full">
      <TabsList className="grid w-full grid-cols-2 max-w-[300px]">
        <TabsTrigger value="pending" className="text-xs">
          <Clock className="w-3 h-3 mr-1" />
          Pending ({pendingTasks.length})
        </TabsTrigger>
        <TabsTrigger value="completed" className="text-xs">
          <CheckCircle className="w-3 h-3 mr-1" />
          Completed ({completedTasks.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pending" className="mt-3">
        <TaskTable tasks={pendingTasks} tableName={tableName} showDayNumber={showDayNumber} isPending={true} />
      </TabsContent>
      <TabsContent value="completed" className="mt-3">
        <TaskTable tasks={completedTasks} tableName={tableName} showDayNumber={showDayNumber} isPending={false} />
      </TabsContent>
    </Tabs>
  );

  

  return (
    <DashboardLayout>
      <PageHeader
        title="Database Health"
        description="Monitor system health and manage pending tasks (real-time updates)"
        icon={Database}
        action={
          <Button onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {/* System Overview - Main Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Active Accounts"
          value={health?.active_accounts || 0}
          icon={Users}
          variant="success"
          index={0}
        />
        <StatCard
          title="Restricted"
          value={restrictedAccountsCount}
          icon={AlertCircle}
          variant="warning"
          index={1}
        />
        <StatCard
          title="Active Proxies"
          value={health?.active_proxies || 0}
          icon={Shield}
          variant="primary"
          index={2}
        />
        <StatCard
          title="Conversations"
          value={health?.total_conversations || 0}
          icon={MessageSquare}
          variant="default"
          index={3}
        />
      </div>

      {/* Pending Tasks Summary */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.3 }}
        className="mb-6"
      >
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 rounded-xl bg-yellow-500/10">
            <Clock className="w-5 h-5 text-yellow-500" />
          </div>
          <h2 className="text-lg font-semibold">Pending Queue</h2>
          <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/30">
            {(health?.pending_account_tasks || 0) + (health?.pending_block_tasks || 0) + 
             (health?.pending_import_tasks || 0) + warmupTasks.length + (health?.pending_messages || 0)} total
          </Badge>
        </div>
        
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Account', value: health?.pending_account_tasks || 0, icon: UserCheck, color: 'yellow' },
            { label: 'Block', value: health?.pending_block_tasks || 0, icon: Ban, color: 'yellow' },
            { label: 'Import', value: health?.pending_import_tasks || 0, icon: Upload, color: 'yellow' },
            { label: 'Warmup', value: warmupTasks.length, icon: Flame, color: 'orange' },
            { label: 'Recipients', value: health?.pending_recipients || 0, icon: Send, color: 'blue' },
            { label: 'Stuck', value: health?.stuck_messages || 0, icon: AlertTriangle, color: 'red' },
          ].map((item, idx) => (
            <motion.div
              key={item.label}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, delay: 0.4 + idx * 0.05 }}
              className={`relative overflow-hidden rounded-xl border p-4 bg-card hover:shadow-md transition-all duration-200 ${
                item.color === 'red' ? 'border-red-500/30' : 
                item.color === 'orange' ? 'border-orange-500/30' : 
                item.color === 'blue' ? 'border-blue-500/30' : 
                'border-yellow-500/30'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className={`text-2xl font-bold ${
                    item.color === 'red' ? 'text-red-500' : 
                    item.color === 'orange' ? 'text-orange-500' : 
                    item.color === 'blue' ? 'text-blue-500' : 
                    'text-yellow-500'
                  }`}>
                    {item.value}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.label}</p>
                </div>
                <div className={`p-2 rounded-lg ${
                  item.color === 'red' ? 'bg-red-500/10' : 
                  item.color === 'orange' ? 'bg-orange-500/10' : 
                  item.color === 'blue' ? 'bg-blue-500/10' : 
                  'bg-yellow-500/10'
                }`}>
                  <item.icon className={`w-4 h-4 ${
                    item.color === 'red' ? 'text-red-500' : 
                    item.color === 'orange' ? 'text-orange-500' : 
                    item.color === 'blue' ? 'text-blue-500' : 
                    'text-yellow-500'
                  }`} />
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* Task Tables */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.5 }}
      >
        <Card className="mb-6 overflow-hidden">
          <CardHeader className="bg-gradient-to-r from-muted/50 to-transparent border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-primary/10">
                  <ListTodo className="w-5 h-5 text-primary" />
                </div>
                <span>Task Queue Management</span>
                <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30">
                  <Activity className="w-3 h-3 mr-1" />
                  Live
                </Badge>
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <Tabs defaultValue="account" className="w-full">
              <TabsList className="grid w-full grid-cols-6 h-auto p-1 bg-muted/50">
                <TabsTrigger value="account" className="flex items-center gap-1.5 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <UserCheck className="w-4 h-4" />
                  <span className="hidden sm:inline">Account</span>
                  {(health?.pending_account_tasks || 0) > 0 && (
                    <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0 h-5">
                      {health?.pending_account_tasks}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="block" className="flex items-center gap-1.5 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <Ban className="w-4 h-4" />
                  <span className="hidden sm:inline">Block</span>
                  {(health?.pending_block_tasks || 0) > 0 && (
                    <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0 h-5">
                      {health?.pending_block_tasks}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="import" className="flex items-center gap-1.5 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <Upload className="w-4 h-4" />
                  <span className="hidden sm:inline">Import</span>
                  {(health?.pending_import_tasks || 0) > 0 && (
                    <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0 h-5">
                      {health?.pending_import_tasks}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="warmup" className="flex items-center gap-1.5 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <Flame className="w-4 h-4" />
                  <span className="hidden sm:inline">Warmup</span>
                  {warmupTasks.length > 0 && (
                    <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0 h-5">
                      {warmupTasks.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="recipients" className="flex items-center gap-1.5 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <Send className="w-4 h-4" />
                  <span className="hidden sm:inline">Recipients</span>
                  {(health?.pending_recipients || 0) > 0 && (
                    <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0 h-5">
                      {health?.pending_recipients}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="messages" className="flex items-center gap-1.5 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                  <MessageSquare className="w-4 h-4" />
                  <span className="hidden sm:inline">Messages</span>
                  {(health?.pending_messages || 0) > 0 && (
                    <Badge variant="destructive" className="ml-1 text-xs px-1.5 py-0 h-5">
                      {health?.pending_messages}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            
            <TabsContent value="account" className="mt-4">
              <TaskTabContent 
                pendingTasks={accountTasks} 
                completedTasks={completedAccountTasks} 
                tableName="account_check_tasks" 
              />
            </TabsContent>
            
            <TabsContent value="block" className="mt-4">
              <TaskTabContent 
                pendingTasks={blockTasks} 
                completedTasks={completedBlockTasks} 
                tableName="block_contact_tasks" 
              />
            </TabsContent>
            
            <TabsContent value="import" className="mt-4">
              <TaskTabContent 
                pendingTasks={importTasks} 
                completedTasks={completedImportTasks} 
                tableName="contact_import_tasks" 
              />
            </TabsContent>
            
            <TabsContent value="warmup" className="mt-4">
              <TaskTabContent 
                pendingTasks={warmupTasks} 
                completedTasks={completedWarmupTasks} 
                tableName="warmup_schedule" 
                showDayNumber 
              />
            </TabsContent>

            <TabsContent value="recipients" className="mt-4">
              <Tabs defaultValue="pending" className="w-full">
                <TabsList className="grid w-full grid-cols-2 max-w-[300px]">
                  <TabsTrigger value="pending" className="text-xs">
                    <Clock className="w-3 h-3 mr-1" />
                    Pending ({health?.pending_recipients || pendingRecipients.length})
                  </TabsTrigger>
                  <TabsTrigger value="completed" className="text-xs">
                    <CheckCircle className="w-3 h-3 mr-1" />
                    Sent/Failed ({completedRecipients.length})
                  </TabsTrigger>
                </TabsList>
                
                <TabsContent value="pending" className="mt-3">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500">
                          {health?.pending_recipients || pendingRecipients.length} pending
                        </Badge>
                        {pendingRecipients.length < (health?.pending_recipients || 0) && (
                          <span className="text-xs text-muted-foreground">
                            (showing {pendingRecipients.length})
                          </span>
                        )}
                      </div>
                      {pendingRecipients.length > 0 && (
                        <Button variant="destructive" size="sm" onClick={clearPendingRecipients}>
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete All Pending
                        </Button>
                      )}
                    </div>
                    
                    <div className="rounded-md border max-h-[400px] overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Phone</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Error</TableHead>
                            <TableHead className="w-[80px]">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {pendingRecipients.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                                No pending recipients
                              </TableCell>
                            </TableRow>
                          ) : (
                            pendingRecipients.map((recipient) => (
                              <TableRow key={recipient.id}>
                                <TableCell className="font-mono text-xs">{recipient.phone_number}</TableCell>
                                <TableCell className="text-xs">{recipient.name || '-'}</TableCell>
                                <TableCell>{getStatusBadge(recipient.status || 'pending')}</TableCell>
                                <TableCell className="text-xs max-w-[200px] truncate text-red-500">
                                  {recipient.failed_reason || '-'}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={() => deleteRecipient(recipient.id)}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </TabsContent>
                
                <TabsContent value="completed" className="mt-3">
                  <div className="space-y-4">
                    <Badge variant="outline" className="bg-green-500/10 text-green-500">
                      {completedRecipients.length} sent/failed
                    </Badge>
                    
                    <div className="rounded-md border max-h-[400px] overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Phone</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Result</TableHead>
                            <TableHead className="w-[80px]">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {completedRecipients.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                                No completed recipients
                              </TableCell>
                            </TableRow>
                          ) : (
                            completedRecipients.map((recipient) => (
                              <TableRow key={recipient.id}>
                                <TableCell className="font-mono text-xs">{recipient.phone_number}</TableCell>
                                <TableCell className="text-xs">{recipient.name || '-'}</TableCell>
                                <TableCell>{getStatusBadge(recipient.status || 'sent')}</TableCell>
                                <TableCell className={`text-xs max-w-[200px] truncate ${recipient.status === 'failed' ? 'text-red-500' : 'text-green-500'}`}>
                                  {recipient.failed_reason || 'Success'}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={() => deleteRecipient(recipient.id)}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="messages" className="mt-4">
              <Tabs defaultValue="pending" className="w-full">
                <TabsList className="grid w-full grid-cols-2 max-w-[300px]">
                  <TabsTrigger value="pending" className="text-xs">
                    <Clock className="w-3 h-3 mr-1" />
                    Pending ({pendingMessages.length})
                  </TabsTrigger>
                  <TabsTrigger value="completed" className="text-xs">
                    <CheckCircle className="w-3 h-3 mr-1" />
                    Sent/Failed ({completedMessages.length})
                  </TabsTrigger>
                </TabsList>
                
                <TabsContent value="pending" className="mt-3">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <Badge variant="secondary">{pendingMessages.length} pending/sending</Badge>
                      {pendingMessages.length > 0 && (
                        <Button variant="destructive" size="sm" onClick={clearPendingMessages}>
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete All Pending
                        </Button>
                      )}
                    </div>
                    
                    <div className="rounded-md border max-h-[400px] overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Content</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead>Error</TableHead>
                            <TableHead className="w-[80px]">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {pendingMessages.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                                No pending messages
                              </TableCell>
                            </TableRow>
                          ) : (
                            pendingMessages.map((msg) => (
                              <TableRow key={msg.id}>
                                <TableCell className="text-xs max-w-[250px] truncate">{msg.content}</TableCell>
                                <TableCell>{getStatusBadge(msg.status || 'pending')}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {msg.created_at ? format(new Date(msg.created_at), 'MMM d, HH:mm') : '-'}
                                </TableCell>
                                <TableCell className="text-xs max-w-[150px] truncate text-red-500">
                                  {msg.failed_reason || '-'}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={() => deleteMessage(msg.id)}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </TabsContent>
                
                <TabsContent value="completed" className="mt-3">
                  <div className="space-y-4">
                    <Badge variant="outline" className="bg-green-500/10 text-green-500">
                      {completedMessages.length} sent/delivered/failed
                    </Badge>
                    
                    <div className="rounded-md border max-h-[400px] overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Content</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead>Result</TableHead>
                            <TableHead className="w-[80px]">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {completedMessages.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                                No completed messages
                              </TableCell>
                            </TableRow>
                          ) : (
                            completedMessages.map((msg) => (
                              <TableRow key={msg.id}>
                                <TableCell className="text-xs max-w-[250px] truncate">{msg.content}</TableCell>
                                <TableCell>{getStatusBadge(msg.status || 'sent')}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {msg.created_at ? format(new Date(msg.created_at), 'MMM d, HH:mm') : '-'}
                                </TableCell>
                                <TableCell className={`text-xs max-w-[150px] truncate ${msg.status === 'failed' ? 'text-red-500' : 'text-green-500'}`}>
                                  {msg.failed_reason || 'Success'}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={() => deleteMessage(msg.id)}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      </motion.div>

      {/* Recent Errors Log */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.6 }}
      >
        <Card className="overflow-hidden">
          <CardHeader className="bg-gradient-to-r from-destructive/10 to-transparent border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-destructive/10">
                  <AlertTriangle className="w-5 h-5 text-destructive" />
                </div>
                <span>Recent Errors</span>
                <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
                  <Activity className="w-3 h-3 mr-1" />
                  Live Feed
                </Badge>
                <Badge variant="secondary" className="font-mono">
                  {recentErrors.length}
                </Badge>
              </CardTitle>
            </div>
            <CardDescription className="mt-2">
              Latest 300 errors from all sources (campaigns, messages, tasks, warmup, accounts)
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[400px]">
              {recentErrors.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground">
                  <div className="p-4 rounded-full bg-green-500/10 w-fit mx-auto mb-4">
                    <CheckCircle className="w-10 h-10 text-green-500" />
                  </div>
                  <p className="font-medium">No recent errors</p>
                  <p className="text-sm mt-1">All systems running smoothly</p>
                </div>
              ) : (
                <div className="divide-y">
                  {recentErrors.map((error, idx) => (
                    <motion.div 
                      key={`${error.source}-${error.id}`} 
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, delay: idx * 0.02 }}
                      className="p-4 hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Badge 
                            variant="outline" 
                            className={`text-xs ${
                              error.source === 'Account' ? 'bg-orange-500/10 text-orange-500 border-orange-500/30' :
                              error.source === 'Campaign' ? 'bg-blue-500/10 text-blue-500 border-blue-500/30' :
                              error.source === 'Warmup' ? 'bg-purple-500/10 text-purple-500 border-purple-500/30' :
                              'bg-muted'
                            }`}
                          >
                            {error.source}
                          </Badge>
                          <span className="font-mono text-sm text-muted-foreground">{error.phone}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(error.timestamp), 'MMM d, HH:mm:ss')}
                        </span>
                      </div>
                      <p className="text-sm text-destructive line-clamp-2">{error.reason}</p>
                    </motion.div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </motion.div>
    </DashboardLayout>
  );
};

export default DatabaseHealth;
