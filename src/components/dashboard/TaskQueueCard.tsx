import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { 
  Trash2, 
  CheckCircle, 
  Clock, 
  Activity,
  MessageSquare,
  Send,
  UserCheck,
  ListTodo,
  Upload
} from 'lucide-react';
import { format } from 'date-fns';

interface SystemHealth {
  pending_messages: number;
  pending_recipients: number;
  pending_account_tasks: number;
  pending_import_tasks: number;
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

export const TaskQueueCard: React.FC = () => {
  const queryClient = useQueryClient();

  const fetchTaskQueueData = async () => {
    const LIMIT = 50;
    const [
      healthRes,
      accountRes, importRes, recipientsRes, messagesRes,
      completedAccountRes, completedImportRes, completedRecipientsRes, completedMessagesRes
    ] = await Promise.all([
      supabase.from('system_health').select('*').maybeSingle(),
      supabase.from('account_check_tasks').select('id, account_id, status, task_type, created_at, result').eq('status', 'pending').order('created_at', { ascending: false }).limit(LIMIT),
      supabase.from('contact_import_tasks').select('id, account_id, status, created_at, result').eq('status', 'pending').order('created_at', { ascending: false }).limit(LIMIT),
      supabase.from('campaign_recipients').select('id, phone_number, name, status, campaign_id, failed_reason').eq('status', 'pending').limit(LIMIT),
      supabase.from('messages').select('id, content, status, created_at, conversation_id, failed_reason').in('status', ['pending', 'sending']).order('created_at', { ascending: false }).limit(LIMIT),
      supabase.from('account_check_tasks').select('id, account_id, status, task_type, created_at, result').in('status', ['completed', 'failed']).order('created_at', { ascending: false }).limit(30),
      supabase.from('contact_import_tasks').select('id, account_id, status, created_at, result').in('status', ['completed', 'failed']).order('created_at', { ascending: false }).limit(30),
      supabase.from('campaign_recipients').select('id, phone_number, name, status, campaign_id, failed_reason').in('status', ['sent', 'failed']).order('sent_at', { ascending: false }).limit(30),
      supabase.from('messages').select('id, content, status, created_at, conversation_id, failed_reason').in('status', ['sent', 'delivered', 'read', 'failed']).order('created_at', { ascending: false }).limit(30),
    ]);

    return {
      health: (healthRes.data as SystemHealth) || null,
      accountTasks: (accountRes.data || []) as Task[],
      importTasks: (importRes.data || []) as Task[],
      pendingRecipients: (recipientsRes.data || []) as Recipient[],
      pendingMessages: (messagesRes.data || []) as PendingMessage[],
      completedAccountTasks: (completedAccountRes.data || []) as Task[],
      completedImportTasks: (completedImportRes.data || []) as Task[],
      completedRecipients: (completedRecipientsRes.data || []) as Recipient[],
      completedMessages: (completedMessagesRes.data || []) as PendingMessage[],
    };
  };

  const { data } = useQuery({
    queryKey: ['task-queue'],
    queryFn: fetchTaskQueueData,
    staleTime: 300000,
    gcTime: 600000,
    refetchOnWindowFocus: false,
  });

  const health = data?.health ?? null;
  const accountTasks = data?.accountTasks ?? [];
  const importTasks = data?.importTasks ?? [];
  const pendingRecipients = data?.pendingRecipients ?? [];
  const pendingMessages = data?.pendingMessages ?? [];
  const completedAccountTasks = data?.completedAccountTasks ?? [];
  const completedImportTasks = data?.completedImportTasks ?? [];
  const completedRecipients = data?.completedRecipients ?? [];
  const completedMessages = data?.completedMessages ?? [];

  const refetchData = () => queryClient.invalidateQueries({ queryKey: ['task-queue'] });

  useEffect(() => {
    let refreshTimer: NodeJS.Timeout | null = null;
    const debouncedRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refetchData(), 3000);
    };

    const channel = supabase
      .channel('task-queue-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'account_check_tasks' }, debouncedRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contact_import_tasks' }, debouncedRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, debouncedRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_recipients' }, debouncedRefresh)
      .subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  const clearPendingTasks = async (table: 'account_check_tasks' | 'contact_import_tasks') => {
    try {
      const { error } = await supabase.from(table).delete().eq('status', 'pending');
      if (error) throw error;
      toast({ title: `Cleared pending tasks` });
      refetchData();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const deleteTask = async (table: 'account_check_tasks' | 'contact_import_tasks', id: string) => {
    try {
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) throw error;
      toast({ title: 'Task deleted' });
      refetchData();
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
    const styles: Record<string, string> = {
      pending: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30',
      sending: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
      completed: 'bg-green-500/10 text-green-500 border-green-500/30',
      sent: 'bg-green-500/10 text-green-500 border-green-500/30',
      delivered: 'bg-green-500/10 text-green-500 border-green-500/30',
      read: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
      failed: 'bg-red-500/10 text-red-500 border-red-500/30',
    };
    return (
      <Badge variant="outline" className={styles[status] || 'bg-muted'}>
        {status}
      </Badge>
    );
  };

  const TaskTable = ({ 
    tasks, 
    tableName, 
    isPending = true 
  }: { 
    tasks: Task[], 
    tableName: 'account_check_tasks' | 'contact_import_tasks',
    isPending?: boolean
  }) => (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Badge variant="outline" className={isPending ? "bg-yellow-500/10 text-yellow-500" : "bg-green-500/10 text-green-500"}>
          {tasks.length} {isPending ? 'pending' : 'completed/failed'}
        </Badge>
        {isPending && tasks.length > 0 && (
          <Button variant="destructive" size="sm" onClick={() => clearPendingTasks(tableName)}>
            <Trash2 className="w-4 h-4 mr-2" />
            Delete All
          </Button>
        )}
      </div>
      
      <div className="rounded-md border max-h-[300px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                  No {isPending ? 'pending' : 'completed'} tasks
                </TableCell>
              </TableRow>
            ) : (
              tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell className="font-mono text-xs">
                    {task.task_type || task.action || 'import'}
                  </TableCell>
                  <TableCell>{getStatusBadge(task.status)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {format(new Date(task.created_at), 'MMM d, HH:mm')}
                  </TableCell>
                  <TableCell className={`text-xs max-w-[150px] truncate ${task.status === 'failed' ? 'text-red-500' : ''}`}>
                    {task.result || '-'}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => deleteTask(tableName, task.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
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

  const TaskTabContent = ({ 
    pendingTasks, 
    completedTasks, 
    tableName 
  }: { 
    pendingTasks: Task[], 
    completedTasks: Task[], 
    tableName: 'account_check_tasks' | 'contact_import_tasks'
  }) => (
    <Tabs defaultValue="pending" className="w-full">
      <TabsList className="grid w-full grid-cols-2 max-w-[250px]">
        <TabsTrigger value="pending" className="text-xs">
          <Clock className="w-3 h-3 mr-1" />
          Pending ({pendingTasks.length})
        </TabsTrigger>
        <TabsTrigger value="completed" className="text-xs">
          <CheckCircle className="w-3 h-3 mr-1" />
          Done ({completedTasks.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pending" className="mt-3">
        <TaskTable tasks={pendingTasks} tableName={tableName} isPending={true} />
      </TabsContent>
      <TabsContent value="completed" className="mt-3">
        <TaskTable tasks={completedTasks} tableName={tableName} isPending={false} />
      </TabsContent>
    </Tabs>
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-gradient-to-r from-muted/50 to-transparent border-b py-4">
        <CardTitle className="flex items-center gap-3 text-base">
          <div className="p-2 rounded-xl bg-primary/10">
            <ListTodo className="w-4 h-4 text-primary" />
          </div>
          <span>Task Queue</span>
          <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30">
            <Activity className="w-3 h-3 mr-1" />
            Live
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <Tabs defaultValue="account" className="w-full">
          <TabsList className="grid w-full grid-cols-4 h-auto p-1 bg-muted/50">
            <TabsTrigger value="account" className="flex items-center gap-1 py-2 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <UserCheck className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Account</span>
              {(health?.pending_account_tasks || 0) > 0 && (
                <Badge variant="destructive" className="ml-1 text-[10px] px-1 py-0 h-4">
                  {health?.pending_account_tasks}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="import" className="flex items-center gap-1 py-2 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Upload className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Import</span>
              {(health?.pending_import_tasks || 0) > 0 && (
                <Badge variant="destructive" className="ml-1 text-[10px] px-1 py-0 h-4">
                  {health?.pending_import_tasks}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="recipients" className="flex items-center gap-1 py-2 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Send className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Recipients</span>
              {(health?.pending_recipients || 0) > 0 && (
                <Badge variant="destructive" className="ml-1 text-[10px] px-1 py-0 h-4">
                  {health?.pending_recipients}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="messages" className="flex items-center gap-1 py-2 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <MessageSquare className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Messages</span>
              {(health?.pending_messages || 0) > 0 && (
                <Badge variant="destructive" className="ml-1 text-[10px] px-1 py-0 h-4">
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
          
          <TabsContent value="import" className="mt-4">
            <TaskTabContent 
              pendingTasks={importTasks} 
              completedTasks={completedImportTasks} 
              tableName="contact_import_tasks" 
            />
          </TabsContent>

          <TabsContent value="recipients" className="mt-4">
            <Tabs defaultValue="pending" className="w-full">
              <TabsList className="grid w-full grid-cols-2 max-w-[250px]">
                <TabsTrigger value="pending" className="text-xs">
                  <Clock className="w-3 h-3 mr-1" />
                  Pending ({health?.pending_recipients || pendingRecipients.length})
                </TabsTrigger>
                <TabsTrigger value="completed" className="text-xs">
                  <CheckCircle className="w-3 h-3 mr-1" />
                  Done ({completedRecipients.length})
                </TabsTrigger>
              </TabsList>
              
              <TabsContent value="pending" className="mt-3">
                <div className="space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500">
                      {health?.pending_recipients || pendingRecipients.length} pending
                    </Badge>
                    {pendingRecipients.length > 0 && (
                      <Button variant="destructive" size="sm" onClick={clearPendingRecipients}>
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete All
                      </Button>
                    )}
                  </div>
                  
                  <div className="rounded-md border max-h-[300px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Phone</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Error</TableHead>
                          <TableHead className="w-[60px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingRecipients.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                              No pending recipients
                            </TableCell>
                          </TableRow>
                        ) : (
                          pendingRecipients.map((recipient) => (
                            <TableRow key={recipient.id}>
                              <TableCell className="font-mono text-xs">{recipient.phone_number}</TableCell>
                              <TableCell>{getStatusBadge(recipient.status || 'pending')}</TableCell>
                              <TableCell className="text-xs max-w-[150px] truncate text-red-500">
                                {recipient.failed_reason || '-'}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => deleteRecipient(recipient.id)}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
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
                  
                  <div className="rounded-md border max-h-[300px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Phone</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Result</TableHead>
                          <TableHead className="w-[60px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {completedRecipients.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                              No completed recipients
                            </TableCell>
                          </TableRow>
                        ) : (
                          completedRecipients.map((recipient) => (
                            <TableRow key={recipient.id}>
                              <TableCell className="font-mono text-xs">{recipient.phone_number}</TableCell>
                              <TableCell>{getStatusBadge(recipient.status || 'sent')}</TableCell>
                              <TableCell className={`text-xs max-w-[150px] truncate ${recipient.status === 'failed' ? 'text-red-500' : 'text-green-500'}`}>
                                {recipient.failed_reason || 'Success'}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => deleteRecipient(recipient.id)}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
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
              <TabsList className="grid w-full grid-cols-2 max-w-[250px]">
                <TabsTrigger value="pending" className="text-xs">
                  <Clock className="w-3 h-3 mr-1" />
                  Pending ({pendingMessages.length})
                </TabsTrigger>
                <TabsTrigger value="completed" className="text-xs">
                  <CheckCircle className="w-3 h-3 mr-1" />
                  Done ({completedMessages.length})
                </TabsTrigger>
              </TabsList>
              
              <TabsContent value="pending" className="mt-3">
                <div className="space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <Badge variant="secondary">{pendingMessages.length} pending/sending</Badge>
                    {pendingMessages.length > 0 && (
                      <Button variant="destructive" size="sm" onClick={clearPendingMessages}>
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete All
                      </Button>
                    )}
                  </div>
                  
                  <div className="rounded-md border max-h-[300px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Content</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Error</TableHead>
                          <TableHead className="w-[60px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingMessages.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                              No pending messages
                            </TableCell>
                          </TableRow>
                        ) : (
                          pendingMessages.map((msg) => (
                            <TableRow key={msg.id}>
                              <TableCell className="text-xs max-w-[200px] truncate">{msg.content}</TableCell>
                              <TableCell>{getStatusBadge(msg.status || 'pending')}</TableCell>
                              <TableCell className="text-xs max-w-[120px] truncate text-red-500">
                                {msg.failed_reason || '-'}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => deleteMessage(msg.id)}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
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
                  
                  <div className="rounded-md border max-h-[300px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Content</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Result</TableHead>
                          <TableHead className="w-[60px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {completedMessages.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                              No completed messages
                            </TableCell>
                          </TableRow>
                        ) : (
                          completedMessages.map((msg) => (
                            <TableRow key={msg.id}>
                              <TableCell className="text-xs max-w-[200px] truncate">{msg.content}</TableCell>
                              <TableCell>{getStatusBadge(msg.status || 'sent')}</TableCell>
                              <TableCell className={`text-xs max-w-[120px] truncate ${msg.status === 'failed' ? 'text-red-500' : 'text-green-500'}`}>
                                {msg.failed_reason || 'Success'}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => deleteMessage(msg.id)}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
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
  );
};
