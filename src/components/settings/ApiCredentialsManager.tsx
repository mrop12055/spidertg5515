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
import { Plus, Trash2, Upload, Key, RotateCcw, RefreshCw, Loader2, Activity } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ApiCredential {
  id: string;
  name: string;
  api_id: string;
  api_hash: string;
  client_type: string;
  accounts_count: number;
  is_active: boolean;
  created_at: string;
  usage_count: number;
  last_used_at: string | null;
  daily_usage: number;
}

export const ApiCredentialsManager: React.FC = () => {
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isBulkDialogOpen, setIsBulkDialogOpen] = useState(false);
  
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

  const fetchCredentials = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('telegram_api_credentials')
        .select('*')
        .order('usage_count', { ascending: false });
      
      if (error) throw error;
      setCredentials((data || []).map(d => ({
        ...d,
        usage_count: d.usage_count || 0,
        daily_usage: d.daily_usage || 0,
      })));
    } catch (error) {
      console.error('Failed to fetch API credentials:', error);
      toast.error('Failed to load API credentials');
    } finally {
      setIsLoading(false);
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
          is_active: true,
          usage_count: 0,
          daily_usage: 0
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
        usage_count: number;
        daily_usage: number;
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
            is_active: true,
            usage_count: 0,
            daily_usage: 0
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

  const handleResetUsage = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('telegram_api_credentials')
        .update({ usage_count: 0 })
        .eq('is_active', true);
      
      if (error) throw error;
      
      toast.success('Usage counts reset');
      fetchCredentials();
    } catch (error: any) {
      console.error('Failed to reset usage:', error);
      toast.error(error.message || 'Failed to reset');
    } finally {
      setIsSaving(false);
    }
  };

  const totalUsage = credentials.reduce((sum, c) => sum + (c.usage_count || 0), 0);
  const activeCount = credentials.filter(c => c.is_active).length;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg flex items-center gap-3">
              <Key className="w-5 h-5" />
              API Credentials (Round-Robin)
            </CardTitle>
            <CardDescription>
              APIs are rotated evenly across all tasks. Each task gets the least-used API.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchCredentials} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleResetUsage} disabled={isSaving}>
              <RotateCcw className="w-4 h-4 mr-2" />
              Reset Usage
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
            <p className="text-2xl font-bold text-green-500">{activeCount}</p>
            <p className="text-xs text-muted-foreground">Active (In Rotation)</p>
          </div>
          <div className="p-3 rounded-lg border bg-card">
            <p className="text-2xl font-bold text-blue-500">{totalUsage}</p>
            <p className="text-xs text-muted-foreground">Total Tasks</p>
          </div>
        </div>

        {/* Round-Robin Explanation */}
        <div className="p-3 rounded-lg border bg-muted/50 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Activity className="w-4 h-4" />
            <span>
              <strong>Round-Robin:</strong> Each task uses the API with the lowest usage count. 
              With {activeCount} active APIs and {totalUsage} tasks, each API handles ~{activeCount > 0 ? Math.round(totalUsage / activeCount) : 0} tasks evenly.
            </span>
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
            <p className="text-sm">Add credentials from my.telegram.org to enable messaging</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>API ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-center">Usage</TableHead>
                  <TableHead className="text-center">Last Used</TableHead>
                  <TableHead className="text-center">Active</TableHead>
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
                      <Badge variant={cred.usage_count > 0 ? "default" : "secondary"}>
                        {cred.usage_count || 0}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center text-xs text-muted-foreground">
                      {cred.last_used_at 
                        ? formatDistanceToNow(new Date(cred.last_used_at), { addSuffix: true })
                        : 'Never'}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={cred.is_active}
                        onCheckedChange={() => handleToggleActive(cred.id, cred.is_active)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
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
                              This API has been used {cred.usage_count || 0} times. Deleting will remove it from the rotation pool.
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
