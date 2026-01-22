import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  ClipboardList, 
  History, 
  FileText, 
  Search, 
  Trash2, 
  Loader2, 
  Check, 
  XCircle, 
  CheckCircle,
  Download,
  FileJson,
  FileSpreadsheet,
  RefreshCw,
  Server,
  MessageSquare,
  UserCheck,
  Shield,
  Zap,
  Database
} from 'lucide-react';
import { useTelegram, AccountTaskLog } from '@/context/TelegramContext';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface SystemLog {
  id: string;
  source: string;
  type: string;
  message: string;
  status: 'success' | 'error' | 'info' | 'warning';
  details?: string;
  accountPhone?: string;
  timestamp: Date;
}

const Logs: React.FC = () => {
  const { 
    accountTasksProgress, 
    setAccountTasksProgress,
    isAccountTaskRunning, 
    accountTaskHistory, 
    setAccountTaskHistory 
  } = useTelegram();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed'>('all');
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>('all');
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [isLoadingSystemLogs, setIsLoadingSystemLogs] = useState(false);
  const [systemLogFilter, setSystemLogFilter] = useState<string>('all');

  // Get unique task types from history
  const uniqueTaskTypes = Array.from(new Set(accountTaskHistory.map(log => log.taskType)));
  const uniqueSystemLogSources = Array.from(new Set(systemLogs.map(log => log.source)));

  // Fetch system logs from all relevant tables
  const fetchSystemLogs = useCallback(async () => {
    setIsLoadingSystemLogs(true);
    try {
      const logs: SystemLog[] = [];

      // First, fetch account phone numbers for lookup
      const { data: accounts } = await supabase
        .from('telegram_accounts')
        .select('id, phone_number');
      
      const accountPhoneMap = new Map<string, string>();
      accounts?.forEach(a => accountPhoneMap.set(a.id, a.phone_number));

      // Fetch from multiple tables in parallel
      const [
        vpsLogsResult,
        accountCheckResult,
        warmupMessagesResult,
        blockTasksResult,
        contactImportResult,
        maturationResult,
        warmupErrorsResult,
        proxyErrorsResult
      ] = await Promise.all([
        // VPS Logs
        supabase
          .from('vps_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
        
        // Account Check Tasks - fetch completed/failed
        supabase
          .from('account_check_tasks')
          .select('id, account_id, task_type, status, result, created_at, completed_at')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(500),
        
        // Warmup Messages (recent completed/failed)
        supabase
          .from('warmup_messages')
          .select('id, sender_account_id, status, message_content, message_type, error_message, sent_at, created_at')
          .in('status', ['sent', 'failed'])
          .order('created_at', { ascending: false })
          .limit(200),
        
        // Block Contact Tasks
        supabase
          .from('block_contact_tasks')
          .select('id, account_id, status, action, target_phone, result, created_at, completed_at')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100),
        
        // Contact Import Tasks
        supabase
          .from('contact_import_tasks')
          .select('id, account_id, status, result, valid_numbers, invalid_numbers, created_at, completed_at')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100),
        
        // Maturation Tasks
        supabase
          .from('maturation_tasks')
          .select('id, account_id, task_type, status, description, created_at, completed_at')
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(100),
        
        // Warmup Errors
        supabase
          .from('warmup_errors')
          .select('id, account_id, error_type, error_message, created_at')
          .order('created_at', { ascending: false })
          .limit(100),
        
        // Proxy Errors
        supabase
          .from('proxy_errors')
          .select('id, proxy_id, error_type, error_message, created_at')
          .order('created_at', { ascending: false })
          .limit(100),
      ]);

      // Process VPS Logs
      if (vpsLogsResult.data) {
        vpsLogsResult.data.forEach(log => {
          logs.push({
            id: log.id,
            source: 'VPS Runner',
            type: log.log_level || 'info',
            message: log.message,
            status: log.log_level === 'error' ? 'error' : log.log_level === 'warning' ? 'warning' : 'info',
            details: `Runner: ${log.runner_name}`,
            timestamp: new Date(log.created_at),
          });
        });
      }

      // Process Account Check Tasks
      if (accountCheckResult.data) {
        accountCheckResult.data.forEach(task => {
          logs.push({
            id: task.id,
            source: 'Account Check',
            type: task.task_type,
            message: `${task.task_type.replace(/_/g, ' ')} - ${task.status}`,
            status: task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : 'info',
            details: task.result || undefined,
            accountPhone: accountPhoneMap.get(task.account_id) || task.account_id,
            timestamp: new Date(task.created_at || Date.now()),
          });
        });
      }

      // Process Warmup Messages
      if (warmupMessagesResult.data) {
        warmupMessagesResult.data.forEach(msg => {
          logs.push({
            id: msg.id,
            source: 'Warmup Chat',
            type: msg.message_type || 'message',
            message: `Warmup message ${msg.status}`,
            status: msg.status === 'sent' ? 'success' : 'error',
            details: msg.error_message || msg.message_content?.substring(0, 50),
            accountPhone: accountPhoneMap.get(msg.sender_account_id) || msg.sender_account_id,
            timestamp: new Date(msg.sent_at || msg.created_at || Date.now()),
          });
        });
      }

      // Process Block Tasks
      if (blockTasksResult.data) {
        blockTasksResult.data.forEach(task => {
          logs.push({
            id: task.id,
            source: 'Block Contact',
            type: task.action,
            message: `${task.action} contact: ${task.target_phone}`,
            status: task.status === 'completed' ? 'success' : 'error',
            details: task.result || undefined,
            accountPhone: accountPhoneMap.get(task.account_id) || task.account_id,
            timestamp: new Date(task.completed_at || task.created_at),
          });
        });
      }

      // Process Contact Import Tasks
      if (contactImportResult.data) {
        contactImportResult.data.forEach(task => {
          const validCount = task.valid_numbers?.length || 0;
          const invalidCount = task.invalid_numbers?.length || 0;
          logs.push({
            id: task.id,
            source: 'Contact Import',
            type: 'import',
            message: `Imported ${validCount} valid, ${invalidCount} invalid numbers`,
            status: task.status === 'completed' ? 'success' : 'error',
            details: task.result || undefined,
            accountPhone: accountPhoneMap.get(task.account_id) || task.account_id,
            timestamp: new Date(task.completed_at || task.created_at),
          });
        });
      }

      // Process Maturation Tasks
      if (maturationResult.data) {
        maturationResult.data.forEach(task => {
          logs.push({
            id: task.id,
            source: 'Maturation',
            type: task.task_type,
            message: task.description || `${task.task_type.replace(/_/g, ' ')}`,
            status: task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : 'info',
            accountPhone: accountPhoneMap.get(task.account_id) || task.account_id,
            timestamp: new Date(task.completed_at || task.created_at || Date.now()),
          });
        });
      }

      // Process Warmup Errors
      if (warmupErrorsResult.data) {
        warmupErrorsResult.data.forEach(err => {
          logs.push({
            id: err.id,
            source: 'Warmup Error',
            type: err.error_type || 'error',
            message: err.error_message,
            status: 'error',
            accountPhone: err.account_id ? (accountPhoneMap.get(err.account_id) || err.account_id) : undefined,
            timestamp: new Date(err.created_at || Date.now()),
          });
        });
      }

      // Process Proxy Errors
      if (proxyErrorsResult.data) {
        proxyErrorsResult.data.forEach(err => {
          logs.push({
            id: err.id,
            source: 'Proxy Error',
            type: err.error_type || 'error',
            message: err.error_message || 'Proxy connection failed',
            status: 'error',
            details: err.proxy_id,
            timestamp: new Date(err.created_at),
          });
        });
      }

      // Sort all logs by timestamp descending
      logs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setSystemLogs(logs);
    } catch (error) {
      console.error('Error fetching system logs:', error);
      toast.error('Failed to fetch system logs');
    } finally {
      setIsLoadingSystemLogs(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchSystemLogs();
  }, [fetchSystemLogs]);

  // Filter logs
  const filterLogs = (logs: AccountTaskLog[]) => {
    return logs.filter(log => {
      const matchesSearch = !searchQuery || 
        log.accountPhone.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.taskType.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.result && log.result.toLowerCase().includes(searchQuery.toLowerCase()));
      
      const matchesStatus = statusFilter === 'all' || log.status === statusFilter;
      const matchesType = taskTypeFilter === 'all' || log.taskType === taskTypeFilter;
      
      return matchesSearch && matchesStatus && matchesType;
    });
  };

  const filterSystemLogs = (logs: SystemLog[]) => {
    return logs.filter(log => {
      const matchesSearch = !searchQuery || 
        log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.source.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.accountPhone && log.accountPhone.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (log.details && log.details.toLowerCase().includes(searchQuery.toLowerCase()));
      
      const matchesSource = systemLogFilter === 'all' || log.source === systemLogFilter;
      
      return matchesSearch && matchesSource;
    });
  };

  const filteredCurrentLogs = filterLogs(accountTasksProgress.logs);
  const filteredHistory = filterLogs(accountTaskHistory);
  const filteredSystemLogs = filterSystemLogs(systemLogs);

  // Stats from history
  const historyStats = {
    total: accountTaskHistory.length,
    completed: accountTaskHistory.filter(l => l.status === 'completed').length,
    failed: accountTaskHistory.filter(l => l.status === 'failed').length,
  };

  const systemLogStats = {
    total: systemLogs.length,
    success: systemLogs.filter(l => l.status === 'success').length,
    errors: systemLogs.filter(l => l.status === 'error').length,
  };

  const clearCurrentLogs = () => {
    if (!isAccountTaskRunning) {
      setAccountTasksProgress(prev => ({ ...prev, logs: [], total: 0, completed: 0, failed: 0, taskType: '' }));
    }
  };

  // Export functions
  const exportToJSON = (logs: AccountTaskLog[], filename: string) => {
    const exportData = logs.map(log => ({
      accountPhone: log.accountPhone,
      taskType: log.taskType,
      status: log.status,
      result: log.result || null,
      timestamp: log.timestamp.toISOString(),
    }));
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Exported to JSON');
  };

  const exportToCSV = (logs: AccountTaskLog[], filename: string) => {
    const headers = ['Account Phone', 'Task Type', 'Status', 'Result', 'Timestamp'];
    const rows = logs.map(log => [
      log.accountPhone,
      log.taskType,
      log.status,
      log.result ? `"${log.result.replace(/"/g, '""')}"` : '',
      format(log.timestamp, 'yyyy-MM-dd HH:mm:ss'),
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Exported to CSV');
  };

  const exportSystemLogsToJSON = (logs: SystemLog[], filename: string) => {
    const exportData = logs.map(log => ({
      source: log.source,
      type: log.type,
      message: log.message,
      status: log.status,
      details: log.details || null,
      accountPhone: log.accountPhone || null,
      timestamp: log.timestamp.toISOString(),
    }));
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Exported to JSON');
  };

  const exportSystemLogsToCSV = (logs: SystemLog[], filename: string) => {
    const headers = ['Source', 'Type', 'Message', 'Status', 'Details', 'Account Phone', 'Timestamp'];
    const rows = logs.map(log => [
      log.source,
      log.type,
      `"${log.message.replace(/"/g, '""')}"`,
      log.status,
      log.details ? `"${log.details.replace(/"/g, '""')}"` : '',
      log.accountPhone || '',
      format(log.timestamp, 'yyyy-MM-dd HH:mm:ss'),
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Exported to CSV');
  };

  const clearHistory = () => {
    setAccountTaskHistory([]);
  };

  const getSourceIcon = (source: string) => {
    switch (source) {
      case 'VPS Runner': return <Server className="w-3.5 h-3.5" />;
      case 'Account Check': return <UserCheck className="w-3.5 h-3.5" />;
      case 'Warmup Chat': return <MessageSquare className="w-3.5 h-3.5" />;
      case 'Block Contact': return <Shield className="w-3.5 h-3.5" />;
      case 'Contact Import': return <Database className="w-3.5 h-3.5" />;
      case 'Maturation': return <Zap className="w-3.5 h-3.5" />;
      default: return <FileText className="w-3.5 h-3.5" />;
    }
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Task Logs"
        description="Monitor account task progress, system logs, and history"
        icon={ClipboardList}
      />

      <div className="max-w-6xl space-y-6">
        {/* Current Task Progress - Always visible when running */}
        {isAccountTaskRunning && (
          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-medium flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                  Running: {accountTasksProgress.taskType || 'Account Task'}
                </CardTitle>
                <Badge variant="secondary">
                  {accountTasksProgress.completed + accountTasksProgress.failed} / {accountTasksProgress.total}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <Progress 
                value={accountTasksProgress.total > 0 ? ((accountTasksProgress.completed + accountTasksProgress.failed) / accountTasksProgress.total) * 100 : 0} 
                className="h-2 mb-4" 
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-status-active/10 border border-status-active/20">
                  <CheckCircle className="w-5 h-5 text-status-active" />
                  <div>
                    <div className="text-xl font-bold text-status-active">{accountTasksProgress.completed}</div>
                    <div className="text-xs text-muted-foreground">Completed</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-status-banned/10 border border-status-banned/20">
                  <XCircle className="w-5 h-5 text-status-banned" />
                  <div>
                    <div className="text-xl font-bold text-status-banned">{accountTasksProgress.failed}</div>
                    <div className="text-xs text-muted-foreground">Failed</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="current" className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <TabsList className="h-10">
              <TabsTrigger value="current" className="gap-2">
                <FileText className="w-4 h-4" />
                Current Session
                {accountTasksProgress.logs.length > 0 && (
                  <Badge variant="secondary" className="ml-1">{accountTasksProgress.logs.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-2">
                <History className="w-4 h-4" />
                History
                {accountTaskHistory.length > 0 && (
                  <Badge variant="secondary" className="ml-1">{accountTaskHistory.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="system" className="gap-2">
                <Server className="w-4 h-4" />
                System Logs
                {systemLogs.length > 0 && (
                  <Badge variant="secondary" className="ml-1">{systemLogs.length}</Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {/* Filters */}
            <div className="flex gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-9 w-48"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
                <SelectTrigger className="w-32 h-9">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              {uniqueTaskTypes.length > 1 && (
                <Select value={taskTypeFilter} onValueChange={setTaskTypeFilter}>
                  <SelectTrigger className="w-40 h-9">
                    <SelectValue placeholder="Task Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {uniqueTaskTypes.map(type => (
                      <SelectItem key={type} value={type}>
                        {type.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {/* Current Session Tab */}
          <TabsContent value="current" className="mt-0">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Current Session Logs</CardTitle>
                    <CardDescription>
                      Live updates from running account tasks
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="outline" 
                          size="sm"
                          disabled={accountTasksProgress.logs.length === 0}
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Export
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => exportToJSON(accountTasksProgress.logs, 'session-logs')}>
                          <FileJson className="w-4 h-4 mr-2" />
                          Export as JSON
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => exportToCSV(accountTasksProgress.logs, 'session-logs')}>
                          <FileSpreadsheet className="w-4 h-4 mr-2" />
                          Export as CSV
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={clearCurrentLogs}
                      disabled={isAccountTaskRunning || accountTasksProgress.logs.length === 0}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Clear
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {filteredCurrentLogs.length > 0 ? (
                  <ScrollArea className="h-[400px] pr-4">
                    <div className="space-y-2">
                      {filteredCurrentLogs.map((log, index) => (
                        <LogEntry key={`${log.id}-${index}`} log={log} />
                      ))}
                    </div>
                  </ScrollArea>
                ) : isAccountTaskRunning ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Loader2 className="w-8 h-8 animate-spin mb-3" />
                    <p className="text-sm">Waiting for Python runner to process tasks...</p>
                    <p className="text-xs mt-1">Logs will appear here as tasks complete</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <FileText className="w-8 h-8 mb-3 opacity-50" />
                    <p className="text-sm">No logs in current session</p>
                    <p className="text-xs mt-1">Run an account task to see results here</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history" className="mt-0">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Task History</CardTitle>
                    <CardDescription>
                      {historyStats.total} total • {historyStats.completed} completed • {historyStats.failed} failed
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="outline" 
                          size="sm"
                          disabled={accountTaskHistory.length === 0}
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Export
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => exportToJSON(accountTaskHistory, 'task-history')}>
                          <FileJson className="w-4 h-4 mr-2" />
                          Export as JSON
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => exportToCSV(accountTaskHistory, 'task-history')}>
                          <FileSpreadsheet className="w-4 h-4 mr-2" />
                          Export as CSV
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={clearHistory}
                      disabled={accountTaskHistory.length === 0}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Clear
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {filteredHistory.length > 0 ? (
                  <ScrollArea className="h-[500px] pr-4">
                    <div className="space-y-2">
                      {filteredHistory.map((log, index) => (
                        <LogEntry key={`${log.id}-history-${index}`} log={log} showTimestamp />
                      ))}
                    </div>
                  </ScrollArea>
                ) : accountTaskHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <History className="w-8 h-8 mb-3 opacity-50" />
                    <p className="text-sm">No task history yet</p>
                    <p className="text-xs mt-1">Completed tasks will be recorded here</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Search className="w-8 h-8 mb-3 opacity-50" />
                    <p className="text-sm">No logs match your filters</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* System Logs Tab */}
          <TabsContent value="system" className="mt-0">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">System Logs</CardTitle>
                    <CardDescription>
                      {systemLogStats.total} total • {systemLogStats.success} success • {systemLogStats.errors} errors
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Select value={systemLogFilter} onValueChange={setSystemLogFilter}>
                      <SelectTrigger className="w-40 h-9">
                        <SelectValue placeholder="All Sources" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Sources</SelectItem>
                        {uniqueSystemLogSources.map(source => (
                          <SelectItem key={source} value={source}>{source}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={fetchSystemLogs}
                      disabled={isLoadingSystemLogs}
                    >
                      <RefreshCw className={cn("w-4 h-4 mr-2", isLoadingSystemLogs && "animate-spin")} />
                      Refresh
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="outline" 
                          size="sm"
                          disabled={systemLogs.length === 0}
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Export
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => exportSystemLogsToJSON(filteredSystemLogs, 'system-logs')}>
                          <FileJson className="w-4 h-4 mr-2" />
                          Export as JSON
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => exportSystemLogsToCSV(filteredSystemLogs, 'system-logs')}>
                          <FileSpreadsheet className="w-4 h-4 mr-2" />
                          Export as CSV
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingSystemLogs ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Loader2 className="w-8 h-8 animate-spin mb-3" />
                    <p className="text-sm">Loading system logs...</p>
                  </div>
                ) : filteredSystemLogs.length > 0 ? (
                  <ScrollArea className="h-[500px] pr-4">
                    <div className="space-y-2">
                      {filteredSystemLogs.map((log, index) => (
                        <SystemLogEntry key={`${log.id}-${index}`} log={log} getSourceIcon={getSourceIcon} />
                      ))}
                    </div>
                  </ScrollArea>
                ) : systemLogs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Server className="w-8 h-8 mb-3 opacity-50" />
                    <p className="text-sm">No system logs found</p>
                    <p className="text-xs mt-1">Logs from all system functions will appear here</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Search className="w-8 h-8 mb-3 opacity-50" />
                    <p className="text-sm">No logs match your filters</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
};

interface LogEntryProps {
  log: AccountTaskLog;
  showTimestamp?: boolean;
}

const LogEntry: React.FC<LogEntryProps> = ({ log, showTimestamp = false }) => {
  const isSuccess = log.status === 'completed';
  
  return (
    <div className={cn(
      "flex items-start gap-3 p-3 rounded-lg border transition-colors",
      isSuccess 
        ? "bg-status-active/5 border-status-active/20 hover:bg-status-active/10" 
        : "bg-status-banned/5 border-status-banned/20 hover:bg-status-banned/10"
    )}>
      <div className={cn(
        "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center",
        isSuccess ? "bg-status-active/20 text-status-active" : "bg-status-banned/20 text-status-banned"
      )}>
        {isSuccess ? <Check className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{log.accountPhone}</span>
          <Badge variant="outline" className="text-xs">
            {log.taskType.replace(/_/g, ' ')}
          </Badge>
          {showTimestamp && (
            <span className="text-xs text-muted-foreground">
              {format(log.timestamp, 'MMM d, HH:mm:ss')}
            </span>
          )}
        </div>
        
        {log.result && log.status === 'failed' && (
          <p className="text-xs text-destructive/80 mt-1 break-all">
            {log.result}
          </p>
        )}
      </div>
      
      <Badge variant={isSuccess ? "default" : "destructive"} className="flex-shrink-0">
        {isSuccess ? 'Success' : 'Failed'}
      </Badge>
    </div>
  );
};

interface SystemLogEntryProps {
  log: SystemLog;
  getSourceIcon: (source: string) => React.ReactNode;
}

const SystemLogEntry: React.FC<SystemLogEntryProps> = ({ log, getSourceIcon }) => {
  const statusColors = {
    success: 'bg-status-active/5 border-status-active/20 hover:bg-status-active/10',
    error: 'bg-status-banned/5 border-status-banned/20 hover:bg-status-banned/10',
    warning: 'bg-yellow-500/5 border-yellow-500/20 hover:bg-yellow-500/10',
    info: 'bg-blue-500/5 border-blue-500/20 hover:bg-blue-500/10',
  };

  const iconColors = {
    success: 'bg-status-active/20 text-status-active',
    error: 'bg-status-banned/20 text-status-banned',
    warning: 'bg-yellow-500/20 text-yellow-600',
    info: 'bg-blue-500/20 text-blue-500',
  };

  const badgeVariants = {
    success: 'default' as const,
    error: 'destructive' as const,
    warning: 'secondary' as const,
    info: 'outline' as const,
  };

  return (
    <div className={cn(
      "flex items-start gap-3 p-3 rounded-lg border transition-colors",
      statusColors[log.status]
    )}>
      <div className={cn(
        "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center",
        iconColors[log.status]
      )}>
        {getSourceIcon(log.source)}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-xs font-medium">
            {log.source}
          </Badge>
          {log.accountPhone && (
            <span className="font-medium text-sm">{log.accountPhone}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {format(log.timestamp, 'MMM d, HH:mm:ss')}
          </span>
        </div>
        
        <p className="text-sm mt-1">{log.message}</p>
        
        {log.details && (
          <p className="text-xs text-muted-foreground mt-1 break-all">
            {log.details}
          </p>
        )}
      </div>
      
      <Badge variant={badgeVariants[log.status]} className="flex-shrink-0 capitalize">
        {log.status}
      </Badge>
    </div>
  );
};

export default Logs;