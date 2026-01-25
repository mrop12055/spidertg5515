import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Plus, Trash2, Upload, Key, Users, CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react';

interface ApiCredential {
  id: string;
  name: string;
  api_id: string;
  api_hash: string;
  client_type: string;
  accounts_count: number;
  is_active: boolean;
  created_at: string;
  last_validated_at: string | null;
  validation_error: string | null;
}

export const ApiCredentialsManager: React.FC = () => {
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isBulkDialogOpen, setIsBulkDialogOpen] = useState(false);
  const [isAssignDialogOpen, setIsAssignDialogOpen] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState<ApiCredential | null>(null);
  
  // Form state for single add
  const [formData, setFormData] = useState({
    name: '',
    api_id: '',
    api_hash: '',
    client_type: 'android'
  });
  
  // Bulk add state
  const [bulkInput, setBulkInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  
  // Assignment state
  const [unassignedAccounts, setUnassignedAccounts] = useState<{ id: string; phone_number: string }[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);

  const fetchCredentials = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('telegram_api_credentials')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setCredentials(data || []);
    } catch (error) {
      console.error('Failed to fetch API credentials:', error);
      toast.error('Failed to load API credentials');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchUnassignedAccounts = async () => {
    try {
      const { data, error } = await supabase
        .from('telegram_accounts')
        .select('id, phone_number')
        .is('api_credential_id', null)
        .eq('status', 'active')
        .limit(500);
      
      if (error) throw error;
      setUnassignedAccounts(data || []);
    } catch (error) {
      console.error('Failed to fetch unassigned accounts:', error);
    }
  };

  useEffect(() => {
    fetchCredentials();
  }, []);

  const handleAddSingle = async () => {
    if (!formData.api_id || !formData.api_hash) {
      toast.error('API ID and API Hash are required');
      return;
    }
    
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('telegram_api_credentials')
        .insert({
          name: formData.name || `API ${formData.api_id}`,
          api_id: formData.api_id,
          api_hash: formData.api_hash,
          client_type: formData.client_type,
          is_active: true
        });
      
      if (error) throw error;
      
      toast.success('API credential added');
      setIsAddDialogOpen(false);
      setFormData({ name: '', api_id: '', api_hash: '', client_type: 'android' });
      fetchCredentials();
    } catch (error: any) {
      console.error('Failed to add API credential:', error);
      toast.error(error.message || 'Failed to add API credential');
    } finally {
      setIsSaving(false);
    }
  };

  const handleBulkAdd = async () => {
    if (!bulkInput.trim()) {
      toast.error('Please enter API credentials');
      return;
    }
    
    setIsSaving(true);
    try {
      // Parse bulk input - supports formats:
      // api_id:api_hash
      // api_id,api_hash
      // api_id api_hash
      // name|api_id|api_hash
      const lines = bulkInput.trim().split('\n').filter(line => line.trim());
      const toInsert: Array<{
        name: string;
        api_id: string;
        api_hash: string;
        client_type: string;
        is_active: boolean;
      }> = [];
      
      for (const line of lines) {
        let parts: string[];
        let name = '';
        let api_id = '';
        let api_hash = '';
        
        if (line.includes('|')) {
          parts = line.split('|').map(p => p.trim());
          if (parts.length >= 3) {
            name = parts[0];
            api_id = parts[1];
            api_hash = parts[2];
          }
        } else if (line.includes(':')) {
          parts = line.split(':').map(p => p.trim());
          api_id = parts[0];
          api_hash = parts[1];
        } else if (line.includes(',')) {
          parts = line.split(',').map(p => p.trim());
          api_id = parts[0];
          api_hash = parts[1];
        } else {
          parts = line.split(/\s+/).map(p => p.trim());
          api_id = parts[0];
          api_hash = parts[1];
        }
        
        if (api_id && api_hash && api_hash.length >= 32) {
          toInsert.push({
            name: name || `API ${api_id}`,
            api_id,
            api_hash,
            client_type: 'android',
            is_active: true
          });
        }
      }
      
      if (toInsert.length === 0) {
        toast.error('No valid API credentials found');
        return;
      }
      
      const { error } = await supabase
        .from('telegram_api_credentials')
        .insert(toInsert);
      
      if (error) throw error;
      
      toast.success(`Added ${toInsert.length} API credentials`);
      setIsBulkDialogOpen(false);
      setBulkInput('');
      fetchCredentials();
    } catch (error: any) {
      console.error('Failed to bulk add:', error);
      toast.error(error.message || 'Failed to add API credentials');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      // First unassign any accounts using this API
      await supabase
        .from('telegram_accounts')
        .update({ api_credential_id: null, api_id: null, api_hash: null })
        .eq('api_credential_id', id);
      
      const { error } = await supabase
        .from('telegram_api_credentials')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      toast.success('API credential deleted');
      fetchCredentials();
    } catch (error: any) {
      console.error('Failed to delete:', error);
      toast.error(error.message || 'Failed to delete');
    }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      const { error } = await supabase
        .from('telegram_api_credentials')
        .update({ is_active: !isActive })
        .eq('id', id);
      
      if (error) throw error;
      
      setCredentials(prev => prev.map(c => 
        c.id === id ? { ...c, is_active: !isActive } : c
      ));
    } catch (error: any) {
      console.error('Failed to toggle:', error);
      toast.error(error.message || 'Failed to update');
    }
  };

  const handleOpenAssignDialog = async (credential: ApiCredential) => {
    setSelectedCredential(credential);
    await fetchUnassignedAccounts();
    setSelectedAccountIds([]);
    setIsAssignDialogOpen(true);
  };

  const handleAssignAccounts = async () => {
    if (!selectedCredential || selectedAccountIds.length === 0) {
      toast.error('Please select accounts to assign');
      return;
    }
    
    setIsSaving(true);
    try {
      // Update accounts with this API credential
      const { error } = await supabase
        .from('telegram_accounts')
        .update({ 
          api_credential_id: selectedCredential.id,
          api_id: selectedCredential.api_id,
          api_hash: selectedCredential.api_hash
        })
        .in('id', selectedAccountIds);
      
      if (error) throw error;
      
      toast.success(`Assigned ${selectedAccountIds.length} accounts`);
      setIsAssignDialogOpen(false);
      fetchCredentials();
    } catch (error: any) {
      console.error('Failed to assign:', error);
      toast.error(error.message || 'Failed to assign accounts');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAutoAssign = async () => {
    // Auto-assign unassigned accounts to APIs with least usage
    setIsSaving(true);
    try {
      // Get unassigned accounts
      const { data: unassigned, error: fetchError } = await supabase
        .from('telegram_accounts')
        .select('id')
        .is('api_credential_id', null)
        .eq('status', 'active');
      
      if (fetchError) throw fetchError;
      if (!unassigned || unassigned.length === 0) {
        toast.info('No unassigned accounts found');
        setIsSaving(false);
        return;
      }
      
      // Get active APIs sorted by usage
      const activeApis = credentials.filter(c => c.is_active).sort((a, b) => a.accounts_count - b.accounts_count);
      
      if (activeApis.length === 0) {
        toast.error('No active APIs available');
        setIsSaving(false);
        return;
      }
      
      // Distribute accounts across APIs
      let assigned = 0;
      const apiUsage = new Map(activeApis.map(api => [api.id, api.accounts_count]));
      
      for (const account of unassigned) {
        // Find API with least usage
        let minApi = activeApis[0];
        let minCount = apiUsage.get(minApi.id) || 0;
        
        for (const api of activeApis) {
          const count = apiUsage.get(api.id) || 0;
          if (count < minCount) {
            minCount = count;
            minApi = api;
          }
        }
        
        // Assign account to this API
        const { error } = await supabase
          .from('telegram_accounts')
          .update({ 
            api_credential_id: minApi.id,
            api_id: minApi.api_id,
            api_hash: minApi.api_hash
          })
          .eq('id', account.id);
        
        if (!error) {
          assigned++;
          apiUsage.set(minApi.id, (apiUsage.get(minApi.id) || 0) + 1);
        }
      }
      
      toast.success(`Auto-assigned ${assigned} accounts`);
      fetchCredentials();
    } catch (error: any) {
      console.error('Failed to auto-assign:', error);
      toast.error(error.message || 'Failed to auto-assign');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg flex items-center gap-3">
              <Key className="w-5 h-5" />
              API Credentials
            </CardTitle>
            <CardDescription>
              Manage Telegram API credentials and assign them to accounts
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchCredentials} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleAutoAssign} disabled={isSaving}>
              <Users className="w-4 h-4 mr-2" />
              Auto-Assign
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Action Buttons */}
        <div className="flex gap-2">
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="default" size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Add Single
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add API Credential</DialogTitle>
                <DialogDescription>
                  Enter Telegram API credentials from my.telegram.org
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Name (optional)</Label>
                  <Input 
                    placeholder="My API"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>API ID *</Label>
                  <Input 
                    placeholder="12345678"
                    value={formData.api_id}
                    onChange={(e) => setFormData(prev => ({ ...prev, api_id: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>API Hash *</Label>
                  <Input 
                    placeholder="32-character hash"
                    value={formData.api_hash}
                    onChange={(e) => setFormData(prev => ({ ...prev, api_hash: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Client Type</Label>
                  <Select 
                    value={formData.client_type} 
                    onValueChange={(value) => setFormData(prev => ({ ...prev, client_type: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="android">Android</SelectItem>
                      <SelectItem value="ios">iOS</SelectItem>
                      <SelectItem value="desktop">Desktop</SelectItem>
                      <SelectItem value="web">Web</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleAddSingle} disabled={isSaving}>
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Add
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          
          <Dialog open={isBulkDialogOpen} onOpenChange={setIsBulkDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Upload className="w-4 h-4 mr-2" />
                Bulk Add
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Bulk Add API Credentials</DialogTitle>
                <DialogDescription>
                  Paste multiple API credentials, one per line
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="text-sm text-muted-foreground">
                  Supported formats:
                  <ul className="list-disc list-inside mt-1 space-y-0.5">
                    <li><code>api_id:api_hash</code></li>
                    <li><code>api_id,api_hash</code></li>
                    <li><code>api_id api_hash</code></li>
                    <li><code>name|api_id|api_hash</code></li>
                  </ul>
                </div>
                <Textarea 
                  placeholder="12345678:0123456789abcdef0123456789abcdef&#10;87654321:fedcba9876543210fedcba9876543210"
                  value={bulkInput}
                  onChange={(e) => setBulkInput(e.target.value)}
                  rows={10}
                  className="font-mono text-sm"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsBulkDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleBulkAdd} disabled={isSaving}>
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Add All
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <div className="p-3 rounded-lg border bg-card">
            <p className="text-2xl font-bold">{credentials.length}</p>
            <p className="text-xs text-muted-foreground">Total APIs</p>
          </div>
          <div className="p-3 rounded-lg border bg-card">
            <p className="text-2xl font-bold text-green-500">
              {credentials.filter(c => c.is_active).length}
            </p>
            <p className="text-xs text-muted-foreground">Active</p>
          </div>
          <div className="p-3 rounded-lg border bg-card">
            <p className="text-2xl font-bold">
              {credentials.reduce((sum, c) => sum + (c.accounts_count || 0), 0)}
            </p>
            <p className="text-xs text-muted-foreground">Assigned Accounts</p>
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : credentials.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Key className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No API credentials added yet</p>
            <p className="text-sm">Add credentials from my.telegram.org</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>API ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-center">Accounts</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((cred) => (
                  <TableRow key={cred.id}>
                    <TableCell className="font-medium">{cred.name}</TableCell>
                    <TableCell className="font-mono text-sm">{cred.api_id}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{cred.client_type}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary">{cred.accounts_count || 0}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={cred.is_active}
                        onCheckedChange={() => handleToggleActive(cred.id, cred.is_active)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenAssignDialog(cred)}
                        >
                          <Users className="w-4 h-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete API Credential?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will unassign {cred.accounts_count || 0} accounts from this API.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDelete(cred.id)}>
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Assign Dialog */}
        <Dialog open={isAssignDialogOpen} onOpenChange={setIsAssignDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Assign Accounts to {selectedCredential?.name}</DialogTitle>
              <DialogDescription>
                Select accounts to assign to this API credential
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              {unassignedAccounts.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  No unassigned accounts available
                </p>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  <div className="flex items-center gap-2 pb-2 border-b">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedAccountIds(unassignedAccounts.map(a => a.id))}
                    >
                      Select All ({unassignedAccounts.length})
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedAccountIds([])}
                    >
                      Clear
                    </Button>
                  </div>
                  {unassignedAccounts.map((account) => (
                    <div 
                      key={account.id}
                      className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-muted/50 ${
                        selectedAccountIds.includes(account.id) ? 'bg-primary/10 border border-primary/30' : ''
                      }`}
                      onClick={() => {
                        setSelectedAccountIds(prev => 
                          prev.includes(account.id) 
                            ? prev.filter(id => id !== account.id)
                            : [...prev, account.id]
                        );
                      }}
                    >
                      <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                        selectedAccountIds.includes(account.id) ? 'bg-primary border-primary' : 'border-muted-foreground'
                      }`}>
                        {selectedAccountIds.includes(account.id) && (
                          <CheckCircle2 className="w-3 h-3 text-primary-foreground" />
                        )}
                      </div>
                      <span className="font-mono text-sm">{account.phone_number}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAssignDialogOpen(false)}>Cancel</Button>
              <Button 
                onClick={handleAssignAccounts} 
                disabled={isSaving || selectedAccountIds.length === 0}
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Assign {selectedAccountIds.length} Accounts
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
};
