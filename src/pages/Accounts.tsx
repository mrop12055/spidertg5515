import React, { useState, useCallback, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { 
  Plus, Upload, Trash2, Phone, FileText, 
  CheckCircle, XCircle, Loader2, Search, Filter, RefreshCw, 
  Check, Shield, Globe, Link2, Unlink, Download, MoreVertical,
  Eye, EyeOff, Image, UserCircle, Users, Wifi, WifiOff, AlertTriangle,
  Clock, MessageSquare, ChevronDown, ChevronRight, Calendar
} from 'lucide-react';
import { TelegramAccount, AccountStatus } from '@/types/telegram';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useDropzone } from 'react-dropzone';
import { cn } from '@/lib/utils';
import JSZip from 'jszip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { differenceInHours, differenceInMinutes, differenceInDays, formatDistanceToNow } from 'date-fns';

const statusOptions: { value: AccountStatus; label: string; color: string }[] = [
  { value: 'active', label: 'Active', color: 'bg-green-500/20 text-green-600 border-green-500/30' },
  { value: 'banned', label: 'Banned', color: 'bg-destructive/20 text-destructive border-destructive/30' },
  { value: 'restricted', label: 'Restricted', color: 'bg-yellow-500/20 text-yellow-600 border-yellow-500/30' },
  { value: 'disconnected', label: 'Disconnected', color: 'bg-muted text-muted-foreground border-border' },
  { value: 'cooldown', label: 'Cooldown', color: 'bg-orange-500/20 text-orange-600 border-orange-500/30' },
];

interface SessionFile {
  file: File;
  phoneNumber: string;
  base64Data: string;
}

interface VerifyResult {
  status: 'checking' | 'active' | 'disconnected' | 'banned';
  reason?: string;
}

interface AccountGroup {
  id: string;
  name: string;
  accountIds: string[];
}

const Accounts: React.FC = () => {
  const { accounts, proxies, uploadProgress, refreshData, isLoading } = useTelegram();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isUploading, setIsUploading] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<SessionFile[]>([]);
  const [uploadResults, setUploadResults] = useState<{ successful: number; failed: number } | null>(null);
  
  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkChecking, setIsBulkChecking] = useState(false);
  const [verifyResults, setVerifyResults] = useState<Map<string, VerifyResult>>(new Map());
  
  // Bulk operations dialogs
  const [isBulkNameOpen, setIsBulkNameOpen] = useState(false);
  const [bulkNames, setBulkNames] = useState('');
  const [isBulkPhotoOpen, setIsBulkPhotoOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isGroupDialogOpen, setIsGroupDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  
  // Bulk proxy assignment
  const [isBulkProxyOpen, setIsBulkProxyOpen] = useState(false);
  const [selectedProxyId, setSelectedProxyId] = useState<string>('');
  const [proxyRatio, setProxyRatio] = useState<'1' | '2' | '3'>('1');
  const [isBulkProxyAssigning, setIsBulkProxyAssigning] = useState(false);
  
  // Collapsed section for unavailable accounts
  const [showUnavailable, setShowUnavailable] = useState(false);
  
  // SpamBot check state
  const [isSpamBotChecking, setIsSpamBotChecking] = useState(false);
  const [spamBotProgress, setSpamBotProgress] = useState<{ total: number; completed: number; results: Map<string, { status: string; result?: string }> }>({ total: 0, completed: 0, results: new Map() });
  
  // Messages sent today tracking
  const [messagesSentLast24h, setMessagesSentLast24h] = useState<Map<string, number>>(new Map());
  
  // Realtime subscription for instant account updates
  useEffect(() => {
    const channel = supabase
      .channel('accounts-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'telegram_accounts' },
        (payload) => {
          console.log('Account change detected:', payload.eventType);
          refreshData();
        }
      )
      .subscribe();

    // Fallback refresh every 10 seconds
    const interval = setInterval(() => {
      refreshData();
    }, 10000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [refreshData]);
  
  // Realtime subscription for SpamBot check tasks
  useEffect(() => {
    if (!isSpamBotChecking) return;
    
    const channel = supabase
      .channel('spambot-tasks')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'account_check_tasks' },
        (payload) => {
          const task = payload.new as any;
          if (task && (task.status === 'completed' || task.status === 'failed')) {
            setSpamBotProgress(prev => {
              const newResults = new Map(prev.results);
              newResults.set(task.account_id, { status: task.status, result: task.result });
              const completed = Array.from(newResults.values()).filter(r => r.status === 'completed' || r.status === 'failed').length;
              
              // Check if all done
              if (completed >= prev.total) {
                setIsSpamBotChecking(false);
                toast.success(`SpamBot check complete: ${completed} account(s) checked`);
                refreshData();
              }
              
              return { ...prev, completed, results: newResults };
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isSpamBotChecking, refreshData]);
  
  // Fetch messages sent in last 24 hours per account
  useEffect(() => {
    const fetchMessageCounts = async () => {
      const yesterday = new Date();
      yesterday.setHours(yesterday.getHours() - 24);
      
      const { data, error } = await supabase
        .from('messages')
        .select('account_id')
        .eq('direction', 'outgoing')
        .gte('created_at', yesterday.toISOString());
      
      if (data && !error) {
        const counts = new Map<string, number>();
        data.forEach((msg: any) => {
          counts.set(msg.account_id, (counts.get(msg.account_id) || 0) + 1);
        });
        setMessagesSentLast24h(counts);
      }
    };
    
    fetchMessageCounts();
    const interval = setInterval(fetchMessageCounts, 60000);
    return () => clearInterval(interval);
  }, []);

  // Extract phone number from filename
  const extractPhoneFromFilename = (filename: string): string => {
    const baseName = filename.replace(/\.session$/i, '');
    const digits = baseName.replace(/\D/g, '');
    if (!digits) {
      return `+unknown_${Date.now()}`;
    }
    return `+${digits}`;
  };

  // Convert file to base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
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

    toast.info(`Processing ${validFiles.length} file(s)...`);
    
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
    toast.success(`${processedFiles.length} file(s) ready to upload`);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/x-sqlite3': ['.session'],
      'application/octet-stream': ['.session'],
    },
    disabled: isUploading,
    multiple: true
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

  const handleProxyChange = async (accountId: string, proxyId: string | null) => {
    try {
      const { error } = await supabase
        .from('telegram_accounts')
        .update({ proxy_id: proxyId })
        .eq('id', accountId);

      if (error) throw error;
      toast.success(proxyId ? 'Proxy assigned' : 'Proxy removed');
      refreshData();
    } catch (error) {
      console.error('Error updating proxy:', error);
      toast.error('Failed to update proxy');
    }
  };

  // Bulk delete
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    
    setIsBulkDeleting(true);
    try {
      const { error } = await supabase
        .from('telegram_accounts')
        .delete()
        .in('id', Array.from(selectedIds));

      if (error) throw error;
      
      toast.success(`Deleted ${selectedIds.size} account(s)`);
      setSelectedIds(new Set());
      refreshData();
    } catch (error) {
      console.error('Error bulk deleting:', error);
      toast.error('Failed to delete accounts');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  // Export sessions
  const handleExportSessions = async () => {
    if (selectedIds.size === 0) return;
    
    setIsExporting(true);
    try {
      const { data: accountsData, error } = await supabase
        .from('telegram_accounts')
        .select('phone_number, session_data, first_name, last_name, username')
        .in('id', Array.from(selectedIds));
      
      if (error) throw error;
      
      const zip = new JSZip();
      
      accountsData?.forEach((acc: any) => {
        if (acc.session_data) {
          const filename = `${acc.phone_number.replace(/\+/g, '')}.session`;
          const binaryData = atob(acc.session_data);
          const bytes = new Uint8Array(binaryData.length);
          for (let i = 0; i < binaryData.length; i++) {
            bytes[i] = binaryData.charCodeAt(i);
          }
          zip.file(filename, bytes);
          
          // Also add metadata JSON
          const metadata = {
            phone_number: acc.phone_number,
            first_name: acc.first_name,
            last_name: acc.last_name,
            username: acc.username,
          };
          zip.file(`${acc.phone_number.replace(/\+/g, '')}.json`, JSON.stringify(metadata, null, 2));
        }
      });
      
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `telegram_sessions_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      
      toast.success(`Exported ${selectedIds.size} session(s)`);
    } catch (error) {
      console.error('Error exporting sessions:', error);
      toast.error('Failed to export sessions');
    } finally {
      setIsExporting(false);
    }
  };

  // Bulk name change
  const handleBulkNameChange = async () => {
    if (selectedIds.size === 0 || !bulkNames.trim()) return;
    
    const names = bulkNames.split(/[,\n]/).map(n => n.trim()).filter(n => n);
    const selectedAccounts = Array.from(selectedIds);
    
    try {
      for (let i = 0; i < selectedAccounts.length; i++) {
        const name = names[i % names.length] || names[0];
        const parts = name.split(' ');
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';
        
        await supabase
          .from('telegram_accounts')
          .update({ first_name: firstName, last_name: lastName || null })
          .eq('id', selectedAccounts[i]);
      }
      
      toast.success(`Updated names for ${selectedAccounts.length} account(s)`);
      setBulkNames('');
      setIsBulkNameOpen(false);
      refreshData();
    } catch (error) {
      console.error('Error updating names:', error);
      toast.error('Failed to update names');
    }
  };

  // Create group from selected accounts
  const handleCreateGroup = () => {
    if (selectedIds.size === 0 || !newGroupName.trim()) return;
    
    const newGroup: AccountGroup = {
      id: `group_${Date.now()}`,
      name: newGroupName,
      accountIds: Array.from(selectedIds),
    };
    
    setGroups(prev => [...prev, newGroup]);
    setNewGroupName('');
    setIsGroupDialogOpen(false);
    toast.success(`Created group "${newGroupName}" with ${selectedIds.size} account(s)`);
  };

  // Bulk proxy assignment
  const handleBulkProxyAssign = async () => {
    if (selectedIds.size === 0 || !selectedProxyId) return;
    
    setIsBulkProxyAssigning(true);
    try {
      const selectedAccountIds = Array.from(selectedIds);
      const ratio = parseInt(proxyRatio);
      
      // Get available active proxies
      const activeProxies = proxies.filter(p => p.status === 'active');
      
      if (activeProxies.length === 0) {
        toast.error('No active proxies available');
        return;
      }
      
      // If single proxy selected, assign it based on ratio
      if (selectedProxyId !== 'auto') {
        for (let i = 0; i < selectedAccountIds.length; i++) {
          await supabase
            .from('telegram_accounts')
            .update({ proxy_id: selectedProxyId })
            .eq('id', selectedAccountIds[i]);
        }
        toast.success(`Assigned proxy to ${selectedAccountIds.length} account(s)`);
      } else {
        // Auto-assign proxies based on ratio
        let proxyIndex = 0;
        let accountsAssignedToCurrentProxy = 0;
        
        for (const accountId of selectedAccountIds) {
          const proxyToAssign = activeProxies[proxyIndex % activeProxies.length];
          
          await supabase
            .from('telegram_accounts')
            .update({ proxy_id: proxyToAssign.id })
            .eq('id', accountId);
          
          accountsAssignedToCurrentProxy++;
          if (accountsAssignedToCurrentProxy >= ratio) {
            proxyIndex++;
            accountsAssignedToCurrentProxy = 0;
          }
        }
        toast.success(`Auto-assigned ${activeProxies.length} proxy(s) to ${selectedAccountIds.length} account(s)`);
      }
      
      setIsBulkProxyOpen(false);
      setSelectedIds(new Set());
      refreshData();
    } catch (error) {
      console.error('Error assigning proxies:', error);
      toast.error('Failed to assign proxies');
    } finally {
      setIsBulkProxyAssigning(false);
    }
  };

  // Get restriction time remaining
  const getRestrictionTimeLeft = (restrictedUntil: Date | undefined) => {
    if (!restrictedUntil) return null;
    const now = new Date();
    const diff = restrictedUntil.getTime() - now.getTime();
    if (diff <= 0) return 'Expired';
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h left`;
    }
    return `${hours}h ${minutes}m left`;
  };

  // Get account age in days
  const getAccountAge = (createdAt: Date) => {
    return differenceInDays(new Date(), createdAt);
  };

  // SpamBot check - queue tasks for Python script to process
  // Implements 96-hour cooldown - accounts checked within last 96 hours are skipped
  const handleSpamBotCheck = async () => {
    if (selectedIds.size === 0) return;
    
    const now = new Date();
    const cooldownHours = 96;
    
    // Fetch last_spambot_check for selected accounts
    const { data: accountsData, error: fetchError } = await supabase
      .from('telegram_accounts')
      .select('id, last_spambot_check, phone_number')
      .in('id', Array.from(selectedIds));
    
    if (fetchError) {
      toast.error('Failed to fetch account data');
      return;
    }
    
    // Separate accounts into eligible and skipped
    const eligibleIds: string[] = [];
    const skippedIds: string[] = [];
    
    accountsData?.forEach((acc: any) => {
      if (acc.last_spambot_check) {
        const lastCheck = new Date(acc.last_spambot_check);
        const hoursSinceCheck = differenceInHours(now, lastCheck);
        
        if (hoursSinceCheck < cooldownHours) {
          skippedIds.push(acc.id);
        } else {
          eligibleIds.push(acc.id);
        }
      } else {
        // Never checked - eligible
        eligibleIds.push(acc.id);
      }
    });
    
    // Show summary message
    if (skippedIds.length > 0 && eligibleIds.length === 0) {
      toast.warning(`All ${skippedIds.length} account(s) were checked within 96 hours. No checks queued.`);
      return;
    }
    
    if (skippedIds.length > 0) {
      toast.info(`${skippedIds.length} account(s) skipped (checked within 96 hours), ${eligibleIds.length} account(s) queued for checking`);
    }
    
    if (eligibleIds.length === 0) {
      return;
    }
    
    setIsSpamBotChecking(true);
    setSpamBotProgress({ total: eligibleIds.length, completed: 0, results: new Map() });
    
    try {
      // Insert tasks only for eligible accounts
      const tasks = eligibleIds.map(accountId => ({
        account_id: accountId,
        task_type: 'spambot_check',
        status: 'pending',
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      toast.success(`Queued ${eligibleIds.length} account(s) for SpamBot check. Run the Python script to process.`);
    } catch (error) {
      console.error('Error queuing SpamBot check:', error);
      toast.error('Failed to queue SpamBot check');
      setIsSpamBotChecking(false);
    }
  };

  // Real session verification via edge function
  const handleBulkCheck = async () => {
    if (selectedIds.size === 0) return;
    
    setIsBulkChecking(true);
    const newResults = new Map<string, VerifyResult>();
    
    selectedIds.forEach(id => newResults.set(id, { status: 'checking' }));
    setVerifyResults(new Map(newResults));

    try {
      const { data, error } = await supabase.functions.invoke('verify-sessions', {
        body: { account_ids: Array.from(selectedIds) }
      });

      if (error) throw error;

      for (const result of data.results || []) {
        newResults.set(result.id, { 
          status: result.status, 
          reason: result.reason 
        });
      }

      setVerifyResults(new Map(newResults));
      toast.success(`Verified: ${data.summary?.valid || 0} active, ${data.summary?.invalid || 0} invalid`);
      refreshData();
    } catch (error) {
      console.error('Error checking accounts:', error);
      toast.error('Failed to verify accounts');
      selectedIds.forEach(id => newResults.set(id, { status: 'disconnected', reason: 'Verification failed' }));
      setVerifyResults(new Map(newResults));
    } finally {
      setIsBulkChecking(false);
    }
  };

  const getStatusBadge = (status: AccountStatus) => {
    const option = statusOptions.find(o => o.value === status);
    return (
      <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border", option?.color || 'bg-muted')}>
        {option?.label || status}
      </span>
    );
  };

  const getAccountsByGroup = () => {
    if (selectedGroup === 'all') return accounts;
    const group = groups.find(g => g.id === selectedGroup);
    if (!group) return accounts;
    return accounts.filter(a => group.accountIds.includes(a.id));
  };

  const filteredAccounts = getAccountsByGroup().filter(acc => {
    const matchesSearch = 
      acc.phoneNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (acc.firstName?.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (acc.username?.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesStatus = statusFilter === 'all' || acc.status === statusFilter;
    
    return matchesSearch && matchesStatus;
  });

  // Split accounts into active and unavailable
  const activeAccounts = filteredAccounts.filter(
    a => !['banned', 'restricted'].includes(a.status)
  );
  const unavailableAccounts = filteredAccounts.filter(
    a => ['banned', 'restricted'].includes(a.status)
  );

  const removeSessionFile = (index: number) => {
    setSessionFiles(prev => prev.filter((_, i) => i !== index));
  };

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
    if (selectedIds.size === filteredAccounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredAccounts.map(a => a.id)));
    }
  };

  const isAllSelected = filteredAccounts.length > 0 && selectedIds.size === filteredAccounts.length;

  const getProxyLabel = (proxyId?: string) => {
    if (!proxyId) return null;
    const proxy = proxies.find(p => p.id === proxyId);
    return proxy ? `${proxy.host}:${proxy.port}` : null;
  };
  
  const getProxyStatus = (proxyId?: string) => {
    if (!proxyId) return null;
    const proxy = proxies.find(p => p.id === proxyId);
    return proxy?.status || null;
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Telegram Accounts"
        description="Upload session files and manage your accounts"
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
                <DialogDescription>
                  Select one or multiple .session files to upload
                </DialogDescription>
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
                      Select multiple files at once
                    </p>
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

      {/* Bulk Actions Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 mb-4 p-4 rounded-lg bg-primary/10 border border-primary/30 animate-fade-in flex-wrap">
          <span className="text-sm font-medium">
            {selectedIds.size} account{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex-1" />
          
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkCheck}
            disabled={isBulkChecking}
            className="gap-2"
          >
            {isBulkChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            Verify
          </Button>
          
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportSessions}
            disabled={isExporting}
            className="gap-2"
          >
            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Export Sessions
          </Button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <MoreVertical className="w-4 h-4" />
                Bulk Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setIsBulkNameOpen(true)}>
                <UserCircle className="w-4 h-4 mr-2" />
                Change Names
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsBulkPhotoOpen(true)}>
                <Image className="w-4 h-4 mr-2" />
                Change Photos
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsGroupDialogOpen(true)}>
                <Users className="w-4 h-4 mr-2" />
                Create Group
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsBulkProxyOpen(true)}>
                <Globe className="w-4 h-4 mr-2" />
                Assign Proxy
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSpamBotCheck} disabled={isSpamBotChecking}>
                <Shield className="w-4 h-4 mr-2" />
                Check SpamBot
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={handleBulkDelete}>
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Selected
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedIds(new Set());
              setVerifyResults(new Map());
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      
      {/* SpamBot Check Progress */}
      {isSpamBotChecking && (
        <div className="mb-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 animate-fade-in">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-yellow-500" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                SpamBot Check: {spamBotProgress.completed}/{spamBotProgress.total} accounts checked
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Run the Python script to process the check queue
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsSpamBotChecking(false)}
            >
              Dismiss
            </Button>
          </div>
          {spamBotProgress.completed > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {Array.from(spamBotProgress.results.entries()).map(([accountId, result]) => {
                const account = accounts.find(a => a.id === accountId);
                const isCompleted = result.status === 'completed';
                const isFailed = result.status === 'failed';
                return (
                  <Badge 
                    key={accountId} 
                    variant="outline"
                    className={cn(
                      "text-xs",
                      isCompleted && result.result?.toLowerCase().includes('no limit') && "bg-green-500/20 text-green-600 border-green-500/30",
                      isCompleted && result.result?.toLowerCase().includes('restricted') && "bg-yellow-500/20 text-yellow-600 border-yellow-500/30",
                      isCompleted && result.result?.toLowerCase().includes('banned') && "bg-destructive/20 text-destructive border-destructive/30",
                      isFailed && "bg-muted text-muted-foreground"
                    )}
                  >
                    {account?.phoneNumber || accountId.slice(0, 8)}
                    {isCompleted && result.result?.toLowerCase().includes('no limit') && <CheckCircle className="w-3 h-3 ml-1" />}
                    {isCompleted && result.result?.toLowerCase().includes('restricted') && <AlertTriangle className="w-3 h-3 ml-1" />}
                    {isCompleted && result.result?.toLowerCase().includes('banned') && <XCircle className="w-3 h-3 ml-1" />}
                    {isFailed && <XCircle className="w-3 h-3 ml-1" />}
                  </Badge>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Bulk Name Change Dialog */}
      <Dialog open={isBulkNameOpen} onOpenChange={setIsBulkNameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk Change Names</DialogTitle>
            <DialogDescription>
              Enter names separated by commas or new lines. Names will be assigned to accounts in order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <Textarea
              placeholder="John Doe, Jane Smith, Bob Wilson&#10;or&#10;John Doe&#10;Jane Smith"
              value={bulkNames}
              onChange={(e) => setBulkNames(e.target.value)}
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              {bulkNames.split(/[,\n]/).filter(n => n.trim()).length} name(s) for {selectedIds.size} account(s)
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsBulkNameOpen(false)}>Cancel</Button>
              <Button onClick={handleBulkNameChange}>Apply Names</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Photo Change Dialog */}
      <Dialog open={isBulkPhotoOpen} onOpenChange={setIsBulkPhotoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk Change Profile Photos</DialogTitle>
            <DialogDescription>
              This feature requires the Python script to update profile photos on Telegram.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="p-4 rounded-lg bg-accent/50 border">
              <p className="text-sm">
                To change profile photos, upload photos to the sender script's photo folder and run:
              </p>
              <pre className="mt-2 p-2 bg-card rounded text-xs font-mono">
                python sender.py --update-photos
              </pre>
            </div>
            <Button variant="outline" className="w-full" onClick={() => setIsBulkPhotoOpen(false)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Group Dialog */}
      <Dialog open={isGroupDialogOpen} onOpenChange={setIsGroupDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Account Group</DialogTitle>
            <DialogDescription>
              Create a group with the {selectedIds.size} selected account(s)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Group Name</Label>
              <Input
                placeholder="Enter group name"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsGroupDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
                Create Group
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Proxy Assignment Dialog */}
      <Dialog open={isBulkProxyOpen} onOpenChange={setIsBulkProxyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Proxy to {selectedIds.size} Account(s)</DialogTitle>
            <DialogDescription>
              Select a proxy and how many accounts each proxy should handle
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Select Proxy</Label>
              <Select value={selectedProxyId} onValueChange={setSelectedProxyId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a proxy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    <span className="flex items-center gap-2">
                      <Globe className="w-4 h-4" />
                      Auto-assign (rotate proxies)
                    </span>
                  </SelectItem>
                  {proxies.filter(p => p.status === 'active').map(proxy => (
                    <SelectItem key={proxy.id} value={proxy.id}>
                      <span className="flex items-center gap-2">
                        <Link2 className="w-4 h-4" />
                        {proxy.host}:{proxy.port}
                        {proxy.country && <span className="text-muted-foreground">({proxy.country})</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label>Accounts per Proxy</Label>
              <RadioGroup value={proxyRatio} onValueChange={(v) => setProxyRatio(v as '1' | '2' | '3')}>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="1" id="ratio1" />
                  <Label htmlFor="ratio1" className="cursor-pointer">1 proxy : 1 account</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="2" id="ratio2" />
                  <Label htmlFor="ratio2" className="cursor-pointer">1 proxy : 2 accounts</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="3" id="ratio3" />
                  <Label htmlFor="ratio3" className="cursor-pointer">1 proxy : 3 accounts</Label>
                </div>
              </RadioGroup>
            </div>
            
            <div className="p-3 rounded-lg bg-accent/50 border text-sm">
              <p className="text-muted-foreground">
                {selectedProxyId === 'auto' 
                  ? `Will assign ${Math.ceil(selectedIds.size / parseInt(proxyRatio))} proxy(s) to ${selectedIds.size} account(s)`
                  : `Will assign the selected proxy to all ${selectedIds.size} account(s)`
                }
              </p>
            </div>
            
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsBulkProxyOpen(false)}>Cancel</Button>
              <Button 
                onClick={handleBulkProxyAssign} 
                disabled={!selectedProxyId || isBulkProxyAssigning}
              >
                {isBulkProxyAssigning ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Assigning...
                  </>
                ) : (
                  <>
                    <Globe className="w-4 h-4 mr-2" />
                    Assign Proxy
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Filters */}
      <div className="flex gap-4 mb-6 flex-wrap">
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
        {groups.length > 0 && (
          <Select value={selectedGroup} onValueChange={setSelectedGroup}>
            <SelectTrigger className="w-40">
              <Users className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Accounts</SelectItem>
              {groups.map(g => (
                <SelectItem key={g.id} value={g.id}>{g.name} ({g.accountIds.length})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="outline" onClick={() => refreshData()} className="gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        {statusOptions.map(opt => (
          <Card 
            key={opt.value} 
            className={cn(
              "hover:border-primary/30 transition-colors cursor-pointer",
              statusFilter === opt.value && "border-primary/50"
            )} 
            onClick={() => setStatusFilter(statusFilter === opt.value ? 'all' : opt.value)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{opt.label}</span>
                <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border", opt.color)}>
                  {accounts.filter(a => a.status === opt.value).length}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

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
        <div className="space-y-2">
          {/* Select All Header */}
          <div className="flex items-center gap-4 px-4 py-2 bg-secondary/50 rounded-lg">
            <Checkbox
              checked={isAllSelected}
              onCheckedChange={toggleSelectAll}
              aria-label="Select all"
            />
            <span className="text-sm text-muted-foreground">
              {isAllSelected ? 'Deselect all' : 'Select all'} ({filteredAccounts.length} accounts)
            </span>
          </div>

          {/* Account Cards */}
          {filteredAccounts.map((account) => {
            const verifyResult = verifyResults.get(account.id);
            const proxyLabel = getProxyLabel(account.proxyId);
            const proxyStatus = getProxyStatus(account.proxyId);
            const msgSent24h = messagesSentLast24h.get(account.id) || 0;
            
            return (
              <Card 
                key={account.id} 
                className={cn(
                  "hover:border-primary/20 transition-colors",
                  selectedIds.has(account.id) && "border-primary/50 bg-primary/5"
                )}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {/* Checkbox */}
                    <Checkbox
                      checked={selectedIds.has(account.id)}
                      onCheckedChange={() => toggleSelect(account.id)}
                      aria-label={`Select ${account.phoneNumber}`}
                    />

                    {/* Avatar */}
                    <div className="relative w-12 h-12 flex-shrink-0">
                      {account.avatar ? (
                        <img 
                          src={account.avatar} 
                          alt={account.firstName || account.phoneNumber}
                          className="w-12 h-12 rounded-full object-cover"
                        />
                      ) : (
                        <div className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center",
                          verifyResult?.status === 'active' && "bg-green-500/20",
                          verifyResult?.status === 'disconnected' && "bg-destructive/20",
                          verifyResult?.status === 'banned' && "bg-destructive/20",
                          verifyResult?.status === 'checking' && "bg-primary/20",
                          !verifyResult && account.status === 'active' && "bg-green-500/10",
                          !verifyResult && account.status === 'banned' && "bg-destructive/10",
                          !verifyResult && account.status !== 'active' && account.status !== 'banned' && "bg-primary/10"
                        )}>
                          {verifyResult?.status === 'checking' ? (
                            <Loader2 className="w-5 h-5 text-primary animate-spin" />
                          ) : account.firstName ? (
                            <span className="text-lg font-medium text-primary">
                              {account.firstName.charAt(0).toUpperCase()}
                            </span>
                          ) : (
                            <Phone className="w-5 h-5 text-primary" />
                          )}
                        </div>
                      )}
                      {/* Online/Offline Status */}
                      {account.status === 'active' && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-green-500 rounded-full border-2 border-card flex items-center justify-center">
                          <Wifi className="w-2 h-2 text-white" />
                        </div>
                      )}
                      {account.status === 'disconnected' && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-muted-foreground rounded-full border-2 border-card flex items-center justify-center">
                          <WifiOff className="w-2 h-2 text-white" />
                        </div>
                      )}
                      {(account.status === 'banned' || account.status === 'restricted') && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-destructive rounded-full border-2 border-card flex items-center justify-center">
                          <AlertTriangle className="w-2 h-2 text-white" />
                        </div>
                      )}
                    </div>
                    
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{account.phoneNumber}</span>
                        {getStatusBadge(account.status)}
                        {verifyResult?.status === 'active' && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-600 border border-green-500/30">
                            Verified
                          </span>
                        )}
                        {account.status === 'restricted' && account.restrictedUntil && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-600 border border-yellow-500/30 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {getRestrictionTimeLeft(account.restrictedUntil)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1 flex-wrap">
                        {account.firstName && (
                          <span>{account.firstName} {account.lastName || ''}</span>
                        )}
                        {account.username && !account.username.includes('update_state') && (
                          <span>@{account.username}</span>
                        )}
                        {proxyLabel && (
                          <span className={cn(
                            "flex items-center gap-1 text-xs px-1.5 py-0.5 rounded",
                            proxyStatus === 'active' ? "bg-green-500/10 text-green-600" : 
                            proxyStatus === 'error' ? "bg-destructive/10 text-destructive" : "bg-muted"
                          )}>
                            <Globe className="w-3 h-3" />
                            {proxyLabel}
                            {proxyStatus === 'active' && <Check className="w-3 h-3" />}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="hidden md:flex items-center gap-6 text-sm">
                      <div className="text-center">
                        <div className="font-medium flex items-center gap-1">
                          <MessageSquare className="w-3 h-3 text-muted-foreground" />
                          {msgSent24h}
                        </div>
                        <div className="text-xs text-muted-foreground">24h Sent</div>
                      </div>
                      <div className="text-center">
                        <div className="font-medium">{account.dailyLimit || 25}</div>
                        <div className="text-xs text-muted-foreground">Limit</div>
                      </div>
                      <div className="text-center">
                        <div className="font-medium flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-muted-foreground" />
                          {getAccountAge(account.createdAt)}d
                        </div>
                        <div className="text-xs text-muted-foreground">Added</div>
                      </div>
                    </div>

                    {/* Proxy Select */}
                    <Select
                      value={account.proxyId || 'none'}
                      onValueChange={(value) => handleProxyChange(account.id, value === 'none' ? null : value)}
                    >
                      <SelectTrigger className="w-36 h-8">
                        <Globe className="w-3 h-3 mr-1" />
                        <SelectValue placeholder="Proxy" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          <span className="flex items-center gap-1">
                            <Unlink className="w-3 h-3" /> No Proxy
                          </span>
                        </SelectItem>
                        {proxies.filter(p => p.status === 'active').map(proxy => (
                          <SelectItem key={proxy.id} value={proxy.id}>
                            <span className="flex items-center gap-1">
                              <Link2 className="w-3 h-3" />
                              {proxy.host}:{proxy.port}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Delete */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteAccount(account.id)}
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

export default Accounts;
