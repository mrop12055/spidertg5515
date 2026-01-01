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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuPortal } from '@/components/ui/dropdown-menu';
import { 
  Plus, Upload, Trash2, Phone, FileText, 
  CheckCircle, XCircle, Loader2, Search, Filter, RefreshCw, 
  Check, Shield, Globe, Link2, Unlink, Download, MoreVertical,
  Eye, EyeOff, Image, UserCircle, Users, Wifi, WifiOff, AlertTriangle,
  Clock, MessageSquare, ChevronDown, ChevronRight, Calendar, Lock, 
  LogOut, PhoneOff, Settings, FolderPlus, Layers, Smartphone
} from 'lucide-react';
import { TelegramAccount, AccountStatus } from '@/types/telegram';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useDropzone } from 'react-dropzone';
import { cn } from '@/lib/utils';
import JSZip from 'jszip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { differenceInHours, differenceInDays } from 'date-fns';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';

const statusOptions: { value: AccountStatus; label: string; color: string; icon: React.ReactNode }[] = [
  { value: 'active', label: 'Active', color: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30', icon: <Wifi className="w-3 h-3" /> },
  { value: 'banned', label: 'Banned', color: 'bg-red-500/15 text-red-600 border-red-500/30', icon: <XCircle className="w-3 h-3" /> },
  { value: 'restricted', label: 'Restricted', color: 'bg-amber-500/15 text-amber-600 border-amber-500/30', icon: <AlertTriangle className="w-3 h-3" /> },
  { value: 'disconnected', label: 'Disconnected', color: 'bg-slate-500/15 text-slate-500 border-slate-500/30', icon: <WifiOff className="w-3 h-3" /> },
  { value: 'cooldown', label: 'Cooldown', color: 'bg-purple-500/15 text-purple-600 border-purple-500/30', icon: <Clock className="w-3 h-3" /> },
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
  color: string;
}

const GROUP_COLORS = [
  'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-orange-500', 
  'bg-pink-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500'
];

const Accounts: React.FC = () => {
  const { accounts, proxies, refreshData, isLoading } = useTelegram();
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
  const [isExporting, setIsExporting] = useState(false);
  const [isGroupDialogOpen, setIsGroupDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupSize, setNewGroupSize] = useState<string>('10');
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  
  // Privacy settings dialog
  const [isPrivacyDialogOpen, setIsPrivacyDialogOpen] = useState(false);
  const [privacySettings, setPrivacySettings] = useState({
    hidePhone: false,
    hideLastSeen: false,
    disableCalls: false,
  });
  
  // Password dialog
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [existingPassword, setExistingPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  // Bulk proxy assignment
  const [isBulkProxyOpen, setIsBulkProxyOpen] = useState(false);
  const [selectedProxyId, setSelectedProxyId] = useState<string>('');
  const [proxyRatio, setProxyRatio] = useState<'1' | '2' | '3'>('1');
  const [isBulkProxyAssigning, setIsBulkProxyAssigning] = useState(false);
  
  // Active tab for account sections
  const [activeTab, setActiveTab] = useState<'active' | 'banned' | 'restricted' | 'cooldown' | 'disconnected'>('active');
  
  // SpamBot check state
  const [isSpamBotChecking, setIsSpamBotChecking] = useState(false);
  const [spamBotProgress, setSpamBotProgress] = useState<{ total: number; completed: number; results: Map<string, { status: string; result?: string }> }>({ total: 0, completed: 0, results: new Map() });
  
  // Messages sent today tracking
  const [messagesSentLast24h, setMessagesSentLast24h] = useState<Map<string, number>>(new Map());

  // Processing tasks state
  const [processingTasks, setProcessingTasks] = useState<Map<string, string>>(new Map());
  
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

    return () => {
      supabase.removeChannel(channel);
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
          if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'skipped')) {
            setSpamBotProgress(prev => {
              const newResults = new Map(prev.results);
              newResults.set(task.account_id, { status: task.status, result: task.result });
              const processed = Array.from(newResults.values()).filter(r => 
                r.status === 'completed' || r.status === 'failed' || r.status === 'skipped'
              ).length;
              
              if (processed >= prev.total) {
                const results = Array.from(newResults.values());
                const successCount = results.filter(r => r.status === 'completed').length;
                const failedCount = results.filter(r => r.status === 'failed').length;
                const skippedCount = results.filter(r => r.status === 'skipped').length;
                
                setIsSpamBotChecking(false);
                toast.success(`SpamBot check: ${successCount} OK, ${failedCount} failed, ${skippedCount} skipped`);
                refreshData();
              }
              
              return { ...prev, completed: processed, results: newResults };
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
    toast.success(`${processedFiles.length} file(s) ready`);
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
        toast.success(`Uploaded ${data.successful} account(s) - verifying...`);
        
        // Auto-verify after upload
        if (data.account_ids && data.account_ids.length > 0) {
          setTimeout(async () => {
            try {
              const { data: verifyData } = await supabase.functions.invoke('verify-sessions', {
                body: { account_ids: data.account_ids }
              });
              if (verifyData?.summary) {
                toast.success(`Verified: ${verifyData.summary.valid || 0} active, ${verifyData.summary.invalid || 0} invalid`);
              }
              refreshData();
            } catch (e) {
              console.error('Auto-verify error:', e);
            }
          }, 1000);
        }
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

  // Bulk name change - creates tasks for Python to process
  const handleBulkNameChange = async () => {
    if (selectedIds.size === 0 || !bulkNames.trim()) return;
    
    const names = bulkNames.split(/[,\n]/).map(n => n.trim()).filter(n => n);
    const selectedAccountIds = Array.from(selectedIds);
    
    try {
      // Create tasks for Python script to change names on Telegram
      const tasks = selectedAccountIds.map((accountId, i) => {
        const name = names[i % names.length] || names[0];
        const parts = name.split(' ');
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';
        
        return {
          account_id: accountId,
          task_type: 'change_name',
          status: 'pending',
          result: JSON.stringify({ first_name: firstName, last_name: lastName }),
        };
      });
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      toast.success(`Queued name change for ${selectedAccountIds.length} account(s). Run Python script to process.`);
      setBulkNames('');
      setIsBulkNameOpen(false);
    } catch (error) {
      console.error('Error queuing name change:', error);
      toast.error('Failed to queue name change');
    }
  };

  // Queue privacy settings task
  const handleApplyPrivacySettings = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      const tasks = Array.from(selectedIds).map(accountId => ({
        account_id: accountId,
        task_type: 'privacy_settings',
        status: 'pending',
        result: JSON.stringify(privacySettings),
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      toast.success(`Queued privacy settings for ${selectedIds.size} account(s). Run Python script to apply.`);
      setIsPrivacyDialogOpen(false);
    } catch (error) {
      console.error('Error queuing privacy settings:', error);
      toast.error('Failed to queue privacy settings');
    }
  };

  // Queue cloud password task
  const handleChangeCloudPassword = async () => {
    if (selectedIds.size === 0) return;
    
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    
    if (newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    
    try {
      const tasks = Array.from(selectedIds).map(accountId => ({
        account_id: accountId,
        task_type: 'change_password',
        status: 'pending',
        result: JSON.stringify({ 
          existing_password: existingPassword || null, 
          new_password: newPassword 
        }),
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      toast.success(`Queued password change for ${selectedIds.size} account(s). Run Python script to apply.`);
      setIsPasswordDialogOpen(false);
      setExistingPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      console.error('Error queuing password change:', error);
      toast.error('Failed to queue password change');
    }
  };

  // Queue logout other sessions task
  const handleLogoutOtherSessions = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      const tasks = Array.from(selectedIds).map(accountId => ({
        account_id: accountId,
        task_type: 'logout_sessions',
        status: 'pending',
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      toast.success(`Queued logout for ${selectedIds.size} account(s). Run Python script to process.`);
    } catch (error) {
      console.error('Error queuing logout:', error);
      toast.error('Failed to queue logout');
    }
  };

  // Create groups from selected accounts with specified size
  const handleCreateGroups = () => {
    if (selectedIds.size === 0 || !newGroupName.trim()) return;
    
    const groupSize = parseInt(newGroupSize) || 10;
    const accountIds = Array.from(selectedIds);
    const newGroups: AccountGroup[] = [];
    
    for (let i = 0; i < accountIds.length; i += groupSize) {
      const chunk = accountIds.slice(i, i + groupSize);
      const groupNum = Math.floor(i / groupSize) + 1;
      newGroups.push({
        id: `group_${Date.now()}_${groupNum}`,
        name: `${newGroupName} ${groupNum}`,
        accountIds: chunk,
        color: GROUP_COLORS[(groupNum - 1) % GROUP_COLORS.length],
      });
    }
    
    setGroups(prev => [...prev, ...newGroups]);
    setNewGroupName('');
    setIsGroupDialogOpen(false);
    toast.success(`Created ${newGroups.length} group(s) with ${groupSize} accounts each`);
  };

  // Bulk proxy assignment
  const handleBulkProxyAssign = async () => {
    if (selectedIds.size === 0 || !selectedProxyId) return;
    
    setIsBulkProxyAssigning(true);
    try {
      const selectedAccountIds = Array.from(selectedIds);
      const ratio = parseInt(proxyRatio);
      
      const activeProxies = proxies.filter(p => p.status === 'active');
      
      if (activeProxies.length === 0) {
        toast.error('No active proxies available');
        return;
      }
      
      if (selectedProxyId !== 'auto') {
        for (const accountId of selectedAccountIds) {
          await supabase
            .from('telegram_accounts')
            .update({ proxy_id: selectedProxyId })
            .eq('id', accountId);
        }
        toast.success(`Assigned proxy to ${selectedAccountIds.length} account(s)`);
      } else {
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
        toast.success(`Auto-assigned ${Math.min(proxyIndex + 1, activeProxies.length)} proxy(s) to ${selectedAccountIds.length} account(s)`);
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
      return `${days}d ${hours % 24}h`;
    }
    return `${hours}h ${minutes}m`;
  };

  // Get account age in days
  const getAccountAge = (createdAt: Date) => {
    return differenceInDays(new Date(), createdAt);
  };

  // SpamBot check
  const handleSpamBotCheck = async () => {
    if (selectedIds.size === 0) return;
    
    const now = new Date();
    const cooldownHours = 96;
    
    const { data: accountsData, error: fetchError } = await supabase
      .from('telegram_accounts')
      .select('id, last_spambot_check, phone_number')
      .in('id', Array.from(selectedIds));
    
    if (fetchError) {
      toast.error('Failed to fetch account data');
      return;
    }
    
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
        eligibleIds.push(acc.id);
      }
    });
    
    if (skippedIds.length > 0 && eligibleIds.length === 0) {
      toast.warning(`All ${skippedIds.length} account(s) checked within 96h`);
      return;
    }
    
    if (skippedIds.length > 0) {
      toast.info(`${skippedIds.length} skipped (96h cooldown), ${eligibleIds.length} queued`);
    }
    
    if (eligibleIds.length === 0) return;
    
    setIsSpamBotChecking(true);
    setSpamBotProgress({ total: eligibleIds.length, completed: 0, results: new Map() });
    
    try {
      const tasks = eligibleIds.map(accountId => ({
        account_id: accountId,
        task_type: 'spambot_check',
        status: 'pending',
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      toast.success(`Queued ${eligibleIds.length} account(s) for SpamBot check`);
    } catch (error) {
      console.error('Error queuing SpamBot check:', error);
      toast.error('Failed to queue SpamBot check');
      setIsSpamBotChecking(false);
    }
  };

  // Real session verification
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
      <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border", option?.color || 'bg-muted')}>
        {option?.icon}
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

  // Split accounts by status
  const accountsByStatus = {
    active: filteredAccounts.filter(a => a.status === 'active'),
    banned: filteredAccounts.filter(a => a.status === 'banned'),
    restricted: filteredAccounts.filter(a => a.status === 'restricted'),
    cooldown: filteredAccounts.filter(a => a.status === 'cooldown'),
    disconnected: filteredAccounts.filter(a => a.status === 'disconnected'),
  };

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
    const currentTabAccounts = accountsByStatus[activeTab];
    const allSelected = currentTabAccounts.every(a => selectedIds.has(a.id));
    
    if (allSelected) {
      const newSelected = new Set(selectedIds);
      currentTabAccounts.forEach(a => newSelected.delete(a.id));
      setSelectedIds(newSelected);
    } else {
      const newSelected = new Set(selectedIds);
      currentTabAccounts.forEach(a => newSelected.add(a.id));
      setSelectedIds(newSelected);
    }
  };

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

  // Calculate stats
  const stats = {
    total: accounts.length,
    active: accounts.filter(a => a.status === 'active').length,
    banned: accounts.filter(a => a.status === 'banned').length,
    restricted: accounts.filter(a => a.status === 'restricted').length,
    cooldown: accounts.filter(a => a.status === 'cooldown').length,
    disconnected: accounts.filter(a => a.status === 'disconnected').length,
  };

  const renderAccountCard = (account: TelegramAccount) => {
    const verifyResult = verifyResults.get(account.id);
    const proxyLabel = getProxyLabel(account.proxyId);
    const proxyStatus = getProxyStatus(account.proxyId);
    const msgSent24h = messagesSentLast24h.get(account.id) || 0;
    const accountGroup = groups.find(g => g.accountIds.includes(account.id));
    
    return (
      <div 
        key={account.id} 
        className={cn(
          "group flex items-center gap-3 p-3 rounded-lg border bg-card/50 hover:bg-card transition-all",
          selectedIds.has(account.id) && "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
        )}
      >
        {/* Checkbox */}
        <Checkbox
          checked={selectedIds.has(account.id)}
          onCheckedChange={() => toggleSelect(account.id)}
          className="flex-shrink-0"
        />

        {/* Avatar */}
        <div className="relative w-10 h-10 flex-shrink-0">
          {account.avatar ? (
            <img 
              src={account.avatar} 
              alt={account.firstName || account.phoneNumber}
              className="w-10 h-10 rounded-full object-cover"
            />
          ) : (
            <div className={cn(
              "w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium",
              account.status === 'active' && "bg-emerald-500/15 text-emerald-600",
              account.status === 'banned' && "bg-red-500/15 text-red-600",
              account.status === 'restricted' && "bg-amber-500/15 text-amber-600",
              account.status === 'cooldown' && "bg-purple-500/15 text-purple-600",
              account.status === 'disconnected' && "bg-slate-500/15 text-slate-500",
            )}>
              {verifyResult?.status === 'checking' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : account.firstName ? (
                account.firstName.charAt(0).toUpperCase()
              ) : (
                <Phone className="w-4 h-4" />
              )}
            </div>
          )}
          
          {/* Status indicator */}
          <div className={cn(
            "absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-card flex items-center justify-center",
            account.status === 'active' && "bg-emerald-500",
            account.status === 'banned' && "bg-red-500",
            account.status === 'restricted' && "bg-amber-500",
            account.status === 'cooldown' && "bg-purple-500",
            account.status === 'disconnected' && "bg-slate-400",
          )}>
            {account.status === 'active' && <Check className="w-2 h-2 text-white" />}
            {account.status === 'banned' && <XCircle className="w-2 h-2 text-white" />}
            {account.status === 'restricted' && <AlertTriangle className="w-2 h-2 text-white" />}
          </div>
        </div>
        
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{account.phoneNumber}</span>
            {accountGroup && (
              <span className={cn("w-2 h-2 rounded-full", accountGroup.color)} title={accountGroup.name} />
            )}
            {verifyResult?.status === 'active' && (
              <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
            {account.firstName && (
              <span>{account.firstName} {account.lastName || ''}</span>
            )}
            {account.username && !account.username.includes('update_state') && (
              <span className="text-primary/70">@{account.username}</span>
            )}
            {account.status === 'restricted' && account.restrictedUntil && (
              <span className="text-amber-600 flex items-center gap-0.5">
                <Clock className="w-3 h-3" />
                {getRestrictionTimeLeft(account.restrictedUntil)}
              </span>
            )}
          </div>
        </div>

        {/* Stats - desktop */}
        <div className="hidden lg:flex items-center gap-4 text-xs">
          <div className="text-center min-w-[40px]">
            <div className="font-medium text-foreground">{msgSent24h}/{account.dailyLimit || 10}</div>
            <div className="text-muted-foreground">24h</div>
          </div>
          <div className="text-center min-w-[40px]">
            <div className="font-medium text-foreground">{getAccountAge(account.createdAt)}d</div>
            <div className="text-muted-foreground">Age</div>
          </div>
          {/* Device Fingerprint */}
          {account.deviceModel && (
            <div 
              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-500/10 text-blue-600 cursor-help"
              title={`${account.deviceModel} | ${account.systemVersion} | v${account.appVersion} | ${account.langCode}`}
            >
              <Smartphone className="w-3 h-3" />
              <span className="max-w-[100px] truncate">{account.deviceModel?.split(' ')[0]}</span>
            </div>
          )}
          {proxyLabel && (
            <div className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs",
              proxyStatus === 'active' ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
            )}>
              <Globe className="w-3 h-3" />
              <span className="max-w-[80px] truncate">{proxyLabel}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => handleDeleteAccount(account.id)} className="text-destructive">
              <Trash2 className="w-4 h-4 mr-2" />
              Delete Account
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Accounts</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Manage your {stats.total} Telegram accounts
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={refreshData} disabled={isLoading} size="sm" className="gap-2">
              <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
              Refresh
            </Button>
            <Dialog open={isAddOpen} onOpenChange={(open) => {
              setIsAddOpen(open);
              if (!open) {
                setSessionFiles([]);
                setUploadResults(null);
              }
            }}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-2">
                  <Plus className="w-4 h-4" />
                  Add Accounts
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Upload Session Files</DialogTitle>
                  <DialogDescription>
                    Drop .session files to add accounts (supports bulk upload)
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  <div
                    {...getRootProps()}
                    className={cn(
                      "relative border-2 border-dashed rounded-xl p-6 transition-all cursor-pointer",
                      "hover:border-primary/50 hover:bg-primary/5",
                      isDragActive && "border-primary bg-primary/10",
                      isUploading && "pointer-events-none opacity-60"
                    )}
                  >
                    <input {...getInputProps()} />
                    <div className="flex flex-col items-center text-center">
                      <Upload className={cn("w-10 h-10 mb-3", isDragActive ? "text-primary" : "text-muted-foreground")} />
                      <p className="font-medium">{isDragActive ? 'Drop files here' : 'Drop .session files'}</p>
                      <p className="text-sm text-muted-foreground">or click to browse</p>
                    </div>
                  </div>

                  {sessionFiles.length > 0 && (
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {sessionFiles.slice(0, 5).map((sf, i) => (
                        <div key={i} className="flex items-center gap-2 p-2 rounded bg-muted/50 text-sm">
                          <FileText className="w-4 h-4 text-primary flex-shrink-0" />
                          <span className="flex-1 truncate">{sf.phoneNumber}</span>
                          <Button variant="ghost" size="sm" onClick={() => removeSessionFile(i)} className="h-6 w-6 p-0">
                            <XCircle className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                      {sessionFiles.length > 5 && (
                        <p className="text-xs text-muted-foreground text-center">
                          +{sessionFiles.length - 5} more files
                        </p>
                      )}
                    </div>
                  )}

                  {uploadResults && (
                    <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/50 text-sm">
                      <span className="flex items-center gap-1 text-emerald-600">
                        <CheckCircle className="w-4 h-4" /> {uploadResults.successful} uploaded
                      </span>
                      {uploadResults.failed > 0 && (
                        <span className="flex items-center gap-1 text-destructive">
                          <XCircle className="w-4 h-4" /> {uploadResults.failed} failed
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                    <Button onClick={handleUploadSessions} disabled={isUploading || sessionFiles.length === 0}>
                      {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                      Upload {sessionFiles.length} Account{sessionFiles.length !== 1 ? 's' : ''}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card className="cursor-pointer hover:border-primary/30 transition-colors" onClick={() => setStatusFilter('all')}>
            <CardContent className="p-3">
              <div className="text-2xl font-bold">{stats.total}</div>
              <div className="text-xs text-muted-foreground">Total</div>
            </CardContent>
          </Card>
          {statusOptions.map(opt => (
            <Card 
              key={opt.value} 
              className={cn(
                "cursor-pointer hover:border-primary/30 transition-colors",
                statusFilter === opt.value && "border-primary"
              )}
              onClick={() => setStatusFilter(statusFilter === opt.value ? 'all' : opt.value)}
            >
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="text-2xl font-bold">{stats[opt.value as keyof typeof stats]}</div>
                  <span className={cn("p-1.5 rounded-md", opt.color)}>{opt.icon}</span>
                </div>
                <div className="text-xs text-muted-foreground">{opt.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Bulk Actions Bar */}
        {selectedIds.size > 0 && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge variant="secondary" className="font-medium">
                  {selectedIds.size} selected
                </Badge>
                
                <Separator orientation="vertical" className="h-6" />
                
                <Button variant="outline" size="sm" onClick={handleBulkCheck} disabled={isBulkChecking} className="gap-1.5">
                  {isBulkChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
                  Verify
                </Button>
                
                <Button variant="outline" size="sm" onClick={handleSpamBotCheck} disabled={isSpamBotChecking} className="gap-1.5">
                  <Shield className="w-3.5 h-3.5" />
                  SpamBot
                </Button>
                
                <Button variant="outline" size="sm" onClick={handleExportSessions} disabled={isExporting} className="gap-1.5">
                  {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  Export
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <Settings className="w-3.5 h-3.5" />
                      Actions
                      <ChevronDown className="w-3 h-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-52">
                    <DropdownMenuItem onClick={() => setIsBulkNameOpen(true)}>
                      <UserCircle className="w-4 h-4 mr-2" />
                      Change Name
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setIsPrivacyDialogOpen(true)}>
                      <EyeOff className="w-4 h-4 mr-2" />
                      Privacy Settings
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setIsPasswordDialogOpen(true)}>
                      <Lock className="w-4 h-4 mr-2" />
                      Change Password
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleLogoutOtherSessions}>
                      <LogOut className="w-4 h-4 mr-2" />
                      Logout Other Sessions
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setIsGroupDialogOpen(true)}>
                      <FolderPlus className="w-4 h-4 mr-2" />
                      Create Groups
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setIsBulkProxyOpen(true)}>
                      <Globe className="w-4 h-4 mr-2" />
                      Assign Proxy
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleBulkDelete} className="text-destructive">
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete Selected
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="flex-1" />
                
                <Button variant="ghost" size="sm" onClick={() => { setSelectedIds(new Set()); setVerifyResults(new Map()); }}>
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* SpamBot Progress */}
        {isSpamBotChecking && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="p-3">
              <div className="flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium">SpamBot Check</span>
                    <span className="text-xs text-muted-foreground">{spamBotProgress.completed}/{spamBotProgress.total}</span>
                  </div>
                  <Progress value={(spamBotProgress.completed / spamBotProgress.total) * 100} className="h-1.5" />
                </div>
                <Button variant="ghost" size="sm" onClick={() => setIsSpamBotChecking(false)}>
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search accounts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          {groups.length > 0 && (
            <Select value={selectedGroup} onValueChange={setSelectedGroup}>
              <SelectTrigger className="w-40 h-9">
                <Layers className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Group" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Accounts</SelectItem>
                {groups.map(g => (
                  <SelectItem key={g.id} value={g.id}>
                    <span className="flex items-center gap-2">
                      <span className={cn("w-2 h-2 rounded-full", g.color)} />
                      {g.name} ({g.accountIds.length})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Account Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="active" className="gap-1.5">
              <Wifi className="w-3.5 h-3.5" />
              Active ({accountsByStatus.active.length})
            </TabsTrigger>
            <TabsTrigger value="banned" className="gap-1.5">
              <XCircle className="w-3.5 h-3.5" />
              Banned ({accountsByStatus.banned.length})
            </TabsTrigger>
            <TabsTrigger value="restricted" className="gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              Restricted ({accountsByStatus.restricted.length})
            </TabsTrigger>
            <TabsTrigger value="cooldown" className="gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Cooldown ({accountsByStatus.cooldown.length})
            </TabsTrigger>
            <TabsTrigger value="disconnected" className="gap-1.5">
              <WifiOff className="w-3.5 h-3.5" />
              Offline ({accountsByStatus.disconnected.length})
            </TabsTrigger>
          </TabsList>

          {(['active', 'banned', 'restricted', 'cooldown', 'disconnected'] as const).map(status => (
            <TabsContent key={status} value={status} className="mt-4">
              {accountsByStatus[status].length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center">
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                      {statusOptions.find(o => o.value === status)?.icon}
                    </div>
                    <p className="text-muted-foreground">No {status} accounts</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {/* Select All */}
                  <div className="flex items-center gap-3 px-3 py-2 bg-muted/30 rounded-lg">
                    <Checkbox
                      checked={accountsByStatus[status].every(a => selectedIds.has(a.id))}
                      onCheckedChange={toggleSelectAll}
                    />
                    <span className="text-sm text-muted-foreground">
                      Select all {accountsByStatus[status].length} accounts
                    </span>
                  </div>
                  
                  {/* Account List */}
                  {accountsByStatus[status].map(renderAccountCard)}
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>

        {/* Dialogs */}
        
        {/* Bulk Name Change Dialog */}
        <Dialog open={isBulkNameOpen} onOpenChange={setIsBulkNameOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change Names</DialogTitle>
              <DialogDescription>
                Enter names (comma or newline separated). This will queue tasks for Python to change names on Telegram.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <Textarea
                placeholder="John Doe, Jane Smith&#10;or&#10;John Doe&#10;Jane Smith"
                value={bulkNames}
                onChange={(e) => setBulkNames(e.target.value)}
                rows={5}
              />
              <p className="text-xs text-muted-foreground">
                {bulkNames.split(/[,\n]/).filter(n => n.trim()).length} name(s) for {selectedIds.size} account(s)
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsBulkNameOpen(false)}>Cancel</Button>
                <Button onClick={handleBulkNameChange}>Queue Name Change</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Privacy Settings Dialog */}
        <Dialog open={isPrivacyDialogOpen} onOpenChange={setIsPrivacyDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Privacy Settings</DialogTitle>
              <DialogDescription>
                Configure privacy settings for {selectedIds.size} account(s). This will queue tasks for Python.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <Phone className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">Hide Phone Number</p>
                      <p className="text-xs text-muted-foreground">Only contacts can see your number</p>
                    </div>
                  </div>
                  <Switch
                    checked={privacySettings.hidePhone}
                    onCheckedChange={(c) => setPrivacySettings(p => ({ ...p, hidePhone: c }))}
                  />
                </div>
                
                <div className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <Eye className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">Hide Last Seen</p>
                      <p className="text-xs text-muted-foreground">Nobody can see when you were online</p>
                    </div>
                  </div>
                  <Switch
                    checked={privacySettings.hideLastSeen}
                    onCheckedChange={(c) => setPrivacySettings(p => ({ ...p, hideLastSeen: c }))}
                  />
                </div>
                
                <div className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <PhoneOff className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">Disable Calls</p>
                      <p className="text-xs text-muted-foreground">Nobody can call you</p>
                    </div>
                  </div>
                  <Switch
                    checked={privacySettings.disableCalls}
                    onCheckedChange={(c) => setPrivacySettings(p => ({ ...p, disableCalls: c }))}
                  />
                </div>
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsPrivacyDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleApplyPrivacySettings}>Apply Settings</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Password Dialog */}
        <Dialog open={isPasswordDialogOpen} onOpenChange={setIsPasswordDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change Cloud Password</DialogTitle>
              <DialogDescription>
                Set or change 2FA cloud password for {selectedIds.size} account(s)
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Existing Password (if any)</Label>
                <Input
                  type="password"
                  placeholder="Leave empty if no password set"
                  value={existingPassword}
                  onChange={(e) => setExistingPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>New Password</Label>
                <Input
                  type="password"
                  placeholder="Min 6 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Confirm Password</Label>
                <Input
                  type="password"
                  placeholder="Re-enter new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsPasswordDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleChangeCloudPassword} disabled={!newPassword || newPassword !== confirmPassword}>
                  Change Password
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Create Groups Dialog */}
        <Dialog open={isGroupDialogOpen} onOpenChange={setIsGroupDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Account Groups</DialogTitle>
              <DialogDescription>
                Split {selectedIds.size} account(s) into groups
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Group Name Prefix</Label>
                <Input
                  placeholder="e.g. Team, Batch"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Accounts per Group</Label>
                <Select value={newGroupSize} onValueChange={setNewGroupSize}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 accounts</SelectItem>
                    <SelectItem value="10">10 accounts</SelectItem>
                    <SelectItem value="20">20 accounts</SelectItem>
                    <SelectItem value="50">50 accounts</SelectItem>
                    <SelectItem value="100">100 accounts</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Will create {Math.ceil(selectedIds.size / parseInt(newGroupSize || '10'))} group(s)
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsGroupDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleCreateGroups} disabled={!newGroupName.trim()}>
                  Create Groups
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Bulk Proxy Assignment Dialog */}
        <Dialog open={isBulkProxyOpen} onOpenChange={setIsBulkProxyOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assign Proxy</DialogTitle>
              <DialogDescription>
                Assign proxy to {selectedIds.size} account(s)
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
                        Auto-rotate proxies
                      </span>
                    </SelectItem>
                    {proxies.filter(p => p.status === 'active').map(proxy => (
                      <SelectItem key={proxy.id} value={proxy.id}>
                        {proxy.host}:{proxy.port} {proxy.country && `(${proxy.country})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {selectedProxyId === 'auto' && (
                <div className="space-y-2">
                  <Label>Accounts per Proxy</Label>
                  <RadioGroup value={proxyRatio} onValueChange={(v) => setProxyRatio(v as '1' | '2' | '3')}>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="1" id="r1" />
                      <Label htmlFor="r1">1:1 (1 proxy per account)</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="2" id="r2" />
                      <Label htmlFor="r2">1:2 (1 proxy for 2 accounts)</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="3" id="r3" />
                      <Label htmlFor="r3">1:3 (1 proxy for 3 accounts)</Label>
                    </div>
                  </RadioGroup>
                </div>
              )}
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsBulkProxyOpen(false)}>Cancel</Button>
                <Button onClick={handleBulkProxyAssign} disabled={!selectedProxyId || isBulkProxyAssigning}>
                  {isBulkProxyAssigning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Assign Proxy
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
};

export default Accounts;
