import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Plus, Trash2, Globe, Loader2, Search, RefreshCw, 
  CheckCircle, XCircle, Wifi, WifiOff, User, Clock, Server, AlertTriangle
} from 'lucide-react';
import { Proxy } from '@/types/telegram';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

const proxyTypeOptions = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks4', label: 'SOCKS4' },
  { value: 'socks5', label: 'SOCKS5' },
];

const statusOptions = [
  { value: 'active', label: 'Active', color: 'bg-green-500/20 text-green-600 border-green-500/30' },
  { value: 'inactive', label: 'Inactive', color: 'bg-muted text-muted-foreground border-border' },
  { value: 'error', label: 'Error', color: 'bg-destructive/20 text-destructive border-destructive/30' },
];

interface TestResult {
  status: 'testing' | 'success' | 'failed';
  responseTime?: number;
  error?: string;
}

interface ProxyToAdd {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type: string;
  testResult?: TestResult;
}

const Proxies: React.FC = () => {
  const { proxies, accounts, refreshData, isLoading } = useTelegram();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  
  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkTesting, setIsBulkTesting] = useState(false);
  const [testResults, setTestResults] = useState<Map<string, TestResult>>(new Map());
  
  // Add form state
  const [addTab, setAddTab] = useState<'single' | 'bulk'>('single');
  const [singleProxy, setSingleProxy] = useState({
    host: '',
    port: '',
    username: '',
    password: '',
    type: 'http' as const,
  });
  const [bulkProxies, setBulkProxies] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [singleTestResult, setSingleTestResult] = useState<TestResult | null>(null);
  const [parsedProxies, setParsedProxies] = useState<ProxyToAdd[]>([]);
  const [isTestingBulk, setIsTestingBulk] = useState(false);

  // Test a single proxy before adding
  const testSingleProxy = async () => {
    if (!singleProxy.host || !singleProxy.port) {
      toast.error('Host and port are required');
      return;
    }

    setIsTesting(true);
    setSingleTestResult({ status: 'testing' });

    try {
      // Create a temporary proxy entry to test
      const { data: tempProxy, error: insertError } = await supabase
        .from('proxies')
        .insert({
          host: singleProxy.host.trim(),
          port: parseInt(singleProxy.port),
          username: singleProxy.username.trim() || null,
          password: singleProxy.password || null,
          proxy_type: singleProxy.type,
          status: 'inactive',
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Test the proxy
      const { data, error } = await supabase.functions.invoke('test-proxies', {
        body: { proxy_ids: [tempProxy.id] }
      });

      if (error) throw error;

      const result = data.results?.[0];
      if (result?.success) {
        setSingleTestResult({ status: 'success', responseTime: result.responseTime });
        toast.success(`Proxy is working! Response time: ${result.responseTime}ms`);
        
        // Update proxy status to active
        await supabase
          .from('proxies')
          .update({ status: 'active' })
          .eq('id', tempProxy.id);
      } else {
        setSingleTestResult({ status: 'failed', error: result?.error || 'Connection failed' });
        toast.error(`Proxy test failed: ${result?.error || 'Connection failed'}`);
        
        // Delete the failed proxy
        await supabase
          .from('proxies')
          .delete()
          .eq('id', tempProxy.id);
      }

      refreshData();
    } catch (error) {
      console.error('Error testing proxy:', error);
      setSingleTestResult({ status: 'failed', error: 'Test failed' });
      toast.error('Failed to test proxy');
    } finally {
      setIsTesting(false);
    }
  };

  // Parse and preview bulk proxies
  const parseBulkProxies = () => {
    const lines = bulkProxies.split('\n').filter(l => l.trim());
    const parsed: ProxyToAdd[] = lines.map(line => {
      const parts = line.trim().split(':');
      return {
        host: parts[0] || '',
        port: parseInt(parts[1]) || 8080,
        username: parts[2] || undefined,
        password: parts[3] || undefined,
        type: 'http',
      };
    }).filter(p => p.host);
    
    setParsedProxies(parsed);
    return parsed;
  };

  // Test all parsed proxies
  const testBulkProxies = async () => {
    const proxiesToTest = parseBulkProxies();
    if (proxiesToTest.length === 0) {
      toast.error('No valid proxies to test');
      return;
    }

    setIsTestingBulk(true);

    try {
      // Insert all proxies as inactive first
      const { data: insertedProxies, error: insertError } = await supabase
        .from('proxies')
        .insert(proxiesToTest.map(p => ({
          host: p.host,
          port: p.port,
          username: p.username || null,
          password: p.password || null,
          proxy_type: p.type as 'http' | 'https' | 'socks4' | 'socks5',
          status: 'inactive' as const,
        })))
        .select();

      if (insertError) throw insertError;

      // Test all inserted proxies
      const { data, error } = await supabase.functions.invoke('test-proxies', {
        body: { proxy_ids: insertedProxies?.map(p => p.id) || [] }
      });

      if (error) throw error;

      // Update parsed proxies with test results
      const updatedParsed = proxiesToTest.map((p, i) => {
        const result = data.results?.find((r: any) => r.id === insertedProxies?.[i]?.id);
        return {
          ...p,
          testResult: result ? {
            status: result.success ? 'success' : 'failed',
            responseTime: result.responseTime,
            error: result.error,
          } as TestResult : undefined,
        };
      });

      setParsedProxies(updatedParsed);

      const working = data.results?.filter((r: any) => r.success).length || 0;
      const failed = data.results?.filter((r: any) => !r.success).length || 0;

      // Delete failed proxies
      const failedIds = data.results?.filter((r: any) => !r.success).map((r: any) => r.id) || [];
      if (failedIds.length > 0) {
        await supabase
          .from('proxies')
          .delete()
          .in('id', failedIds);
      }

      toast.success(`Tested: ${working} working, ${failed} failed`);
      refreshData();
      
      if (working > 0) {
        setBulkProxies('');
        setParsedProxies([]);
        setIsAddOpen(false);
      }
    } catch (error) {
      console.error('Error testing bulk proxies:', error);
      toast.error('Failed to test proxies');
    } finally {
      setIsTestingBulk(false);
    }
  };

  const handleAddSingle = async () => {
    if (!singleProxy.host || !singleProxy.port) {
      toast.error('Host and port are required');
      return;
    }

    // If no test was run, test first
    if (!singleTestResult || singleTestResult.status !== 'success') {
      await testSingleProxy();
      return;
    }

    // Proxy was already added during test
    setSingleProxy({ host: '', port: '', username: '', password: '', type: 'http' });
    setSingleTestResult(null);
    setIsAddOpen(false);
  };

  const handleAddBulk = async () => {
    // Test and add proxies
    await testBulkProxies();
  };

  const handleDelete = async (id: string) => {
    try {
      // First remove proxy from any accounts using it
      await supabase
        .from('telegram_accounts')
        .update({ proxy_id: null })
        .eq('proxy_id', id);

      const { error } = await supabase
        .from('proxies')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Proxy deleted');
      refreshData();
    } catch (error) {
      console.error('Error deleting proxy:', error);
      toast.error('Failed to delete proxy');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    
    setIsBulkDeleting(true);
    try {
      // First remove proxies from accounts
      await supabase
        .from('telegram_accounts')
        .update({ proxy_id: null })
        .in('proxy_id', Array.from(selectedIds));

      const { error } = await supabase
        .from('proxies')
        .delete()
        .in('id', Array.from(selectedIds));

      if (error) throw error;
      
      toast.success(`Deleted ${selectedIds.size} proxies`);
      setSelectedIds(new Set());
      refreshData();
    } catch (error) {
      console.error('Error bulk deleting:', error);
      toast.error('Failed to delete proxies');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const handleBulkTest = async () => {
    if (selectedIds.size === 0) return;
    
    setIsBulkTesting(true);
    const newResults = new Map<string, TestResult>();
    
    // Set all to testing
    selectedIds.forEach(id => newResults.set(id, { status: 'testing' }));
    setTestResults(new Map(newResults));

    try {
      const { data, error } = await supabase.functions.invoke('test-proxies', {
        body: { proxy_ids: Array.from(selectedIds) }
      });

      if (error) throw error;

      // Update results
      for (const result of data.results || []) {
        newResults.set(result.id, {
          status: result.success ? 'success' : 'failed',
          responseTime: result.responseTime,
          error: result.error,
        });
      }

      setTestResults(new Map(newResults));
      toast.success(`Tested: ${data.summary?.working || 0} working, ${data.summary?.failed || 0} failed`);
      refreshData();
    } catch (error) {
      console.error('Error testing proxies:', error);
      toast.error('Failed to test proxies');
      selectedIds.forEach(id => newResults.set(id, { status: 'failed', error: 'Test failed' }));
      setTestResults(new Map(newResults));
    } finally {
      setIsBulkTesting(false);
    }
  };

  const handleStatusChange = async (id: string, status: 'active' | 'inactive' | 'error') => {
    try {
      const { error } = await supabase
        .from('proxies')
        .update({ status })
        .eq('id', id);

      if (error) throw error;
      refreshData();
    } catch (error) {
      console.error('Error updating status:', error);
      toast.error('Failed to update status');
    }
  };

  const getAccountsUsingProxy = (proxyId: string) => {
    return accounts.filter(a => a.proxyId === proxyId);
  };

  const filteredProxies = proxies.filter(p => {
    const matchesSearch = 
      p.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.country?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredProxies.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProxies.map(p => p.id)));
    }
  };

  const isAllSelected = filteredProxies.length > 0 && selectedIds.size === filteredProxies.length;

  const getStatusBadge = (status: string) => {
    const option = statusOptions.find(o => o.value === status);
    return (
      <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border", option?.color || 'bg-muted')}>
        {option?.label || status}
      </span>
    );
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Proxy Management"
        description="Manage your proxy servers for Telegram accounts"
        action={
          <Dialog open={isAddOpen} onOpenChange={(open) => {
            setIsAddOpen(open);
            if (!open) {
              setSingleTestResult(null);
              setParsedProxies([]);
            }
          }}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                Add Proxies
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Proxies</DialogTitle>
                <DialogDescription>
                  Proxies will be tested before being added
                </DialogDescription>
              </DialogHeader>
              <Tabs value={addTab} onValueChange={(v) => setAddTab(v as 'single' | 'bulk')} className="mt-4">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="single">Single Proxy</TabsTrigger>
                  <TabsTrigger value="bulk">Bulk Import</TabsTrigger>
                </TabsList>
                
                <TabsContent value="single" className="space-y-4 mt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Host</Label>
                      <Input
                        placeholder="proxy.example.com"
                        value={singleProxy.host}
                        onChange={(e) => {
                          setSingleProxy({ ...singleProxy, host: e.target.value });
                          setSingleTestResult(null);
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Port</Label>
                      <Input
                        type="number"
                        placeholder="8080"
                        value={singleProxy.port}
                        onChange={(e) => {
                          setSingleProxy({ ...singleProxy, port: e.target.value });
                          setSingleTestResult(null);
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Username (optional)</Label>
                      <Input
                        placeholder="username"
                        value={singleProxy.username}
                        onChange={(e) => setSingleProxy({ ...singleProxy, username: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Password (optional)</Label>
                      <Input
                        type="password"
                        placeholder="password"
                        value={singleProxy.password}
                        onChange={(e) => setSingleProxy({ ...singleProxy, password: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <Select
                      value={singleProxy.type}
                      onValueChange={(v) => setSingleProxy({ ...singleProxy, type: v as any })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {proxyTypeOptions.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  {/* Test Result */}
                  {singleTestResult && (
                    <div className={cn(
                      "p-3 rounded-lg border flex items-center gap-2",
                      singleTestResult.status === 'testing' && "bg-primary/10 border-primary/30",
                      singleTestResult.status === 'success' && "bg-green-500/10 border-green-500/30",
                      singleTestResult.status === 'failed' && "bg-destructive/10 border-destructive/30"
                    )}>
                      {singleTestResult.status === 'testing' && (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          <span className="text-sm">Testing proxy connection...</span>
                        </>
                      )}
                      {singleTestResult.status === 'success' && (
                        <>
                          <CheckCircle className="w-4 h-4 text-green-600" />
                          <span className="text-sm text-green-600">
                            Connected! Response time: {singleTestResult.responseTime}ms
                          </span>
                        </>
                      )}
                      {singleTestResult.status === 'failed' && (
                        <>
                          <XCircle className="w-4 h-4 text-destructive" />
                          <span className="text-sm text-destructive">
                            Failed: {singleTestResult.error}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                  
                  <Button onClick={handleAddSingle} disabled={isTesting} className="w-full">
                    {isTesting ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Testing...
                      </>
                    ) : singleTestResult?.status === 'success' ? (
                      <>
                        <CheckCircle className="w-4 h-4 mr-2" />
                        Proxy Added
                      </>
                    ) : (
                      <>
                        <Wifi className="w-4 h-4 mr-2" />
                        Test & Add Proxy
                      </>
                    )}
                  </Button>
                </TabsContent>
                
                <TabsContent value="bulk" className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label>Proxy List</Label>
                    <Textarea
                      placeholder="gate-eu.example.com:1000:username:password&#10;proxy.example.com:8080&#10;host:port:user:pass"
                      value={bulkProxies}
                      onChange={(e) => {
                        setBulkProxies(e.target.value);
                        setParsedProxies([]);
                      }}
                      rows={6}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      One proxy per line. Format: <code className="px-1 py-0.5 bg-muted rounded">host:port:username:password</code> or <code className="px-1 py-0.5 bg-muted rounded">host:port</code>
                    </p>
                  </div>
                  
                  {parsedProxies.length > 0 && (
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {parsedProxies.map((p, i) => (
                        <div key={i} className={cn(
                          "flex items-center gap-2 p-2 rounded text-sm",
                          p.testResult?.status === 'success' && "bg-green-500/10",
                          p.testResult?.status === 'failed' && "bg-destructive/10",
                          !p.testResult && "bg-muted"
                        )}>
                          {p.testResult?.status === 'success' && <CheckCircle className="w-4 h-4 text-green-600" />}
                          {p.testResult?.status === 'failed' && <XCircle className="w-4 h-4 text-destructive" />}
                          {!p.testResult && <Globe className="w-4 h-4 text-muted-foreground" />}
                          <span>{p.host}:{p.port}</span>
                          {p.testResult?.responseTime && (
                            <span className="text-xs text-muted-foreground">{p.testResult.responseTime}ms</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  
                  <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5" />
                    <p className="text-xs text-muted-foreground">
                      All proxies will be tested before being added. Only working proxies will be saved.
                    </p>
                  </div>
                  
                  <Button onClick={handleAddBulk} disabled={isTestingBulk} className="w-full">
                    {isTestingBulk ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Testing Proxies...
                      </>
                    ) : (
                      <>
                        <Wifi className="w-4 h-4 mr-2" />
                        Test & Add {bulkProxies.split('\n').filter(l => l.trim()).length} Proxies
                      </>
                    )}
                  </Button>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        }
      />

      {/* Bulk Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-4 mb-4 p-4 rounded-lg bg-primary/10 border border-primary/30 animate-fade-in">
          <span className="text-sm font-medium">
            {selectedIds.size} prox{selectedIds.size !== 1 ? 'ies' : 'y'} selected
          </span>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkTest}
            disabled={isBulkTesting}
            className="gap-2"
          >
            {isBulkTesting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Wifi className="w-4 h-4" />
            )}
            Test Connectivity
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleBulkDelete}
            disabled={isBulkDeleting}
            className="gap-2"
          >
            {isBulkDeleting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            Delete Selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedIds(new Set());
              setTestResults(new Map());
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by host or country..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {statusOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => refreshData()} className="gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Server className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{proxies.length}</p>
              <p className="text-sm text-muted-foreground">Total Proxies</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center">
              <Wifi className="w-6 h-6 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{proxies.filter(p => p.status === 'active').length}</p>
              <p className="text-sm text-muted-foreground">Active</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-destructive/10 flex items-center justify-center">
              <WifiOff className="w-6 h-6 text-destructive" />
            </div>
            <div>
              <p className="text-2xl font-bold">{proxies.filter(p => p.status === 'error').length}</p>
              <p className="text-sm text-muted-foreground">Error</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
              <User className="w-6 h-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {proxies.filter(p => accounts.some(a => a.proxyId === p.id)).length}
              </p>
              <p className="text-sm text-muted-foreground">In Use</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Proxies List */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : filteredProxies.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Globe className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No proxies found</h3>
            <p className="text-muted-foreground text-center mb-4">
              {searchQuery || statusFilter !== 'all' 
                ? 'Try adjusting your filters'
                : 'Add your first proxy to get started'}
            </p>
            {!searchQuery && statusFilter === 'all' && (
              <Button onClick={() => setIsAddOpen(true)} className="gap-2">
                <Plus className="w-4 h-4" />
                Add Proxies
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Select All Header */}
          <div className="flex items-center gap-4 px-4 py-2 bg-secondary/50 rounded-lg">
            <Checkbox
              checked={isAllSelected}
              onCheckedChange={toggleSelectAll}
              aria-label="Select all"
            />
            <span className="text-sm text-muted-foreground">
              {isAllSelected ? 'Deselect all' : 'Select all'} ({filteredProxies.length} proxies)
            </span>
          </div>

          {/* Proxy Cards */}
          {filteredProxies.map((proxy) => {
            const testResult = testResults.get(proxy.id);
            const accountsUsing = getAccountsUsingProxy(proxy.id);
            
            return (
              <Card 
                key={proxy.id} 
                className={cn(
                  "hover:border-primary/20 transition-colors",
                  selectedIds.has(proxy.id) && "border-primary/50 bg-primary/5"
                )}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {/* Checkbox */}
                    <Checkbox
                      checked={selectedIds.has(proxy.id)}
                      onCheckedChange={() => toggleSelect(proxy.id)}
                      aria-label={`Select ${proxy.host}`}
                    />

                    {/* Status Icon */}
                    <div className={cn(
                      "w-10 h-10 rounded-lg flex items-center justify-center",
                      proxy.status === 'active' && "bg-green-500/10",
                      proxy.status === 'error' && "bg-destructive/10",
                      proxy.status === 'inactive' && "bg-muted"
                    )}>
                      {testResult?.status === 'testing' ? (
                        <Loader2 className="w-5 h-5 text-primary animate-spin" />
                      ) : proxy.status === 'active' ? (
                        <Wifi className="w-5 h-5 text-green-500" />
                      ) : proxy.status === 'error' ? (
                        <WifiOff className="w-5 h-5 text-destructive" />
                      ) : (
                        <Globe className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium font-mono">{proxy.host}:{proxy.port}</span>
                        {getStatusBadge(proxy.status)}
                        {testResult?.status === 'success' && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-600 border border-green-500/30">
                            {testResult.responseTime}ms
                          </span>
                        )}
                        {testResult?.status === 'failed' && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-destructive/20 text-destructive border border-destructive/30">
                            Failed
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                        <span className="uppercase">{proxy.type}</span>
                        {proxy.username && <span>• Auth: {proxy.username}</span>}
                        {proxy.country && <span>• {proxy.country}</span>}
                        {proxy.responseTime && <span>• {proxy.responseTime}ms</span>}
                      </div>
                    </div>

                    {/* Accounts Using */}
                    {accountsUsing.length > 0 && (
                      <div className="text-center">
                        <div className="font-medium">{accountsUsing.length}</div>
                        <div className="text-xs text-muted-foreground">Accounts</div>
                      </div>
                    )}

                    {/* Last Checked */}
                    {proxy.lastChecked && (
                      <div className="text-center hidden md:block">
                        <div className="flex items-center gap-1 text-sm">
                          <Clock className="w-3 h-3" />
                          {new Date(proxy.lastChecked).toLocaleTimeString()}
                        </div>
                        <div className="text-xs text-muted-foreground">Last Check</div>
                      </div>
                    )}

                    {/* Status Select */}
                    <Select
                      value={proxy.status}
                      onValueChange={(value) => handleStatusChange(proxy.id, value as any)}
                    >
                      <SelectTrigger className="w-28 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {statusOptions.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Delete */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(proxy.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Proxies;
