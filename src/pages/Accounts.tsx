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
  LogOut, PhoneOff, Settings, FolderPlus, Layers, Smartphone, 
  Flame, Bot, MapPin, Key, Tag, X, History, ClipboardList, Snowflake
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
import { CountdownTimer } from '@/components/ui/countdown-timer';

// Status options for stat cards (merged categories)
const statCardOptions: { value: string; label: string; color: string; icon: React.ReactNode }[] = [
  { value: 'active', label: 'Active', color: 'bg-status-active/15 text-status-active border-status-active/30', icon: <Wifi className="w-3 h-3" /> },
  { value: 'restricted', label: 'Restricted', color: 'bg-status-restricted/15 text-status-restricted border-status-restricted/30', icon: <AlertTriangle className="w-3 h-3" /> },
  { value: 'inactive', label: 'Inactive', color: 'bg-status-disconnected/15 text-status-disconnected border-status-disconnected/30', icon: <WifiOff className="w-3 h-3" /> },
];

// Full status options for badges and individual account rendering
const statusOptions: { value: AccountStatus; label: string; color: string; icon: React.ReactNode }[] = [
  { value: 'active', label: 'Active', color: 'bg-status-active/15 text-status-active border-status-active/30', icon: <Wifi className="w-3 h-3" /> },
  { value: 'banned', label: 'Banned', color: 'bg-status-banned/15 text-status-banned border-status-banned/30', icon: <XCircle className="w-3 h-3" /> },
  { value: 'restricted', label: 'Restricted', color: 'bg-status-restricted/15 text-status-restricted border-status-restricted/30', icon: <AlertTriangle className="w-3 h-3" /> },
  { value: 'disconnected', label: 'Disconnected', color: 'bg-status-disconnected/15 text-status-disconnected border-status-disconnected/30', icon: <WifiOff className="w-3 h-3" /> },
  { value: 'cooldown', label: 'Cooldown', color: 'bg-status-cooldown/15 text-status-cooldown border-status-cooldown/30', icon: <Clock className="w-3 h-3" /> },
  { value: 'frozen', label: 'Frozen', color: 'bg-cyan-500/15 text-cyan-500 border-cyan-500/30', icon: <Snowflake className="w-3 h-3" /> },
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
  const { 
    accounts, proxies, refreshData, isLoading, 
    verifyProgress, setVerifyProgress, isVerifyingLogin, setIsVerifyingLogin, showVerifyLogs, setShowVerifyLogs,
    accountTasksProgress, setAccountTasksProgress, isAccountTaskRunning, setIsAccountTaskRunning, 
    showAccountTaskLogs, setShowAccountTaskLogs, accountTaskHistory, setAccountTaskHistory
  } = useTelegram();
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
  const [activeTab, setActiveTab] = useState<'active' | 'restricted' | 'inactive'>('active');
  
  // Tags state
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [isTagDialogOpen, setIsTagDialogOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedTagsForBulk, setSelectedTagsForBulk] = useState<string[]>([]);
  
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

  // Cleanup: Remove any lingering "Sync Profiles" state (feature was removed)
  useEffect(() => {
    if (accountTasksProgress.taskType === 'Sync Profiles' || (accountTasksProgress as any)?.internalTaskType === 'sync_profile') {
      setAccountTasksProgress({ total: 0, completed: 0, failed: 0, taskType: '', logs: [] });
      setIsAccountTaskRunning(false);
      setShowAccountTaskLogs(false);
    }
  }, [accountTasksProgress.taskType, setAccountTasksProgress, setIsAccountTaskRunning, setShowAccountTaskLogs]);
  
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
  
  // Realtime subscription for account tasks (name change, privacy, password, etc.)
  const ACCOUNT_TASK_TYPES = ['change_name', 'privacy_settings', 'change_password', 'logout_sessions'];
  
  useEffect(() => {
    if (!isAccountTaskRunning) return;
    
    const channel = supabase
      .channel('account-tasks')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'account_check_tasks' },
        (payload) => {
          const task = payload.new as any;
          if (task && ACCOUNT_TASK_TYPES.includes(task.task_type) && (task.status === 'completed' || task.status === 'failed')) {
            const account = accounts.find(a => a.id === task.account_id);
            const logEntry = {
              id: task.id,
              taskType: task.task_type,
              accountPhone: account?.phoneNumber || task.account_id,
              status: task.status as 'completed' | 'failed',
              result: task.result,
              timestamp: new Date(),
            };
            
            setAccountTasksProgress(prev => {
              const newCompleted = task.status === 'completed' ? prev.completed + 1 : prev.completed;
              const newFailed = task.status === 'failed' ? prev.failed + 1 : prev.failed;
              const newLogs = [logEntry, ...prev.logs].slice(0, 100);
              const nowIso = new Date().toISOString();
              
              // Check if all done
              if (newCompleted + newFailed >= prev.total) {
                setIsAccountTaskRunning(false);
                toast.success(`${prev.taskType} complete: ${newCompleted} success, ${newFailed} failed`);
                refreshData();
              }
              
              return {
                ...prev,
                completed: newCompleted,
                failed: newFailed,
                logs: newLogs,
                lastUpdateAt: nowIso,
              };
            });
            
            // Also add to history
            setAccountTaskHistory(prev => [logEntry, ...prev].slice(0, 200));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isAccountTaskRunning, accounts, refreshData]);

  // Watchdog: if the UI says "processing" but no tasks exist (or nothing is being picked up), stop and show a clear reason.
  useEffect(() => {
    if (!isAccountTaskRunning) return;

    const internalTaskType = (accountTasksProgress as any)?.internalTaskType as string | undefined;
    const startedAtIso = (accountTasksProgress as any)?.startedAt as string | undefined;
    if (!internalTaskType || !startedAtIso) return;

    const startMs = new Date(startedAtIso).getTime();
    let warned = false;
    let cancelled = false;

     const tick = async () => {
       if (cancelled) return;
 
       const { count, error } = await supabase
         .from('account_check_tasks')
         .select('id', { count: 'exact', head: true })
         .eq('task_type', internalTaskType)
         .in('status', ['pending', 'in_progress']);
 
       if (cancelled || error) return;
 
       const elapsedMs = Date.now() - startMs;
       const processed = (accountTasksProgress.completed || 0) + (accountTasksProgress.failed || 0);
 
       // If nothing exists shortly after starting, the queue insert likely failed (offline / permissions / backend issue)
       if ((count ?? 0) === 0 && processed === 0 && elapsedMs > 8000) {
         setIsAccountTaskRunning(false);
         toast.error('Task is stuck because no tasks were created. Please try again (or Refresh).');
         return;
       }
 
       // If tasks exist but nothing updates for a while, the runner isn’t picking them up.
       if ((count ?? 0) > 0 && processed === 0 && elapsedMs > 90000 && !warned) {
         warned = true;
 
         // Check runner heartbeat to avoid false alarms when the runner is online but busy
         const { data: hb } = await supabase
           .from('runner_heartbeats')
           .select('runner_name,last_seen')
           .ilike('runner_name', '%account%')
           .order('last_seen', { ascending: false })
           .limit(1);
 
         const lastSeenIso = hb?.[0]?.last_seen as string | undefined;
         const lastSeenMs = lastSeenIso ? new Date(lastSeenIso).getTime() : 0;
         const runnerAlive = lastSeenMs > 0 && Date.now() - lastSeenMs < 20000;
 
         if (runnerAlive) {
           toast.warning('Tasks are queued and the runner is online, but processing is slow. Please wait a bit longer.');
         } else {
           toast.error('Tasks are queued but the Account runner looks offline. Start RUN_ACCOUNT (or your VPS runner) and try again.');
         }
       }
     };

    tick();
    const interval = window.setInterval(tick, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isAccountTaskRunning, accountTasksProgress]);
   
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

  // Extract unique tags from all accounts
  useEffect(() => {
    const allTags = new Set<string>();
    accounts.forEach(acc => {
      (acc.tags || []).forEach(tag => allTags.add(tag));
    });
    setAvailableTags(Array.from(allTags).sort());
  }, [accounts]);

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

  // Helper function to start account task tracking
  const startAccountTaskTracking = (taskType: string, count: number) => {
    const internalTaskType = (() => {
      switch (taskType) {
        case 'Change Name':
          return 'change_name';
        case 'Privacy Settings':
          return 'privacy_settings';
        case 'Change Password':
          return 'change_password';
        case 'Logout Sessions':
          return 'logout_sessions';
        default:
          return undefined;
      }
    })();

    const nowIso = new Date().toISOString();

    setAccountTasksProgress({
      total: count,
      completed: 0,
      failed: 0,
      taskType: taskType,
      logs: [],
      internalTaskType,
      startedAt: nowIso,
      lastUpdateAt: nowIso,
    });
    setIsAccountTaskRunning(true);
    setShowAccountTaskLogs(true);
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
      
      startAccountTaskTracking('Change Name', selectedAccountIds.length);
      toast.info(`Queued name change for ${selectedAccountIds.length} account(s). Check logs panel for progress.`);
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
      
      startAccountTaskTracking('Privacy Settings', selectedIds.size);
      toast.info(`Queued privacy settings for ${selectedIds.size} account(s). Check logs panel for progress.`);
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
      
      startAccountTaskTracking('Change Password', selectedIds.size);
      toast.info(`Queued password change for ${selectedIds.size} account(s). Check logs panel for progress.`);
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
      
      startAccountTaskTracking('Logout Sessions', selectedIds.size);
      toast.info(`Queued logout for ${selectedIds.size} account(s). Check logs panel for progress.`);
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

  // Bulk proxy assignment - optimized with parallel updates
  const handleBulkProxyAssign = async () => {
    if (selectedIds.size === 0 || !selectedProxyId) return;
    
    setIsBulkProxyAssigning(true);
    try {
      const selectedAccountIds = Array.from(selectedIds);
      const ratio = parseInt(proxyRatio);
      
      const activeProxies = proxies.filter(p => p.status === 'active');
      
      if (activeProxies.length === 0) {
        toast.error('No active proxies available');
        setIsBulkProxyAssigning(false);
        return;
      }
      
      if (selectedProxyId !== 'auto') {
        // Single proxy to all accounts - parallel update
        await Promise.all(
          selectedAccountIds.map(accountId =>
            supabase
              .from('telegram_accounts')
              .update({ proxy_id: selectedProxyId })
              .eq('id', accountId)
          )
        );
        toast.success(`Assigned proxy to ${selectedAccountIds.length} account(s)`);
      } else {
        // Auto-rotate: pre-calculate assignments, then parallel update
        const assignments = selectedAccountIds.map((accountId, index) => {
          const proxyIndex = Math.floor(index / ratio) % activeProxies.length;
          return { accountId, proxyId: activeProxies[proxyIndex].id };
        });
        
        await Promise.all(
          assignments.map(({ accountId, proxyId }) =>
            supabase
              .from('telegram_accounts')
              .update({ proxy_id: proxyId })
              .eq('id', accountId)
          )
        );
        
        const uniqueProxiesUsed = new Set(assignments.map(a => a.proxyId)).size;
        toast.success(`Auto-assigned ${uniqueProxiesUsed} proxy(s) to ${selectedAccountIds.length} account(s)`);
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

  // Real session verification via edge function (checks file validity)
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

  // Verify Login - checks actual Telegram connection via Python runner
  // State is now managed in TelegramContext to persist across navigation
  
  // Realtime subscription for verify_session tasks
  useEffect(() => {
    if (!isVerifyingLogin) return;
    
    const channel = supabase
      .channel('verify-tasks')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'account_check_tasks' },
        (payload) => {
          const task = payload.new as any;
          if (task && task.task_type === 'verify_session' && (task.status === 'completed' || task.status === 'failed')) {
            setVerifyProgress(prev => {
              const newChecked = prev.checked + 1;
              let newActive = prev.active;
              let newDisconnected = prev.disconnected;
              let newBanned = prev.banned;
              const newErrors = [...prev.errors];
              
              // Parse result to get status
              const result = task.result;
              if (result) {
                if (result.includes('active') || result.includes('success')) {
                  newActive++;
                } else if (result.includes('banned') || result.includes('deleted') || result.includes('deactivated')) {
                  newBanned++;
                  const account = accounts.find(a => a.id === task.account_id);
                  newErrors.push(`${account?.phoneNumber || task.account_id}: ${result}`);
                } else if (result.includes('disconnected') || result.includes('error') || result.includes('failed')) {
                  newDisconnected++;
                  const account = accounts.find(a => a.id === task.account_id);
                  newErrors.push(`${account?.phoneNumber || task.account_id}: ${result}`);
                } else {
                  // Unknown result, count as disconnected
                  newDisconnected++;
                }
              } else if (task.status === 'failed') {
                newDisconnected++;
                const account = accounts.find(a => a.id === task.account_id);
                newErrors.push(`${account?.phoneNumber || task.account_id}: Task failed`);
              }
              
              // Check if all done
              if (newChecked >= prev.total) {
                setIsVerifyingLogin(false);
                toast.success(`Verification complete: ${newActive} active, ${newDisconnected} offline, ${newBanned} banned`);
                refreshData();
              }
              
              return {
                total: prev.total,
                checked: newChecked,
                active: newActive,
                disconnected: newDisconnected,
                banned: newBanned,
                errors: newErrors.slice(-50), // Keep last 50 errors
              };
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isVerifyingLogin, accounts, refreshData]);
  
  const handleVerifyLogin = async () => {
    if (selectedIds.size === 0) return;
    
    setIsVerifyingLogin(true);
    setShowVerifyLogs(true);
    setVerifyProgress({
      total: selectedIds.size,
      checked: 0,
      active: 0,
      disconnected: 0,
      banned: 0,
      errors: [],
    });
    
    try {
      const tasks = Array.from(selectedIds).map(accountId => ({
        account_id: accountId,
        task_type: 'verify_session',
        status: 'pending',
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      toast.info(`Verifying ${selectedIds.size} account(s)... Check logs panel for progress.`);
    } catch (error) {
      console.error('Error queuing login verification:', error);
      toast.error('Failed to queue verification');
      setIsVerifyingLogin(false);
    }
  };

  // Bulk tag assignment - optimized with parallel updates
  const [isTagAssigning, setIsTagAssigning] = useState(false);
  
  const handleBulkTagAssign = async () => {
    if (selectedIds.size === 0) return;
    
    const tagsToAssign = [...selectedTagsForBulk];
    if (newTagName.trim()) {
      tagsToAssign.push(newTagName.trim());
    }
    
    if (tagsToAssign.length === 0) {
      toast.error('Select or enter at least one tag');
      return;
    }
    
    setIsTagAssigning(true);
    try {
      // Parallel updates for all selected accounts
      await Promise.all(
        Array.from(selectedIds).map(async (accountId) => {
          const account = accounts.find(a => a.id === accountId);
          const existingTags = account?.tags || [];
          const newTags = Array.from(new Set([...existingTags, ...tagsToAssign]));
          
          return supabase
            .from('telegram_accounts')
            .update({ tags: newTags })
            .eq('id', accountId);
        })
      );
      
      toast.success(`Added ${tagsToAssign.length} tag(s) to ${selectedIds.size} account(s)`);
      setIsTagDialogOpen(false);
      setNewTagName('');
      setSelectedTagsForBulk([]);
      refreshData();
    } catch (error) {
      console.error('Error assigning tags:', error);
      toast.error('Failed to assign tags');
    } finally {
      setIsTagAssigning(false);
    }
  };

  // Remove tag from single account
  const handleRemoveTag = async (accountId: string, tagToRemove: string) => {
    try {
      const account = accounts.find(a => a.id === accountId);
      const newTags = (account?.tags || []).filter(t => t !== tagToRemove);
      
      await supabase
        .from('telegram_accounts')
        .update({ tags: newTags })
        .eq('id', accountId);
      
      toast.success('Tag removed');
      refreshData();
    } catch (error) {
      console.error('Error removing tag:', error);
      toast.error('Failed to remove tag');
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
      (acc.username?.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (acc.tags || []).some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesStatus = statusFilter === 'all' || acc.status === statusFilter;
    
    const matchesTag = tagFilter === 'all' || (acc.tags || []).includes(tagFilter);
    
    return matchesSearch && matchesStatus && matchesTag;
  });

  // Split accounts by status
  // Accounts with active restrictedUntil are treated as restricted, NOT active
  const now = new Date();
  const accountsByStatus = {
    active: filteredAccounts.filter(a => {
      // If has active restriction, belongs in restricted tab only
      if (a.restrictedUntil && new Date(a.restrictedUntil) > now) return false;
      return a.status === 'active';
    }),
    restricted: filteredAccounts.filter(a => 
      a.status === 'restricted' || 
      a.status === 'cooldown' ||
      (a.restrictedUntil && new Date(a.restrictedUntil) > now)
    ),
    inactive: filteredAccounts.filter(a => 
      a.status === 'banned' || 
      a.status === 'frozen' || 
      a.status === 'disconnected'
    ),
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

  // Calculate stats - accounts with active restrictedUntil count as restricted, not active
  const currentTime = new Date();
  const stats = {
    total: accounts.length,
    active: accounts.filter(a => {
      if (a.restrictedUntil && new Date(a.restrictedUntil) > currentTime) return false;
      return a.status === 'active';
    }).length,
    restricted: accounts.filter(a => 
      a.status === 'restricted' || 
      a.status === 'cooldown' ||
      (a.restrictedUntil && new Date(a.restrictedUntil) > currentTime)
    ).length,
    inactive: accounts.filter(a => 
      a.status === 'banned' || 
      a.status === 'frozen' || 
      a.status === 'disconnected'
    ).length,
  };

  const renderAccountCard = (account: TelegramAccount) => {
    const verifyResult = verifyResults.get(account.id);
    const proxyLabel = getProxyLabel(account.proxyId);
    const proxyStatus = getProxyStatus(account.proxyId);
    const msgSent24h = messagesSentLast24h.get(account.id) || 0;
    const accountGroup = groups.find(g => g.accountIds.includes(account.id));
    
    // Accounts without username AND no first/last name might be blocked/restricted
    const isPotentiallyBlocked = account.status === 'active' && 
      !account.username && 
      !account.firstName && 
      !account.lastName;
    
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
              account.status === 'active' && "bg-status-active/15 text-status-active",
              account.status === 'banned' && "bg-status-banned/15 text-status-banned",
              account.status === 'restricted' && "bg-status-restricted/15 text-status-restricted",
              account.status === 'cooldown' && "bg-status-cooldown/15 text-status-cooldown",
              account.status === 'disconnected' && "bg-status-disconnected/15 text-status-disconnected",
              account.status === 'frozen' && "bg-cyan-500/15 text-cyan-500",
            )}>
              {verifyResult?.status === 'checking' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (account.firstName || account.lastName) ? (
                (account.firstName || account.lastName || '').charAt(0).toUpperCase()
              ) : (
                <Phone className="w-4 h-4" />
              )}
            </div>
          )}
          
          {/* Status indicator */}
          <div className={cn(
            "absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-card flex items-center justify-center",
            account.status === 'active' && "bg-status-active",
            account.status === 'banned' && "bg-status-banned",
            account.status === 'restricted' && "bg-status-restricted",
            account.status === 'cooldown' && "bg-status-cooldown",
            account.status === 'disconnected' && "bg-status-disconnected",
            account.status === 'frozen' && "bg-cyan-500",
          )}>
            {account.status === 'active' && <Check className="w-2 h-2 text-white" />}
            {account.status === 'banned' && <XCircle className="w-2 h-2 text-white" />}
            {account.status === 'restricted' && <AlertTriangle className="w-2 h-2 text-white" />}
            {account.status === 'frozen' && <Snowflake className="w-2 h-2 text-white" />}
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
              <CheckCircle className="w-3.5 h-3.5 text-status-active" />
            )}
            
            {/* Banned Badge - Telegram banned accounts only */}
            {account.status === 'banned' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-status-banned text-white text-[10px] font-semibold animate-pulse">
                <XCircle className="w-3 h-3" />
                BANNED
              </span>
            )}
            
            {/* Frozen Badge - User-deleted accounts */}
            {account.status === 'frozen' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500 text-white text-[10px] font-semibold">
                <Snowflake className="w-3 h-3" />
                DELETED
              </span>
            )}
            
            {/* Restricted Badge - with timer */}
            {account.status === 'restricted' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-status-restricted text-white text-[10px] font-semibold">
                <AlertTriangle className="w-3 h-3" />
                RESTRICTED
              </span>
            )}
            
            {/* Disconnected Badge */}
            {account.status === 'disconnected' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-status-disconnected text-white text-[10px] font-semibold">
                <WifiOff className="w-3 h-3" />
                OFFLINE
              </span>
            )}
            
            {/* Potentially Blocked Warning - active accounts with no profile info */}
            {isPotentiallyBlocked && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-600 text-[10px] font-semibold border border-orange-500/30">
                      <AlertTriangle className="w-3 h-3" />
                      NO PROFILE
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>This account has no username or name.</p>
                    <p className="text-xs text-muted-foreground">May be blocked or restricted. Try syncing profile.</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
            {(account.firstName || account.lastName) && (
              <span>{account.firstName || ''} {account.lastName || ''}</span>
            )}
            {account.username && !account.username.includes('update_state') && (
              <span className="text-primary/70">@{account.username}</span>
            )}
            {account.restrictedUntil && new Date(account.restrictedUntil) > new Date() && (
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 text-[10px]">
                <Clock className="w-3 h-3" />
                <CountdownTimer 
                  targetDate={new Date(account.restrictedUntil)} 
                  compact
                  className="text-blue-500"
                />
              </div>
            )}
            {/* Ban Reason */}
            {account.status === 'banned' && account.banReason && (
              <span className="text-[10px] text-status-banned truncate max-w-[150px]" title={account.banReason}>
                {account.banReason.slice(0, 30)}...
              </span>
            )}
            {/* Account Tags */}
            {(account.tags || []).slice(0, 3).map(tag => (
              <span 
                key={tag} 
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] cursor-pointer hover:bg-primary/20"
                onClick={(e) => { e.stopPropagation(); handleRemoveTag(account.id, tag); }}
              >
                <Tag className="w-2.5 h-2.5" />
                {tag}
                <X className="w-2.5 h-2.5" />
              </span>
            ))}
            {(account.tags || []).length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{(account.tags || []).length - 3}</span>
            )}
          </div>
        </div>

        {/* Stats - desktop */}
        <div className="hidden lg:flex items-center gap-3 text-xs flex-wrap">
          <div className="text-center min-w-[40px]">
            <div className="font-medium text-foreground">{msgSent24h}/{account.dailyLimit || 10}</div>
            <div className="text-muted-foreground">24h</div>
          </div>
          <div className="text-center min-w-[40px]">
            <div className="font-medium text-foreground">{getAccountAge(account.createdAt)}d</div>
            <div className="text-muted-foreground">Age</div>
          </div>
          
          {/* Warmup Phase Indicator */}
          {account.warmupPhase !== undefined && account.warmupPhase < 4 && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded text-xs",
                    account.warmupPhase === 0 && "bg-status-banned/10 text-status-banned",
                    account.warmupPhase === 1 && "bg-status-warning/10 text-status-warning",
                    account.warmupPhase === 2 && "bg-status-warning/10 text-status-warning",
                    account.warmupPhase === 3 && "bg-status-active/10 text-status-active",
                  )}>
                    <Flame className="w-3 h-3" />
                    <span>P{account.warmupPhase}/4</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Warmup Phase {account.warmupPhase}/4</p>
                  <p className="text-xs text-muted-foreground">
                    {account.warmupPhase === 0 && "New account - limited to profile setup"}
                    {account.warmupPhase === 1 && "Early warmup - join channels only"}
                    {account.warmupPhase === 2 && "Mid warmup - can react & view"}
                    {account.warmupPhase === 3 && "Almost ready - limited messaging"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {account.warmupPhase === 4 && (
            <div className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-status-active/10 text-status-active">
              <Flame className="w-3 h-3" />
              <span>Ready</span>
            </div>
          )}

          {/* SpamBot Status */}
          {account.spambotStatus && account.spambotStatus !== 'unknown' && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded text-xs",
                    account.spambotStatus === 'clean' && "bg-status-active/10 text-status-active",
                    account.spambotStatus === 'limited' && "bg-status-warning/10 text-status-warning",
                    account.spambotStatus === 'restricted' && "bg-status-banned/10 text-status-banned",
                  )}>
                    <Bot className="w-3 h-3" />
                    <span>{account.spambotStatus === 'clean' ? '✓' : account.spambotStatus}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>SpamBot Status: {account.spambotStatus}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Geo Mismatch Warning */}
          {account.geoMismatch && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-status-warning/10 text-status-warning">
                    <MapPin className="w-3 h-3" />
                    <span>!</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Geographic Mismatch</p>
                  <p className="text-xs text-muted-foreground">
                    Phone country ({account.phoneCountry || '?'}) doesn't match proxy country
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Device Fingerprint */}
          {account.deviceModel && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-500/10 text-blue-600">
                    <Smartphone className="w-3 h-3" />
                    <span className="max-w-[80px] truncate">{account.deviceModel?.split(' ')[0]}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{account.deviceModel}</p>
                  <p className="text-xs text-muted-foreground">
                    {account.systemVersion} | v{account.appVersion} | {account.langCode}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          
          {proxyLabel && (
            <div className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs",
              proxyStatus === 'active' ? "bg-status-active/10 text-status-active" : "bg-muted text-muted-foreground"
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
                      <span className="flex items-center gap-1 text-status-active">
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="cursor-pointer hover:border-primary/30 transition-colors" onClick={() => setStatusFilter('all')}>
            <CardContent className="p-3">
              <div className="text-2xl font-bold">{stats.total}</div>
              <div className="text-xs text-muted-foreground">Total</div>
            </CardContent>
          </Card>
          {statCardOptions.map(opt => (
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
                  Session Check
                </Button>
                
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={handleVerifyLogin} disabled={isVerifyingLogin} className="gap-1.5">
                    {isVerifyingLogin ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
                    Check Ban
                  </Button>
                  {(isVerifyingLogin || verifyProgress.checked > 0) && (
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => setShowVerifyLogs(!showVerifyLogs)}
                      className="h-8 w-8 p-0"
                    >
                      <FileText className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
                
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
                    <DropdownMenuItem onClick={() => setIsTagDialogOpen(true)}>
                      <Tag className="w-4 h-4 mr-2" />
                      Assign Tags
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setIsGroupDialogOpen(true)}>
                      <FolderPlus className="w-4 h-4 mr-2" />
                      Create Groups
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setIsBulkProxyOpen(true)}>
                      <Globe className="w-4 h-4 mr-2" />
                      Assign Proxy
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setShowAccountTaskLogs(!showAccountTaskLogs)}>
                      <ClipboardList className="w-4 h-4 mr-2" />
                      {showAccountTaskLogs ? 'Hide' : 'Show'} Task Logs
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
          <Card className="border-status-warning/30 bg-status-warning/5">
            <CardContent className="p-3">
              <div className="flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-status-warning" />
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

        {/* Verify Login Progress & Logs */}
        {showVerifyLogs && (isVerifyingLogin || verifyProgress.checked > 0) && (
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-2 pt-3 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  {isVerifyingLogin && <Loader2 className="w-4 h-4 animate-spin" />}
                  <Wifi className="w-4 h-4" />
                  Check Ban Progress
                </CardTitle>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {verifyProgress.checked}/{verifyProgress.total}
                  </span>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => {
                      setShowVerifyLogs(false);
                      if (!isVerifyingLogin) {
                        setVerifyProgress({ total: 0, checked: 0, active: 0, disconnected: 0, banned: 0, errors: [] });
                      }
                    }}
                    className="h-6 w-6 p-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0">
              <Progress 
                value={verifyProgress.total > 0 ? (verifyProgress.checked / verifyProgress.total) * 100 : 0} 
                className="h-2 mb-3" 
              />
              
              {/* Stats Grid */}
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="flex items-center gap-2 p-2 rounded-md bg-status-active/10 border border-status-active/20">
                  <CheckCircle className="w-4 h-4 text-status-active" />
                  <div>
                    <div className="text-lg font-bold text-status-active">{verifyProgress.active}</div>
                    <div className="text-xs text-muted-foreground">Active</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-2 rounded-md bg-status-disconnected/10 border border-status-disconnected/20">
                  <WifiOff className="w-4 h-4 text-status-disconnected" />
                  <div>
                    <div className="text-lg font-bold text-status-disconnected">{verifyProgress.disconnected}</div>
                    <div className="text-xs text-muted-foreground">Offline</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-2 rounded-md bg-status-banned/10 border border-status-banned/20">
                  <XCircle className="w-4 h-4 text-status-banned" />
                  <div>
                    <div className="text-lg font-bold text-status-banned">{verifyProgress.banned}</div>
                    <div className="text-xs text-muted-foreground">Banned</div>
                  </div>
                </div>
              </div>
              
              {/* Error Logs */}
              {verifyProgress.errors.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-between text-xs text-muted-foreground hover:text-foreground">
                      <span className="flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                        {verifyProgress.errors.length} error(s)
                      </span>
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 max-h-32 overflow-y-auto rounded-md bg-muted/50 p-2 space-y-1">
                      {verifyProgress.errors.map((err, i) => (
                        <div key={i} className="text-xs font-mono text-destructive/80 break-all">
                          {err}
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </CardContent>
          </Card>
        )}

        {/* Account Tasks Progress & Logs */}
        {(showAccountTaskLogs || isAccountTaskRunning) && (
          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardHeader className="pb-2 pt-3 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  {isAccountTaskRunning && <Loader2 className="w-4 h-4 animate-spin" />}
                  <ClipboardList className="w-4 h-4" />
                  {accountTasksProgress.taskType || 'Account Tasks'}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {isAccountTaskRunning && (
                    <span className="text-xs text-muted-foreground">
                      {accountTasksProgress.completed + accountTasksProgress.failed}/{accountTasksProgress.total}
                    </span>
                  )}
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => {
                      setShowAccountTaskLogs(false);
                      if (!isAccountTaskRunning) {
                        setAccountTasksProgress({ total: 0, completed: 0, failed: 0, taskType: '', logs: [] });
                      }
                    }}
                    className="h-6 w-6 p-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0">
              {isAccountTaskRunning && (
                <Progress 
                  value={accountTasksProgress.total > 0 ? ((accountTasksProgress.completed + accountTasksProgress.failed) / accountTasksProgress.total) * 100 : 0} 
                  className="h-2 mb-3" 
                />
              )}
              
              {/* Stats Grid */}
              {(isAccountTaskRunning || accountTasksProgress.completed > 0 || accountTasksProgress.failed > 0) && (
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div className="flex items-center gap-2 p-2 rounded-md bg-status-active/10 border border-status-active/20">
                    <CheckCircle className="w-4 h-4 text-status-active" />
                    <div>
                      <div className="text-lg font-bold text-status-active">{accountTasksProgress.completed}</div>
                      <div className="text-xs text-muted-foreground">Success</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md bg-status-banned/10 border border-status-banned/20">
                    <XCircle className="w-4 h-4 text-status-banned" />
                    <div>
                      <div className="text-lg font-bold text-status-banned">{accountTasksProgress.failed}</div>
                      <div className="text-xs text-muted-foreground">Failed</div>
                    </div>
                  </div>
                </div>
              )}
              
              {/* Current Session Logs */}
              {accountTasksProgress.logs.length > 0 ? (
                <Collapsible defaultOpen>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-between text-xs text-muted-foreground hover:text-foreground">
                      <span className="flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5" />
                        Recent Logs ({accountTasksProgress.logs.length})
                      </span>
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 max-h-40 overflow-y-auto rounded-md bg-muted/50 p-2 space-y-1">
                      {accountTasksProgress.logs.map((log) => (
                        <div key={log.id} className={cn(
                          "text-xs font-mono break-all flex items-center gap-2",
                          log.status === 'completed' ? "text-status-active" : "text-destructive/80"
                        )}>
                          {log.status === 'completed' ? <Check className="w-3 h-3 flex-shrink-0" /> : <XCircle className="w-3 h-3 flex-shrink-0" />}
                          <span className="text-muted-foreground">{log.accountPhone}</span>
                          <span>{log.taskType.replace('_', ' ')}</span>
                          {log.result && log.status === 'failed' && (
                            <span className="text-destructive/60 truncate">- {log.result}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ) : isAccountTaskRunning ? (
                <div className="text-xs text-muted-foreground text-center py-2">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                  Waiting for Python runner to process tasks...
                </div>
              ) : (
                <div className="text-xs text-muted-foreground text-center py-2">
                  No logs yet. Run an account task to see results here.
                </div>
              )}
              
              {/* History */}
              {accountTaskHistory.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-between text-xs text-muted-foreground hover:text-foreground mt-1">
                      <span className="flex items-center gap-1.5">
                        <History className="w-3.5 h-3.5" />
                        History ({accountTaskHistory.length})
                      </span>
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-muted/30 p-2 space-y-1">
                      {accountTaskHistory.slice(0, 50).map((log, i) => (
                        <div key={`${log.id}-${i}`} className={cn(
                          "text-xs font-mono break-all flex items-center gap-2",
                          log.status === 'completed' ? "text-status-active/70" : "text-destructive/60"
                        )}>
                          {log.status === 'completed' ? <Check className="w-3 h-3 flex-shrink-0" /> : <XCircle className="w-3 h-3 flex-shrink-0" />}
                          <span className="text-muted-foreground/70 text-[10px]">
                            {log.timestamp.toLocaleTimeString()}
                          </span>
                          <span className="text-muted-foreground">{log.accountPhone}</span>
                          <span>{log.taskType.replace('_', ' ')}</span>
                        </div>
                      ))}
                    </div>
                    {accountTaskHistory.length > 0 && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => setAccountTaskHistory([])}
                        className="w-full text-xs text-muted-foreground hover:text-destructive mt-1"
                      >
                        Clear History
                      </Button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </CardContent>
          </Card>
        )}


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
          
          {/* Tag Filter */}
          {availableTags.length > 0 && (
            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger className="w-40 h-9">
                <Tag className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Tag" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tags</SelectItem>
                {availableTags.map(tag => (
                  <SelectItem key={tag} value={tag}>
                    <span className="flex items-center gap-2">
                      <Tag className="w-3 h-3" />
                      {tag}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Account Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="active" className="gap-1.5">
              <Wifi className="w-3.5 h-3.5" />
              Active ({accountsByStatus.active.length})
            </TabsTrigger>
            <TabsTrigger value="restricted" className="gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              Restricted ({accountsByStatus.restricted.length})
            </TabsTrigger>
            <TabsTrigger value="inactive" className="gap-1.5">
              <WifiOff className="w-3.5 h-3.5" />
              Inactive ({accountsByStatus.inactive.length})
            </TabsTrigger>
          </TabsList>

          {(['active', 'restricted', 'inactive'] as const).map(status => (
            <TabsContent key={status} value={status} className="mt-4">
              {accountsByStatus[status].length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center">
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                      {status === 'inactive' ? <WifiOff className="w-6 h-6" /> : statusOptions.find(o => o.value === status)?.icon}
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

        {/* Tag Assignment Dialog */}
        <Dialog open={isTagDialogOpen} onOpenChange={setIsTagDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assign Tags</DialogTitle>
              <DialogDescription>
                Add tags to {selectedIds.size} selected account(s) for organization
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              {/* Existing tags to select */}
              {availableTags.length > 0 && (
                <div className="space-y-2">
                  <Label>Select Existing Tags</Label>
                  <div className="flex flex-wrap gap-2">
                    {availableTags.map(tag => (
                      <Badge
                        key={tag}
                        variant={selectedTagsForBulk.includes(tag) ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => {
                          if (selectedTagsForBulk.includes(tag)) {
                            setSelectedTagsForBulk(prev => prev.filter(t => t !== tag));
                          } else {
                            setSelectedTagsForBulk(prev => [...prev, tag]);
                          }
                        }}
                      >
                        <Tag className="w-3 h-3 mr-1" />
                        {tag}
                        {selectedTagsForBulk.includes(tag) && <Check className="w-3 h-3 ml-1" />}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              
              {/* New tag input */}
              <div className="space-y-2">
                <Label>Or Create New Tag</Label>
                <Input
                  placeholder="Enter new tag name..."
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                />
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setIsTagDialogOpen(false); setNewTagName(''); setSelectedTagsForBulk([]); }}>
                  Cancel
                </Button>
                <Button onClick={handleBulkTagAssign} disabled={isTagAssigning || (selectedTagsForBulk.length === 0 && !newTagName.trim())}>
                  {isTagAssigning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Tag className="w-4 h-4 mr-2" />}
                  {isTagAssigning ? 'Assigning...' : 'Assign Tags'}
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
