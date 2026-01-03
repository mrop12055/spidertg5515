import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
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
  AlertTriangle,
  Phone
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

interface RestrictedAccount {
  id: string;
  phone_number: string;
  status: string;
  ban_reason: string | null;
  restricted_until: string | null;
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
  // Error breakdown and restricted accounts
  const [failedReasons, setFailedReasons] = useState<{reason: string; count: number}[]>([]);
  const [restrictedAccounts, setRestrictedAccounts] = useState<RestrictedAccount[]>([]);
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
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('block_contact_tasks')
          .select('id, account_id, status, action, target_phone, created_at, result')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('contact_import_tasks')
          .select('id, account_id, status, created_at, result')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('warmup_schedule')
          .select('id, account_id, status, task_type, day_number, task_description, created_at')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('campaign_recipients')
          .select('id, phone_number, name, status, campaign_id, failed_reason')
          .eq('status', 'pending')
          .limit(1000),
        supabase
          .from('messages')
          .select('id, content, status, created_at, conversation_id, failed_reason')
          .in('status', ['pending', 'sending'])
          .order('created_at', { ascending: false })
          .limit(100),
        // Completed tasks
        supabase
          .from('account_check_tasks')
          .select('id, account_id, status, task_type, created_at, result')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('block_contact_tasks')
          .select('id, account_id, status, action, target_phone, created_at, result')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('contact_import_tasks')
          .select('id, account_id, status, created_at, result')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('warmup_schedule')
          .select('id, account_id, status, task_type, day_number, task_description, created_at')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('campaign_recipients')
          .select('id, phone_number, name, status, campaign_id, failed_reason')
          .in('status', ['sent', 'failed'])
          .order('sent_at', { ascending: false })
          .limit(200),
        supabase
          .from('messages')
          .select('id, content, status, created_at, conversation_id, failed_reason')
          .in('status', ['sent', 'delivered', 'read', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100)
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

      // Fetch error breakdown - ALL records with failed_reason (any status)
      const { data: failedRecipients } = await supabase
        .from('campaign_recipients')
        .select('failed_reason')
        .not('failed_reason', 'is', null);

      // Also fetch messages with failed_reason (any status)
      const { data: failedMessages } = await supabase
        .from('messages')
        .select('failed_reason')
        .not('failed_reason', 'is', null);

      // Count failed reasons from both sources
      const reasonCounts: Record<string, number> = {};
      (failedRecipients || []).forEach(r => {
        const reason = r.failed_reason || 'Unknown error';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      });
      (failedMessages || []).forEach(m => {
        const reason = m.failed_reason || 'Unknown error';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      });
      
      setFailedReasons(
        Object.entries(reasonCounts)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count)
      );

      // Fetch restricted accounts
      const { data: restrictedData } = await supabase
        .from('telegram_accounts')
        .select('id, phone_number, status, ban_reason, restricted_until')
        .or('status.eq.restricted,status.eq.cooldown,status.eq.frozen')
        .order('restricted_until', { ascending: true });

      setRestrictedAccounts(restrictedData || []);

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
        action={
          <Button onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {/* Health Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Users className="w-5 h-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{health?.active_accounts || 0}</p>
                <p className="text-xs text-muted-foreground">Active Accounts</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Shield className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{health?.active_proxies || 0}</p>
                <p className="text-xs text-muted-foreground">Active Proxies</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <MessageSquare className="w-5 h-5 text-purple-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{health?.total_conversations || 0}</p>
                <p className="text-xs text-muted-foreground">Conversations</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-500/10">
                <Clock className="w-5 h-5 text-yellow-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{health?.pending_recipients || 0}</p>
                <p className="text-xs text-muted-foreground">Pending Recipients</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pending Tasks Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <Card className="border-yellow-500/30">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-yellow-500">{health?.pending_account_tasks || 0}</p>
              <p className="text-xs text-muted-foreground">Account Tasks</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-yellow-500/30">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-yellow-500">{health?.pending_block_tasks || 0}</p>
              <p className="text-xs text-muted-foreground">Block Tasks</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-yellow-500/30">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-yellow-500">{health?.pending_import_tasks || 0}</p>
              <p className="text-xs text-muted-foreground">Import Tasks</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-orange-500/30">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-orange-500">{warmupTasks.length}</p>
              <p className="text-xs text-muted-foreground">Warmup Tasks</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-red-500/30">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-red-500">{health?.stuck_messages || 0}</p>
              <p className="text-xs text-muted-foreground">Stuck Messages</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error Breakdown & Restricted Accounts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Error Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              Error Breakdown
            </CardTitle>
            <CardDescription>Most common failure reasons</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[300px]">
              {failedReasons.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-50 text-primary" />
                  <p>No errors recorded</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {failedReasons.map((item, index) => (
                    <div key={index} className="p-3 rounded-lg border bg-muted/30 border-border/50">
                      <div className="flex items-center justify-between mb-2">
                        <Badge variant="secondary" className="bg-destructive/10 text-destructive border-destructive/20">
                          {item.count} occurrences
                        </Badge>
                      </div>
                      <p className="text-sm">{item.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Restricted Accounts */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-muted-foreground" />
              Restricted Accounts
            </CardTitle>
            <CardDescription>Accounts with sending limitations</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[300px]">
              {restrictedAccounts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-50 text-primary" />
                  <p>No restricted accounts</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {restrictedAccounts.map(account => (
                    <div key={account.id} className="p-3 rounded-lg border bg-muted/30 border-border/50">
                      <div className="flex items-center gap-2 mb-2">
                        <Phone className="w-4 h-4" />
                        <span className="font-medium">{account.phone_number}</span>
                      </div>
                      {account.ban_reason && (
                        <p className="text-sm text-muted-foreground">{account.ban_reason}</p>
                      )}
                      {account.restricted_until && (
                        <p className="text-xs text-muted-foreground mt-1">
                          <Clock className="w-3 h-3 inline mr-1" />
                          Until: {format(new Date(account.restricted_until), 'MMM d, HH:mm')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Task Tables */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            Task Queue Management
            <Badge variant="outline" className="ml-2 bg-green-500/10 text-green-500 border-green-500/30">
              <Activity className="w-3 h-3 mr-1" />
              Live
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="account" className="w-full">
            <TabsList className="grid w-full grid-cols-6">
              <TabsTrigger value="account">
                Account
                {(health?.pending_account_tasks || 0) > 0 && (
                  <Badge variant="destructive" className="ml-1 text-xs px-1">
                    {health?.pending_account_tasks}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="block">
                Block
                {(health?.pending_block_tasks || 0) > 0 && (
                  <Badge variant="destructive" className="ml-1 text-xs px-1">
                    {health?.pending_block_tasks}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="import">
                Import
                {(health?.pending_import_tasks || 0) > 0 && (
                  <Badge variant="destructive" className="ml-1 text-xs px-1">
                    {health?.pending_import_tasks}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="warmup">
                <Zap className="w-3 h-3 mr-1" />
                Warmup
                {warmupTasks.length > 0 && (
                  <Badge variant="destructive" className="ml-1 text-xs px-1">
                    {warmupTasks.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="recipients">
                <UserCheck className="w-3 h-3 mr-1" />
                Recipients
                {(health?.pending_recipients || 0) > 0 && (
                  <Badge variant="destructive" className="ml-1 text-xs px-1">
                    {health?.pending_recipients}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="messages">
                <Send className="w-3 h-3 mr-1" />
                Messages
                {(health?.pending_messages || 0) > 0 && (
                  <Badge variant="destructive" className="ml-1 text-xs px-1">
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
    </DashboardLayout>
  );
};

export default DatabaseHealth;
