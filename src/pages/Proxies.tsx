import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Plus, Trash2, Globe, Loader2, Search, RefreshCw, 
  CheckCircle, XCircle, Wifi, WifiOff, User, Clock, Server
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

  const handleAddSingle = async () => {
    if (!singleProxy.host || !singleProxy.port) {
      toast.error('Host and port are required');
      return;
    }

    setIsAdding(true);
    try {
      const { error } = await supabase
        .from('proxies')
        .insert({
          host: singleProxy.host.trim(),
          port: parseInt(singleProxy.port),
          username: singleProxy.username.trim() || null,
          password: singleProxy.password || null,
          proxy_type: singleProxy.type,
          status: 'active',
        });

      if (error) throw error;
      
      toast.success('Proxy added');
      setSingleProxy({ host: '', port: '', username: '', password: '', type: 'http' });
      setIsAddOpen(false);
      refreshData();
    } catch (error) {
      console.error('Error adding proxy:', error);
      toast.error('Failed to add proxy');
    } finally {
      setIsAdding(false);
    }
  };

  const handleAddBulk = async () => {
    const lines = bulkProxies.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      toast.error('Enter at least one proxy');
      return;
    }

    setIsAdding(true);
    try {
      const proxiesToAdd = lines.map(line => {
        const parts = line.trim().split(':');
        return {
          host: parts[0] || '',
          port: parseInt(parts[1]) || 8080,
          username: parts[2] || null,
          password: parts[3] || null,
          proxy_type: 'http' as const,
          status: 'active' as const,
        };
      }).filter(p => p.host);

      const { error } = await supabase
        .from('proxies')
        .insert(proxiesToAdd);

      if (error) throw error;
      
      toast.success(`Added ${proxiesToAdd.length} proxies`);
      setBulkProxies('');
      setIsAddOpen(false);
      refreshData();
    } catch (error) {
      console.error('Error adding proxies:', error);
      toast.error('Failed to add proxies');
    } finally {
      setIsAdding(false);
    }
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
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                Add Proxies
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Proxies</DialogTitle>
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
                        onChange={(e) => setSingleProxy({ ...singleProxy, host: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Port</Label>
                      <Input
                        type="number"
                        placeholder="8080"
                        value={singleProxy.port}
                        onChange={(e) => setSingleProxy({ ...singleProxy, port: e.target.value })}
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
                  <Button onClick={handleAddSingle} disabled={isAdding} className="w-full">
                    {isAdding ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                    Add Proxy
                  </Button>
                </TabsContent>
                
                <TabsContent value="bulk" className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label>Proxy List</Label>
                    <Textarea
                      placeholder="host:port:username:password&#10;host:port&#10;host:port:username:password"
                      value={bulkProxies}
                      onChange={(e) => setBulkProxies(e.target.value)}
                      rows={8}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      One proxy per line. Format: host:port or host:port:username:password
                    </p>
                  </div>
                  <Button onClick={handleAddBulk} disabled={isAdding} className="w-full">
                    {isAdding ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                    Add {bulkProxies.split('\n').filter(l => l.trim()).length} Proxies
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
            <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <User className="w-6 h-6 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{proxies.filter(p => accounts.some(a => a.proxyId === p.id)).length}</p>
              <p className="text-sm text-muted-foreground">Assigned</p>
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
            const assignedAccounts = getAccountsUsingProxy(proxy.id);
            
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

                    {/* Icon */}
                    <div className={cn(
                      "w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0",
                      testResult?.status === 'success' && "bg-green-500/20",
                      testResult?.status === 'failed' && "bg-destructive/20",
                      testResult?.status === 'testing' && "bg-primary/20",
                      !testResult && proxy.status === 'active' && "bg-green-500/10",
                      !testResult && proxy.status === 'error' && "bg-destructive/10",
                      !testResult && proxy.status === 'inactive' && "bg-muted"
                    )}>
                      {testResult?.status === 'testing' ? (
                        <Loader2 className="w-5 h-5 text-primary animate-spin" />
                      ) : testResult?.status === 'success' ? (
                        <CheckCircle className="w-5 h-5 text-green-500" />
                      ) : testResult?.status === 'failed' ? (
                        <XCircle className="w-5 h-5 text-destructive" />
                      ) : (
                        <Globe className="w-5 h-5 text-primary" />
                      )}
                    </div>
                    
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-medium">{proxy.host}:{proxy.port}</span>
                        {getStatusBadge(proxy.status)}
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-secondary text-muted-foreground">
                          {proxy.type.toUpperCase()}
                        </span>
                        {testResult?.status === 'success' && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-600 border border-green-500/30">
                            {testResult.responseTime}ms
                          </span>
                        )}
                        {testResult?.status === 'failed' && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-destructive/20 text-destructive border border-destructive/30">
                            {testResult.error || 'Failed'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
                        {proxy.username && (
                          <span className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {proxy.username}
                          </span>
                        )}
                        {proxy.country && (
                          <span>{proxy.country}</span>
                        )}
                        {proxy.responseTime && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {proxy.responseTime}ms
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Assigned Accounts */}
                    <div className="hidden md:flex items-center gap-2">
                      {assignedAccounts.length > 0 ? (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
                          <User className="w-4 h-4 text-blue-500" />
                          <span className="text-sm font-medium text-blue-600">
                            {assignedAccounts.length} account{assignedAccounts.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground px-3">Not assigned</span>
                      )}
                    </div>

                    {/* Status Select */}
                    <Select
                      value={proxy.status}
                      onValueChange={(value) => handleStatusChange(proxy.id, value as 'active' | 'inactive' | 'error')}
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
