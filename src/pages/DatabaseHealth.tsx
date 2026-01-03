import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  Zap
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

const DatabaseHealth = () => {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [accountTasks, setAccountTasks] = useState<Task[]>([]);
  const [blockTasks, setBlockTasks] = useState<Task[]>([]);
  const [importTasks, setImportTasks] = useState<Task[]>([]);
  const [warmupTasks, setWarmupTasks] = useState<Task[]>([]);
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

      // Fetch all task types in parallel
      const [accountRes, blockRes, importRes, warmupRes] = await Promise.all([
        supabase
          .from('account_check_tasks')
          .select('id, account_id, status, task_type, created_at, result')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('block_contact_tasks')
          .select('id, account_id, status, action, target_phone, created_at, result')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('contact_import_tasks')
          .select('id, account_id, status, created_at, result')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('warmup_schedule')
          .select('id, account_id, status, task_type, day_number, task_description, created_at')
          .order('created_at', { ascending: false })
          .limit(100)
      ]);

      if (accountRes.data) setAccountTasks(accountRes.data);
      if (blockRes.data) setBlockTasks(blockRes.data.map(t => ({ ...t, phone_number: t.target_phone })));
      if (importRes.data) setImportTasks(importRes.data);
      if (warmupRes.data) setWarmupTasks(warmupRes.data);

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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/30"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      case 'completed':
        return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>;
      case 'failed':
        return <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/30"><AlertCircle className="w-3 h-3 mr-1" />Failed</Badge>;
      case 'in_progress':
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/30"><Activity className="w-3 h-3 mr-1" />In Progress</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const TaskTable = ({ tasks, tableName, showDayNumber = false }: { 
    tasks: Task[], 
    tableName: 'account_check_tasks' | 'block_contact_tasks' | 'contact_import_tasks' | 'warmup_schedule',
    showDayNumber?: boolean 
  }) => {
    const pendingCount = tasks.filter(t => t.status === 'pending').length;
    
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{tasks.length} total</Badge>
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500">{pendingCount} pending</Badge>
          </div>
          {pendingCount > 0 && (
            <Button 
              variant="destructive" 
              size="sm"
              onClick={() => clearPendingTasks(tableName)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Clear All Pending
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
                    No tasks found
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
                    <TableCell className="text-xs max-w-[200px] truncate">
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

  const pendingWarmupCount = warmupTasks.filter(t => t.status === 'pending').length;

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
              <p className="text-3xl font-bold text-orange-500">{pendingWarmupCount}</p>
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
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="account">
                Account
                {accountTasks.filter(t => t.status === 'pending').length > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    {accountTasks.filter(t => t.status === 'pending').length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="block">
                Block
                {blockTasks.filter(t => t.status === 'pending').length > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    {blockTasks.filter(t => t.status === 'pending').length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="import">
                Import
                {importTasks.filter(t => t.status === 'pending').length > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    {importTasks.filter(t => t.status === 'pending').length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="warmup">
                <Zap className="w-3 h-3 mr-1" />
                Warmup
                {pendingWarmupCount > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    {pendingWarmupCount}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="account" className="mt-4">
              <TaskTable tasks={accountTasks} tableName="account_check_tasks" />
            </TabsContent>
            
            <TabsContent value="block" className="mt-4">
              <TaskTable tasks={blockTasks} tableName="block_contact_tasks" />
            </TabsContent>
            
            <TabsContent value="import" className="mt-4">
              <TaskTable tasks={importTasks} tableName="contact_import_tasks" />
            </TabsContent>
            
            <TabsContent value="warmup" className="mt-4">
              <TaskTable tasks={warmupTasks} tableName="warmup_schedule" showDayNumber />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </DashboardLayout>
  );
};

export default DatabaseHealth;
