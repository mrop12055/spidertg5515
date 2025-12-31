import React, { useState, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { 
  Plus, Upload, Trash2, Phone, FileText, 
  CheckCircle, XCircle, AlertTriangle, Loader2, Search, Filter
} from 'lucide-react';
import { format } from 'date-fns';
import { TelegramAccount, AccountStatus } from '@/types/telegram';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useDropzone } from 'react-dropzone';
import { cn } from '@/lib/utils';

const statusOptions: { value: AccountStatus; label: string; color: string }[] = [
  { value: 'active', label: 'Active', color: 'bg-status-active text-status-active-foreground' },
  { value: 'banned', label: 'Banned', color: 'bg-destructive text-destructive-foreground' },
  { value: 'restricted', label: 'Restricted', color: 'bg-status-warning text-status-warning-foreground' },
  { value: 'disconnected', label: 'Disconnected', color: 'bg-muted text-muted-foreground' },
  { value: 'cooldown', label: 'Cooldown', color: 'bg-status-warning text-status-warning-foreground' },
];

interface SessionFile {
  file: File;
  phoneNumber: string;
  base64Data: string;
}

const Accounts: React.FC = () => {
  const { accounts, uploadProgress, refreshData, isLoading } = useTelegram();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isUploading, setIsUploading] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<SessionFile[]>([]);
  const [uploadResults, setUploadResults] = useState<{ successful: number; failed: number } | null>(null);

  // Extract phone number from filename (e.g., "5493416219301.session" -> "+5493416219301")
  const extractPhoneFromFilename = (filename: string): string => {
    const baseName = filename.replace(/\.session$/i, '');
    // Remove any non-digit characters except + at the start
    const cleaned = baseName.replace(/[^\d+]/g, '');
    // Add + prefix if not present
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  };

  // Convert file to base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix to get just the base64 data
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const validFiles = acceptedFiles.filter(f => f.name.endsWith('.session'));
    
    if (validFiles.length === 0) {
      toast.error('Please upload .session files');
      return;
    }

    const processedFiles: SessionFile[] = [];
    
    for (const file of validFiles) {
      try {
        const base64Data = await fileToBase64(file);
        const phoneNumber = extractPhoneFromFilename(file.name);
        processedFiles.push({ file, phoneNumber, base64Data });
      } catch (error) {
        console.error(`Error processing ${file.name}:`, error);
      }
    }

    setSessionFiles(processedFiles);
    setUploadResults(null);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/x-sqlite3': ['.session'],
      'application/octet-stream': ['.session'],
    },
    disabled: isUploading
  });

  const handleUploadSessions = async () => {
    if (sessionFiles.length === 0) {
      toast.error('No session files selected');
      return;
    }

    setIsUploading(true);
    setUploadResults(null);

    try {
      const accountsToUpload = sessionFiles.map(sf => ({
        phone_number: sf.phoneNumber,
        session_data: sf.base64Data,
      }));

      const { data, error } = await supabase.functions.invoke('process-account-upload', {
        body: { accounts: accountsToUpload }
      });

      if (error) throw error;

      setUploadResults({
        successful: data.successful || 0,
        failed: data.failed || 0,
      });

      if (data.successful > 0) {
        toast.success(`Uploaded ${data.successful} account(s)`);
      }
      if (data.failed > 0) {
        toast.error(`${data.failed} account(s) failed`);
      }

      // Clear files and close dialog on success
      if (data.successful > 0 && data.failed === 0) {
        setSessionFiles([]);
        setIsAddOpen(false);
      }
      
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

  const removeSessionFile = (index: number) => {
    setSessionFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Telegram Accounts"
        description="Upload your Telegram session files to manage accounts"
        action={
          <Dialog open={isAddOpen} onOpenChange={(open) => {
            setIsAddOpen(open);
            if (!open) {
              setSessionFiles([]);
              setUploadResults(null);
            }
          }}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                Add Accounts
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Upload Session Files</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                {/* Drop Zone */}
                <div
                  {...getRootProps()}
                  className={cn(
                    "relative border-2 border-dashed rounded-xl p-8 transition-all duration-200 cursor-pointer",
                    "hover:border-primary/50 hover:bg-primary/5",
                    isDragActive && "border-primary bg-primary/10 scale-[1.02]",
                    isUploading && "pointer-events-none opacity-60",
                    "border-border bg-card/50"
                  )}
                >
                  <input {...getInputProps()} />
                  
                  <div className="flex flex-col items-center text-center">
                    <div className={cn(
                      "w-16 h-16 rounded-2xl flex items-center justify-center mb-4 transition-transform duration-200",
                      isDragActive ? "scale-110 bg-primary" : "bg-secondary",
                    )}>
                      <Upload className={cn(
                        "w-8 h-8",
                        isDragActive ? "text-primary-foreground" : "text-muted-foreground"
                      )} />
                    </div>
                    
                    <p className="text-lg font-semibold text-foreground">
                      {isDragActive ? 'Drop files here' : 'Drop .session files here'}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      or click to browse
                    </p>
                    
                    <div className="flex flex-wrap gap-2 mt-4 justify-center">
                      <span className="px-2 py-1 rounded-md bg-secondary text-xs font-medium text-muted-foreground">
                        .session
                      </span>
                    </div>
                  </div>
                </div>

                {/* Selected Files */}
                {sessionFiles.length > 0 && (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {sessionFiles.map((sf, i) => (
                      <div 
                        key={i}
                        className="flex items-center gap-3 p-3 rounded-lg bg-card border border-border"
                      >
                        <FileText className="w-5 h-5 text-primary flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{sf.file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Phone: {sf.phoneNumber}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeSessionFile(i)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Upload Results */}
                {uploadResults && (
                  <div className="flex items-center gap-4 p-3 rounded-lg bg-accent/50 border">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle className="w-4 h-4 text-green-500" />
                      <span className="text-sm">{uploadResults.successful} uploaded</span>
                    </div>
                    {uploadResults.failed > 0 && (
                      <div className="flex items-center gap-1.5">
                        <XCircle className="w-4 h-4 text-destructive" />
                        <span className="text-sm">{uploadResults.failed} failed</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setIsAddOpen(false)}>
                    Cancel
                  </Button>
                  <Button 
                    onClick={handleUploadSessions} 
                    disabled={isUploading || sessionFiles.length === 0}
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 mr-2" />
                        Upload {sessionFiles.length} Account{sessionFiles.length !== 1 ? 's' : ''}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
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
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Processing accounts...</span>
              <span className="text-sm text-muted-foreground">
                {uploadProgress.processed}/{uploadProgress.total}
              </span>
            </div>
            <Progress value={(uploadProgress.processed / uploadProgress.total) * 100} />
            <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
              <span className="text-green-500">✓ {uploadProgress.successful} successful</span>
              <span className="text-destructive">✗ {uploadProgress.failed} failed</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Accounts List */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : filteredAccounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Phone className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No accounts found</h3>
            <p className="text-muted-foreground text-center mb-4">
              {searchQuery || statusFilter !== 'all' 
                ? 'Try adjusting your filters'
                : 'Upload your Telegram session files to get started'}
            </p>
            {!searchQuery && statusFilter === 'all' && (
              <Button onClick={() => setIsAddOpen(true)} className="gap-2">
                <Plus className="w-4 h-4" />
                Add Accounts
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredAccounts.map((account) => (
            <Card key={account.id} className="hover:border-primary/20 transition-colors">
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  {/* Avatar */}
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Phone className="w-5 h-5 text-primary" />
                  </div>
                  
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{account.phoneNumber}</span>
                      {getStatusBadge(account.status)}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {account.firstName && `${account.firstName} ${account.lastName || ''}`}
                      {account.username && ` • @${account.username}`}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="hidden md:flex items-center gap-6 text-sm">
                    <div className="text-center">
                      <div className="font-medium">{account.messagesSentToday || 0}</div>
                      <div className="text-xs text-muted-foreground">Sent Today</div>
                    </div>
                    <div className="text-center">
                      <div className="font-medium">{account.dailyLimit || 25}</div>
                      <div className="text-xs text-muted-foreground">Daily Limit</div>
                    </div>
                    <div className="text-center">
                      <div className="font-medium">{account.maturityDays || 0}d</div>
                      <div className="text-xs text-muted-foreground">Maturity</div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <Select
                      value={account.status}
                      onValueChange={(value) => handleStatusChange(account.id, value as AccountStatus)}
                    >
                      <SelectTrigger className="w-32 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {statusOptions.map(opt => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteAccount(account.id)}
                      className="text-muted-foreground hover:text-destructive"
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