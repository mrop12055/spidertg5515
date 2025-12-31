import React, { useState, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Plus, Upload, Trash2, Edit, Phone, User, Key, FileText, 
  CheckCircle, XCircle, AlertTriangle, Loader2, Copy, Search, Filter
} from 'lucide-react';
import { format } from 'date-fns';
import { TelegramAccount, AccountStatus } from '@/types/telegram';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

const statusOptions: { value: AccountStatus; label: string; color: string }[] = [
  { value: 'active', label: 'Active', color: 'bg-status-active text-status-active-foreground' },
  { value: 'banned', label: 'Banned', color: 'bg-destructive text-destructive-foreground' },
  { value: 'restricted', label: 'Restricted', color: 'bg-status-warning text-status-warning-foreground' },
  { value: 'disconnected', label: 'Disconnected', color: 'bg-muted text-muted-foreground' },
  { value: 'cooldown', label: 'Cooldown', color: 'bg-status-warning text-status-warning-foreground' },
];

const Accounts: React.FC = () => {
  const { accounts, uploadProgress, refreshData, isLoading } = useTelegram();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isUploading, setIsUploading] = useState(false);

  // Single account form
  const [newAccount, setNewAccount] = useState({
    phone_number: '',
    first_name: '',
    last_name: '',
    username: '',
    api_id: '',
    api_hash: '',
    session_data: '',
  });

  // Bulk upload
  const [bulkSessionData, setBulkSessionData] = useState('');

  const handleAddAccount = async () => {
    if (!newAccount.phone_number) {
      toast.error('Phone number is required');
      return;
    }

    setIsUploading(true);
    try {
      const { data, error } = await supabase.functions.invoke('process-account-upload', {
        body: { 
          accounts: [{
            phone_number: newAccount.phone_number,
            first_name: newAccount.first_name || undefined,
            last_name: newAccount.last_name || undefined,
            username: newAccount.username || undefined,
            api_id: newAccount.api_id || undefined,
            api_hash: newAccount.api_hash || undefined,
            session_data: newAccount.session_data || undefined,
          }]
        }
      });

      if (error) throw error;

      toast.success('Account added successfully');
      setNewAccount({ phone_number: '', first_name: '', last_name: '', username: '', api_id: '', api_hash: '', session_data: '' });
      setIsAddOpen(false);
      refreshData();
    } catch (error) {
      console.error('Error adding account:', error);
      toast.error('Failed to add account');
    } finally {
      setIsUploading(false);
    }
  };

  const handleBulkUpload = async () => {
    if (!bulkSessionData.trim()) {
      toast.error('Please enter session data');
      return;
    }

    setIsUploading(true);
    try {
      // Parse bulk data - supports multiple formats:
      // Format 1: One session string per line
      // Format 2: JSON array
      // Format 3: phone:session per line
      
      let accountsToUpload: any[] = [];
      const lines = bulkSessionData.trim().split('\n').filter(l => l.trim());

      // Try to parse as JSON first
      try {
        const jsonData = JSON.parse(bulkSessionData);
        if (Array.isArray(jsonData)) {
          accountsToUpload = jsonData.map(acc => ({
            phone_number: acc.phone_number || acc.phone || `+unknown_${Date.now()}`,
            first_name: acc.first_name,
            last_name: acc.last_name,
            username: acc.username,
            api_id: acc.api_id,
            api_hash: acc.api_hash,
            session_data: acc.session_data || acc.session_string || acc.session,
          }));
        }
      } catch {
        // Not JSON, try line-by-line parsing
        for (const line of lines) {
          const trimmedLine = line.trim();
          
          // Format: phone:session or phone,session
          if (trimmedLine.includes(':') || trimmedLine.includes(',')) {
            const separator = trimmedLine.includes(':') ? ':' : ',';
            const parts = trimmedLine.split(separator);
            accountsToUpload.push({
              phone_number: parts[0].trim(),
              session_data: parts.slice(1).join(separator).trim(),
            });
          } else {
            // Just a session string - generate phone number
            accountsToUpload.push({
              phone_number: `+unknown_${Date.now()}_${accountsToUpload.length}`,
              session_data: trimmedLine,
            });
          }
        }
      }

      if (accountsToUpload.length === 0) {
        toast.error('No valid accounts found in input');
        return;
      }

      const { data, error } = await supabase.functions.invoke('process-account-upload', {
        body: { accounts: accountsToUpload }
      });

      if (error) throw error;

      toast.success(`Uploaded ${data.successful} accounts`);
      if (data.failed > 0) {
        toast.error(`${data.failed} accounts failed`);
      }
      
      setBulkSessionData('');
      setIsBulkOpen(false);
      refreshData();
    } catch (error) {
      console.error('Error uploading accounts:', error);
      toast.error('Failed to upload accounts');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    try {
      const { error } = await supabase
        .from('telegram_accounts')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Account deleted');
      refreshData();
    } catch (error) {
      console.error('Error deleting account:', error);
      toast.error('Failed to delete account');
    }
  };

  const handleStatusChange = async (id: string, status: AccountStatus) => {
    try {
      const { error } = await supabase
        .from('telegram_accounts')
        .update({ status })
        .eq('id', id);

      if (error) throw error;
      refreshData();
    } catch (error) {
      console.error('Error updating status:', error);
      toast.error('Failed to update status');
    }
  };

  const getStatusBadge = (status: AccountStatus) => {
    const option = statusOptions.find(o => o.value === status);
    return <Badge className={option?.color || 'bg-muted'}>{option?.label || status}</Badge>;
  };

  const filteredAccounts = accounts.filter(acc => {
    const matchesSearch = 
      acc.phoneNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (acc.firstName?.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (acc.username?.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesStatus = statusFilter === 'all' || acc.status === statusFilter;
    
    return matchesSearch && matchesStatus;
  });

  return (
    <DashboardLayout>
      <PageHeader
        title="Telegram Accounts"
        description="Manage your Telegram accounts for bulk messaging"
        action={
          <div className="flex gap-2">
            <Dialog open={isBulkOpen} onOpenChange={setIsBulkOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="gap-2">
                  <Upload className="w-4 h-4" />
                  Bulk Upload
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Bulk Upload Accounts</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  <div className="p-4 rounded-lg bg-accent/50 border">
                    <h4 className="font-medium mb-2">Supported Formats:</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• JSON array: <code className="bg-background px-1 rounded">[{`{"phone_number": "+1...", "session_data": "..."}`}]</code></li>
                      <li>• Line format: <code className="bg-background px-1 rounded">+14155551234:session_string_here</code></li>
                      <li>• Phone,Session: <code className="bg-background px-1 rounded">+14155551234,session_string_here</code></li>
                    </ul>
                  </div>
                  
                  <div className="space-y-2">
                    <Label>Session Data</Label>
                    <Textarea
                      placeholder="Paste your session data here..."
                      value={bulkSessionData}
                      onChange={(e) => setBulkSessionData(e.target.value)}
                      rows={10}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {bulkSessionData.split('\n').filter(l => l.trim()).length} lines detected
                    </p>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setIsBulkOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleBulkUpload} disabled={isUploading}>
                      {isUploading ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4 mr-2" />
                          Upload Accounts
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2">
                  <Plus className="w-4 h-4" />
                  Add Account
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add Telegram Account</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  <Tabs defaultValue="basic" className="w-full">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="basic">Basic Info</TabsTrigger>
                      <TabsTrigger value="session">Session Data</TabsTrigger>
                    </TabsList>
                    
                    <TabsContent value="basic" className="space-y-4 mt-4">
                      <div className="space-y-2">
                        <Label>Phone Number *</Label>
                        <Input
                          placeholder="+14155551234"
                          value={newAccount.phone_number}
                          onChange={(e) => setNewAccount(prev => ({ ...prev, phone_number: e.target.value }))}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>First Name</Label>
                          <Input
                            placeholder="John"
                            value={newAccount.first_name}
                            onChange={(e) => setNewAccount(prev => ({ ...prev, first_name: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Last Name</Label>
                          <Input
                            placeholder="Doe"
                            value={newAccount.last_name}
                            onChange={(e) => setNewAccount(prev => ({ ...prev, last_name: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Username</Label>
                        <Input
                          placeholder="@username"
                          value={newAccount.username}
                          onChange={(e) => setNewAccount(prev => ({ ...prev, username: e.target.value }))}
                        />
                      </div>
                    </TabsContent>
                    
                    <TabsContent value="session" className="space-y-4 mt-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>API ID</Label>
                          <Input
                            placeholder="12345678"
                            value={newAccount.api_id}
                            onChange={(e) => setNewAccount(prev => ({ ...prev, api_id: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>API Hash</Label>
                          <Input
                            placeholder="abc123..."
                            value={newAccount.api_hash}
                            onChange={(e) => setNewAccount(prev => ({ ...prev, api_hash: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Session String</Label>
                        <Textarea
                          placeholder="Paste your Telethon session string here..."
                          value={newAccount.session_data}
                          onChange={(e) => setNewAccount(prev => ({ ...prev, session_data: e.target.value }))}
                          rows={4}
                          className="font-mono text-xs"
                        />
                        <p className="text-xs text-muted-foreground">
                          The session string from Telethon (StringSession format)
                        </p>
                      </div>
                    </TabsContent>
                  </Tabs>

                  <div className="flex justify-end gap-2 pt-4">
                    <Button variant="outline" onClick={() => setIsAddOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleAddAccount} disabled={isUploading || !newAccount.phone_number}>
                      {isUploading ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        'Add Account'
                      )}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by phone, name, or username..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <Filter className="w-4 h-4 mr-2" />
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {statusOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        {statusOptions.map(opt => (
          <Card key={opt.value} className="hover:border-primary/30 transition-colors cursor-pointer" onClick={() => setStatusFilter(opt.value)}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{opt.label}</span>
                <Badge className={opt.color}>{accounts.filter(a => a.status === opt.value).length}</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Upload Progress */}
      {uploadProgress.status !== 'idle' && uploadProgress.status !== 'completed' && (
        <Card className="mb-6 border-primary/30">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span className="text-sm font-medium">Uploading accounts...</span>
                  <span className="text-sm text-muted-foreground">
                    {uploadProgress.processed} / {uploadProgress.total}
                  </span>
                </div>
                <Progress value={(uploadProgress.processed / uploadProgress.total) * 100} />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Accounts List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : filteredAccounts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Phone className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-medium mb-2">No Accounts Found</h3>
            <p className="text-muted-foreground mb-4">
              {accounts.length === 0 
                ? 'Add your first Telegram account to get started'
                : 'No accounts match your search criteria'}
            </p>
            <Button onClick={() => setIsAddOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Account
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredAccounts.map((account) => (
            <Card key={account.id} className="hover:border-primary/30 transition-colors">
              <CardContent className="py-4">
                <div className="flex items-center gap-4">
                  {/* Avatar */}
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-primary-foreground font-semibold">
                    {account.firstName?.charAt(0) || account.phoneNumber.charAt(1)}
                  </div>
                  
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-medium truncate">
                        {account.firstName} {account.lastName}
                      </h4>
                      {getStatusBadge(account.status)}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Phone className="w-3 h-3" />
                        {account.phoneNumber}
                      </span>
                      {account.username && (
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          @{account.username}
                        </span>
                      )}
                      {account.sessionFile && (
                        <span className="flex items-center gap-1 text-green-500">
                          <Key className="w-3 h-3" />
                          Session Active
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="text-right text-sm">
                    <p className="text-muted-foreground">Messages Today</p>
                    <p className="font-medium">{account.messagesSentToday} / {account.dailyLimit}</p>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <Select 
                      value={account.status} 
                      onValueChange={(value) => handleStatusChange(account.id, value as AccountStatus)}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {statusOptions.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button 
                      variant="outline" 
                      size="icon"
                      onClick={() => handleDeleteAccount(account.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Accounts;
