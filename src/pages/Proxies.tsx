import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Trash2, RefreshCw, Server, Globe, Clock, Zap, Upload } from 'lucide-react';
import { Proxy } from '@/types/telegram';
import { format } from 'date-fns';

const Proxies: React.FC = () => {
  const { proxies, accounts, addProxy, addProxiesBulk, deleteProxy, assignProxy } = useTelegram();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [bulkProxies, setBulkProxies] = useState('');
  const [newProxy, setNewProxy] = useState({
    host: '',
    port: 8080,
    username: '',
    password: '',
    type: 'http' as Proxy['type']
  });

  const handleAddProxy = () => {
    if (!newProxy.host) return;
    addProxy(newProxy);
    setNewProxy({ host: '', port: 8080, username: '', password: '', type: 'http' });
    setIsAddOpen(false);
  };

  const handleBulkAdd = () => {
    if (!bulkProxies.trim()) return;
    addProxiesBulk(bulkProxies);
    setBulkProxies('');
    setIsAddOpen(false);
  };

  const getStatusColor = (status: Proxy['status']) => {
    switch (status) {
      case 'active': return 'bg-status-active text-status-active-foreground';
      case 'inactive': return 'bg-muted text-muted-foreground';
      case 'error': return 'bg-destructive text-destructive-foreground';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getAssignedAccount = (proxyId: string) => {
    return accounts.find(a => a.proxyId === proxyId);
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Proxy Management"
        description="Manage proxies for your Telegram accounts"
        action={
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                Add Proxy
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Proxies</DialogTitle>
              </DialogHeader>
              <Tabs defaultValue="single" className="pt-4">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="single">Single</TabsTrigger>
                  <TabsTrigger value="bulk">Bulk Import</TabsTrigger>
                </TabsList>
                <TabsContent value="single" className="space-y-4 pt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Host</Label>
                      <Input
                        placeholder="192.168.1.1"
                        value={newProxy.host}
                        onChange={(e) => setNewProxy(prev => ({ ...prev, host: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Port</Label>
                      <Input
                        type="number"
                        placeholder="8080"
                        value={newProxy.port}
                        onChange={(e) => setNewProxy(prev => ({ ...prev, port: parseInt(e.target.value) || 8080 }))}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <Select
                      value={newProxy.type}
                      onValueChange={(value) => setNewProxy(prev => ({ ...prev, type: value as Proxy['type'] }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="https">HTTPS</SelectItem>
                        <SelectItem value="socks4">SOCKS4</SelectItem>
                        <SelectItem value="socks5">SOCKS5</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Username (optional)</Label>
                      <Input
                        placeholder="username"
                        value={newProxy.username}
                        onChange={(e) => setNewProxy(prev => ({ ...prev, username: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Password (optional)</Label>
                      <Input
                        type="password"
                        placeholder="password"
                        value={newProxy.password}
                        onChange={(e) => setNewProxy(prev => ({ ...prev, password: e.target.value }))}
                      />
                    </div>
                  </div>
                  <Button onClick={handleAddProxy} className="w-full">Add Proxy</Button>
                </TabsContent>
                <TabsContent value="bulk" className="space-y-4 pt-4">
                  <div className="space-y-2">
                    <Label>Proxy List</Label>
                    <Textarea
                      placeholder="host:port:username:password&#10;host:port:username:password&#10;host:port"
                      value={bulkProxies}
                      onChange={(e) => setBulkProxies(e.target.value)}
                      rows={8}
                    />
                    <p className="text-xs text-muted-foreground">
                      Format: host:port or host:port:username:password (one per line)
                    </p>
                  </div>
                  <Button onClick={handleBulkAdd} className="w-full gap-2">
                    <Upload className="w-4 h-4" />
                    Import Proxies
                  </Button>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Server className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{proxies.length}</p>
                <p className="text-sm text-muted-foreground">Total Proxies</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-status-active/10">
                <Zap className="w-5 h-5 text-status-active" />
              </div>
              <div>
                <p className="text-2xl font-bold">{proxies.filter(p => p.status === 'active').length}</p>
                <p className="text-sm text-muted-foreground">Active</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <Globe className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-2xl font-bold">{proxies.filter(p => p.assignedAccountId).length}</p>
                <p className="text-sm text-muted-foreground">Assigned</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-destructive/10">
                <Clock className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <p className="text-2xl font-bold">{proxies.filter(p => p.status === 'error').length}</p>
                <p className="text-sm text-muted-foreground">Errors</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Proxy Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Proxies</CardTitle>
        </CardHeader>
        <CardContent>
          {proxies.length === 0 ? (
            <div className="py-12 text-center">
              <Server className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              <h3 className="text-lg font-medium mb-2">No Proxies Yet</h3>
              <p className="text-muted-foreground mb-4">Add proxies to assign them to your accounts</p>
              <Button onClick={() => setIsAddOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add Proxy
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host:Port</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Response Time</TableHead>
                  <TableHead>Assigned To</TableHead>
                  <TableHead>Last Checked</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proxies.map((proxy) => {
                  const assignedAccount = getAssignedAccount(proxy.id);
                  return (
                    <TableRow key={proxy.id}>
                      <TableCell className="font-mono text-sm">
                        {proxy.host}:{proxy.port}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{proxy.type.toUpperCase()}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={getStatusColor(proxy.status)}>
                          {proxy.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{proxy.country || '-'}</TableCell>
                      <TableCell>
                        {proxy.responseTime ? `${proxy.responseTime}ms` : '-'}
                      </TableCell>
                      <TableCell>
                        {assignedAccount ? (
                          <span className="text-sm">
                            {assignedAccount.firstName} ({assignedAccount.phoneNumber})
                          </span>
                        ) : (
                          <Select
                            onValueChange={(accountId) => assignProxy(accountId, proxy.id)}
                          >
                            <SelectTrigger className="w-[180px] h-8">
                              <SelectValue placeholder="Assign account" />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts.filter(a => !a.proxyId).map(account => (
                                <SelectItem key={account.id} value={account.id}>
                                  {account.firstName} ({account.phoneNumber})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {proxy.lastChecked ? format(proxy.lastChecked, 'MMM d, HH:mm') : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <RefreshCw className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-destructive"
                            onClick={() => deleteProxy(proxy.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </DashboardLayout>
  );
};

export default Proxies;
