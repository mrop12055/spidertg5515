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
  Flame, Bot, MapPin, Key, Tag, X, History, ClipboardList, Shuffle,
  CheckCircle2, AlertCircle
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
    accountTasksProgress, setAccountTasksProgress, isAccountTaskRunning, setIsAccountTaskRunning, 
    showAccountTaskLogs, setShowAccountTaskLogs, accountTaskHistory, setAccountTaskHistory
  } = useTelegram();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isUploading, setIsUploading] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<SessionFile[]>([]);
  const [uploadResults, setUploadResults] = useState<{ successful: number; failed: number } | null>(null);
  const [uploadTags, setUploadTags] = useState<string[]>([]); // Tags to assign during upload
  const [newUploadTag, setNewUploadTag] = useState(''); // New tag input during upload
  
  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkChecking, setIsBulkChecking] = useState(false);
  const [verifyResults, setVerifyResults] = useState<Map<string, VerifyResult>>(new Map());
  
  // Bulk operations dialogs
  const [isBulkNameOpen, setIsBulkNameOpen] = useState(false);
  const [bulkNames, setBulkNames] = useState('');
  
  // Material-based name change
  const [nameTags, setNameTags] = useState<{ id: string; name: string; item_count: number }[]>([]);
  const [selectedNameTagId, setSelectedNameTagId] = useState<string>('');
  const [materialNames, setMaterialNames] = useState<{ id: string; first_name: string; last_name: string | null }[]>([]);
  const [selectedMaterialNames, setSelectedMaterialNames] = useState<Set<string>>(new Set());
  const [nameAssignMode, setNameAssignMode] = useState<'random' | 'select'>('random');
  const [isLoadingNames, setIsLoadingNames] = useState(false);
  
  // Profile picture change
  const [isProfilePicOpen, setIsProfilePicOpen] = useState(false);
  const [pictureTags, setPictureTags] = useState<{ id: string; name: string; item_count: number }[]>([]);
  const [selectedPicTagId, setSelectedPicTagId] = useState<string>('');
  const [materialPictures, setMaterialPictures] = useState<{ id: string; file_name: string; file_url: string }[]>([]);
  const [selectedMaterialPics, setSelectedMaterialPics] = useState<Set<string>>(new Set());
  const [picAssignMode, setPicAssignMode] = useState<'random' | 'select'>('random');
  const [isLoadingPictures, setIsLoadingPictures] = useState(false);
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
  
  const [isBulkProxyAssigning, setIsBulkProxyAssigning] = useState(false);
  
  // Active tab for account sections
  const [activeTab, setActiveTab] = useState<'active' | 'restricted' | 'inactive'>('active');
  
  // Tags state
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [proxyFilter, setProxyFilter] = useState<string>('all'); // 'all' | 'with_proxy' | 'without_proxy'
  const [profileFilter, setProfileFilter] = useState<string>('all'); // 'all' | 'synced' | 'not_synced'
  const [isTagDialogOpen, setIsTagDialogOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedTagsForBulk, setSelectedTagsForBulk] = useState<string[]>([]);
  const [editingTagName, setEditingTagName] = useState('');
  const [editedTagValue, setEditedTagValue] = useState('');
  
  // SpamBot check state
  const [isSpamBotChecking, setIsSpamBotChecking] = useState(false);
  const [spamBotProgress, setSpamBotProgress] = useState<{ total: number; completed: number; results: Map<string, { status: string; result?: string }> }>({ total: 0, completed: 0, results: new Map() });
  
  
  // Unique conversations per account (how many unique people they've messaged)
  const [uniqueConversations, setUniqueConversations] = useState<Map<string, { total: number; withReplies: number }>>(new Map());

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
  
  // Realtime subscription for account tasks (name change, privacy, password, etc.)
  const ACCOUNT_TASK_TYPES = ['change_name', 'change_photo', 'privacy_settings', 'change_password', 'logout_sessions', 'sync_profile'];
  
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
            
            // For sync_profile, refresh immediately on each completion to update UI
            if (task.task_type === 'sync_profile' && task.status === 'completed') {
              refreshData();
            }
            
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
   
  // Fetch unique conversations per account (unique people contacted)
  useEffect(() => {
    const fetchUniqueConversations = async () => {
      const accountIds = accounts.map(a => a.id);
      if (accountIds.length === 0) return;
      
      // Fetch conversation counts grouped by account_id
      const counts = new Map<string, { total: number; withReplies: number }>();
      let offset = 0;
      const pageSize = 1000;
      let hasMore = true;
      
      while (hasMore) {
        const { data, error } = await supabase
          .from('conversations')
          .select('account_id, has_reply')
          .eq('first_message_sent', true)
          .range(offset, offset + pageSize - 1);
        
        if (error || !data) {
          hasMore = false;
          break;
        }
        
        data.forEach((conv: any) => {
          const existing = counts.get(conv.account_id) || { total: 0, withReplies: 0 };
          existing.total += 1;
          if (conv.has_reply) existing.withReplies += 1;
          counts.set(conv.account_id, existing);
        });
        
        hasMore = data.length === pageSize;
        offset += pageSize;
      }
      
      setUniqueConversations(counts);
    };
    
    fetchUniqueConversations();
    const interval = setInterval(fetchUniqueConversations, 60000);
    return () => clearInterval(interval);
  }, [accounts]);

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

      // Combine selected existing tags + new tag if entered
      const tagsToAssign = [...uploadTags];
      if (newUploadTag.trim() && !tagsToAssign.includes(newUploadTag.trim())) {
        tagsToAssign.push(newUploadTag.trim());
      }

      const { data, error } = await supabase.functions.invoke('process-account-upload', {
        body: { accounts: accountsToUpload, tags: tagsToAssign }
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
        setUploadTags([]);
        setNewUploadTag('');
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
      const idsToDelete = Array.from(selectedIds);
      
      // First, clear warmup_pair_id references that might block deletion
      // (accounts can reference each other via warmup_pair_id)
      await supabase
        .from('telegram_accounts')
        .update({ warmup_pair_id: null, interaction_pair_id: null })
        .in('id', idsToDelete);
      
      // Also clear references FROM other accounts TO these accounts
      await supabase
        .from('telegram_accounts')
        .update({ warmup_pair_id: null })
        .in('warmup_pair_id', idsToDelete);
      
      await supabase
        .from('telegram_accounts')
        .update({ interaction_pair_id: null })
        .in('interaction_pair_id', idsToDelete);
      
      // Clear proxy assignments
      await supabase
        .from('proxies')
        .update({ assigned_account_id: null })
        .in('assigned_account_id', idsToDelete);
      
      // Delete related records in other tables that reference these accounts
      await Promise.all([
        supabase.from('account_check_tasks').delete().in('account_id', idsToDelete),
        supabase.from('warmup_messages').delete().in('sender_account_id', idsToDelete),
        supabase.from('warmup_messages').delete().in('receiver_account_id', idsToDelete),
        supabase.from('warmup_schedule').delete().in('account_id', idsToDelete),
        supabase.from('maturation_tasks').delete().in('account_id', idsToDelete),
        supabase.from('scheduled_interactions').delete().in('sender_account_id', idsToDelete),
        supabase.from('scheduled_interactions').delete().in('receiver_account_id', idsToDelete),
        supabase.from('interaction_scheduler').delete().in('sender_account_id', idsToDelete),
        supabase.from('interaction_scheduler').delete().in('receiver_account_id', idsToDelete),
        supabase.from('block_contact_tasks').delete().in('account_id', idsToDelete),
        supabase.from('contact_import_tasks').delete().in('account_id', idsToDelete),
      ]);
      
      // Delete warmup pairs that involve these accounts
      await supabase.from('warmup_pairs').delete().in('account_a_id', idsToDelete);
      await supabase.from('warmup_pairs').delete().in('account_b_id', idsToDelete);
      
      // Now delete the accounts
      const { error } = await supabase
        .from('telegram_accounts')
        .delete()
        .in('id', idsToDelete);

      if (error) throw error;
      
      toast.success(`Deleted ${selectedIds.size} account(s)`);
      setSelectedIds(new Set());
      refreshData();
    } catch (error) {
      console.error('Error bulk deleting:', error);
      toast.error('Failed to delete accounts: ' + (error as Error).message);
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
        case 'Change Photo':
          return 'change_photo';
        case 'Privacy Settings':
          return 'privacy_settings';
        case 'Change Password':
          return 'change_password';
        case 'Logout Sessions':
          return 'logout_sessions';
        case 'Sync Profile':
          return 'sync_profile';
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

  // Fetch name tags when dialog opens
  const fetchNameTags = async () => {
    const { data, error } = await supabase
      .from('material_tags')
      .select('id, name, item_count')
      .eq('type', 'names')
      .order('name');
    if (data && !error) {
      setNameTags(data);
    }
  };

  // Fetch names for selected tag
  const fetchNamesForTag = async (tagId: string) => {
    setIsLoadingNames(true);
    const { data, error } = await supabase
      .from('material_names')
      .select('id, first_name, last_name')
      .eq('tag_id', tagId);
    if (data && !error) {
      setMaterialNames(data);
    }
    setIsLoadingNames(false);
  };

  // Fetch picture tags when dialog opens
  const fetchPictureTags = async () => {
    const { data, error } = await supabase
      .from('material_tags')
      .select('id, name, item_count')
      .eq('type', 'pictures')
      .order('name');
    if (data && !error) {
      setPictureTags(data);
    }
  };

  // Fetch pictures for selected tag
  const fetchPicturesForTag = async (tagId: string) => {
    setIsLoadingPictures(true);
    const { data, error } = await supabase
      .from('material_pictures')
      .select('id, file_name, file_url')
      .eq('tag_id', tagId);
    if (data && !error) {
      setMaterialPictures(data);
    }
    setIsLoadingPictures(false);
  };

  // Bulk name change - creates tasks for Python to process
  const handleBulkNameChange = async () => {
    if (selectedIds.size === 0) return;
    
    const selectedAccountIds = Array.from(selectedIds);
    let namesToUse: { first_name: string; last_name: string }[] = [];
    
    // Use material names from selected tag
    if (selectedNameTagId && materialNames.length > 0) {
      if (nameAssignMode === 'random') {
        // Use all names from the tag, randomly assigned
        namesToUse = materialNames.map(n => ({
          first_name: n.first_name,
          last_name: n.last_name || ''
        }));
      } else {
        // Use only selected names
        const selectedNamesList = materialNames.filter(n => selectedMaterialNames.has(n.id));
        namesToUse = selectedNamesList.map(n => ({
          first_name: n.first_name,
          last_name: n.last_name || ''
        }));
      }
    } else if (bulkNames.trim()) {
      // Fallback to manual text input
      const names = bulkNames.split(/[,\n]/).map(n => n.trim()).filter(n => n);
      namesToUse = names.map(name => {
        const parts = name.split(' ');
        return {
          first_name: parts[0] || '',
          last_name: parts.slice(1).join(' ') || ''
        };
      });
    }
    
    if (namesToUse.length === 0) {
      toast.error('Please select a tag with names or enter names manually');
      return;
    }
    
    try {
      // Create tasks for Python script to change names on Telegram
      const tasks = selectedAccountIds.map((accountId, i) => {
        // Randomly pick or cycle through names
        const nameIndex = nameAssignMode === 'random' 
          ? Math.floor(Math.random() * namesToUse.length)
          : i % namesToUse.length;
        const nameData = namesToUse[nameIndex];
        
        return {
          account_id: accountId,
          task_type: 'change_name',
          status: 'pending',
          result: JSON.stringify({ first_name: nameData.first_name, last_name: nameData.last_name }),
        };
      });
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      startAccountTaskTracking('Change Name', selectedAccountIds.length);
      toast.info(`Queued name change for ${selectedAccountIds.length} account(s). Check logs panel for progress.`);
      setBulkNames('');
      setSelectedNameTagId('');
      setMaterialNames([]);
      setSelectedMaterialNames(new Set());
      setIsBulkNameOpen(false);
    } catch (error) {
      console.error('Error queuing name change:', error);
      toast.error('Failed to queue name change');
    }
  };

  // Profile picture change - creates tasks for Python to process
  const handleBulkProfilePicChange = async () => {
    if (selectedIds.size === 0) return;
    
    const selectedAccountIds = Array.from(selectedIds);
    let picturesToUse: { file_url: string }[] = [];
    
    if (selectedPicTagId && materialPictures.length > 0) {
      if (picAssignMode === 'random') {
        picturesToUse = materialPictures.map(p => ({ file_url: p.file_url }));
      } else {
        const selectedPicsList = materialPictures.filter(p => selectedMaterialPics.has(p.id));
        picturesToUse = selectedPicsList.map(p => ({ file_url: p.file_url }));
      }
    }
    
    if (picturesToUse.length === 0) {
      toast.error('Please select a tag with pictures');
      return;
    }
    
    try {
      const tasks = selectedAccountIds.map((accountId, i) => {
        const picIndex = picAssignMode === 'random'
          ? Math.floor(Math.random() * picturesToUse.length)
          : i % picturesToUse.length;
        const picData = picturesToUse[picIndex];
        
        return {
          account_id: accountId,
          task_type: 'change_photo',
          status: 'pending',
          result: JSON.stringify({ photo_url: picData.file_url }),
        };
      });
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      startAccountTaskTracking('Change Photo', selectedAccountIds.length);
      toast.info(`Queued profile picture change for ${selectedAccountIds.length} account(s). Check logs panel for progress.`);
      setSelectedPicTagId('');
      setMaterialPictures([]);
      setSelectedMaterialPics(new Set());
      setIsProfilePicOpen(false);
    } catch (error) {
      console.error('Error queuing profile picture change:', error);
      toast.error('Failed to queue profile picture change');
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

  // Sync profile - fetches latest name, username, avatar from Telegram
  const handleSyncProfile = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      const accountIds = Array.from(selectedIds);
      
      // Delete any existing pending/in_progress sync_profile tasks for these accounts
      // This prevents duplicate tasks if user clicks multiple times
      await supabase
        .from('account_check_tasks')
        .delete()
        .in('account_id', accountIds)
        .eq('task_type', 'sync_profile')
        .in('status', ['pending', 'in_progress']);
      
      const tasks = accountIds.map(accountId => ({
        account_id: accountId,
        task_type: 'sync_profile',
        status: 'pending',
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasks);
      
      if (error) throw error;
      
      startAccountTaskTracking('Sync Profile', selectedIds.size);
      toast.info(`Syncing profile for ${selectedIds.size} account(s). This will fetch latest name, username, and avatar from Telegram.`);
    } catch (error) {
      console.error('Error queuing sync profile:', error);
      toast.error('Failed to queue sync profile');
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
      
      const activeProxies = proxies.filter(p => p.status === 'active');
      
      if (activeProxies.length === 0) {
        toast.error('No active proxies available');
        setIsBulkProxyAssigning(false);
        return;
      }
      
      if (selectedProxyId !== 'auto') {
        // Single proxy to all selected accounts - parallel update
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
        // Random distribution - only for selected accounts
        // Randomly assign available proxies to selected accounts only
        let assignedCount = 0;
        
        for (const accountId of selectedAccountIds) {
          // Pick a random proxy from active proxies
          const randomProxy = activeProxies[Math.floor(Math.random() * activeProxies.length)];
          
          const { error } = await supabase
            .from('telegram_accounts')
            .update({ proxy_id: randomProxy.id })
            .eq('id', accountId);
          
          if (!error) assignedCount++;
        }
        
        toast.success(`Randomly assigned proxies to ${assignedCount} selected account(s)`);
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

  // Remove proxy from account (user-initiated only)
  const handleRemoveProxyFromAccount = async (accountId: string) => {
    try {
      // Get the current account's proxy_id first
      const account = accounts.find(a => a.id === accountId);
      const proxyId = account?.proxyId;

      // Remove proxy_id from account
      const { error: accountError } = await supabase
        .from('telegram_accounts')
        .update({ proxy_id: null, geo_mismatch: false })
        .eq('id', accountId);
      
      if (accountError) throw accountError;

      // Also clear the assigned_account_id from the proxy
      if (proxyId) {
        await supabase
          .from('proxies')
          .update({ assigned_account_id: null })
          .eq('id', proxyId);
      }
      
      toast.success('Proxy removed from account');
      refreshData();
    } catch (error) {
      console.error('Error removing proxy:', error);
      toast.error('Failed to remove proxy');
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


  // Bulk tag assignment - optimized with parallel updates
  const [isTagAssigning, setIsTagAssigning] = useState(false);
  const [tagAssignMode, setTagAssignMode] = useState<'add' | 'replace'>('add');
  
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
          
          // If replace mode, use only new tags; if add mode, merge with existing
          const newTags = tagAssignMode === 'replace' 
            ? tagsToAssign 
            : Array.from(new Set([...existingTags, ...tagsToAssign]));
          
          return supabase
            .from('telegram_accounts')
            .update({ tags: newTags })
            .eq('id', accountId);
        })
      );
      
      const actionText = tagAssignMode === 'replace' ? 'Replaced tags with' : 'Added';
      toast.success(`${actionText} ${tagsToAssign.length} tag(s) on ${selectedIds.size} account(s)`);
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

  // Bulk remove all tags from selected accounts
  const handleBulkRemoveAllTags = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      await Promise.all(
        Array.from(selectedIds).map(accountId =>
          supabase
            .from('telegram_accounts')
            .update({ tags: [] })
            .eq('id', accountId)
        )
      );
      
      toast.success(`Removed all tags from ${selectedIds.size} account(s)`);
      setSelectedIds(new Set());
      refreshData();
    } catch (error) {
      console.error('Error removing tags:', error);
      toast.error('Failed to remove tags');
    }
  };

  // Bulk remove proxies from selected accounts
  const handleBulkRemoveProxy = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      const accountsWithProxy = accounts.filter(a => selectedIds.has(a.id) && a.proxyId);
      
      if (accountsWithProxy.length === 0) {
        toast.info('No selected accounts have proxies assigned');
        return;
      }
      
      // Remove proxy from accounts
      await Promise.all(
        accountsWithProxy.map(async (account) => {
          await supabase
            .from('telegram_accounts')
            .update({ proxy_id: null })
            .eq('id', account.id);
          
          // Also clear assigned_account_id from proxy
          if (account.proxyId) {
            await supabase
              .from('proxies')
              .update({ assigned_account_id: null })
              .eq('id', account.proxyId);
          }
        })
      );
      
      toast.success(`Removed proxy from ${accountsWithProxy.length} account(s)`);
      setSelectedIds(new Set());
      refreshData();
    } catch (error) {
      console.error('Error removing proxies:', error);
      toast.error('Failed to remove proxies');
    }
  };

  // Bulk remove profile pictures from selected accounts (creates tasks)
  const handleBulkRemoveProfilePicture = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      const tasksToInsert = Array.from(selectedIds).map(accountId => ({
        account_id: accountId,
        task_type: 'remove_photo',
        status: 'pending',
      }));
      
      const { error } = await supabase
        .from('account_check_tasks')
        .insert(tasksToInsert);
      
      if (error) throw error;
      
      // Start progress tracking
      setAccountTasksProgress({
        total: selectedIds.size,
        completed: 0,
        failed: 0,
        taskType: 'Remove Profile Picture',
        logs: [],
        startedAt: new Date().toISOString(),
        internalTaskType: 'remove_photo',
      } as any);
      setIsAccountTaskRunning(true);
      setShowAccountTaskLogs(true);
      
      toast.success(`Queued profile picture removal for ${selectedIds.size} account(s)`);
      setSelectedIds(new Set());
    } catch (error) {
      console.error('Error removing profile pictures:', error);
      toast.error('Failed to queue profile picture removal');
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

  // Rename tag across all accounts that have it
  const handleRenameTag = async () => {
    if (!editingTagName || !editedTagValue.trim() || editedTagValue === editingTagName) return;
    
    const oldTagName = editingTagName;
    const newTagValue = editedTagValue.trim();
    
    try {
      // Find all accounts that have this tag
      const accountsWithTag = accounts.filter(a => (a.tags || []).includes(oldTagName));
      
      if (accountsWithTag.length === 0) {
        toast.error('No accounts found with this tag');
        return;
      }
      
      // Update each account's tags - replace old tag with new tag
      for (const account of accountsWithTag) {
        const updatedTags = (account.tags || []).map(t => t === oldTagName ? newTagValue : t);
        await supabase
          .from('telegram_accounts')
          .update({ tags: updatedTags })
          .eq('id', account.id);
      }
      
      toast.success(`Tag renamed from "${oldTagName}" to "${newTagValue}" on ${accountsWithTag.length} account(s)`);
      setEditingTagName('');
      setEditedTagValue('');
      refreshData();
    } catch (error) {
      console.error('Error renaming tag:', error);
      toast.error('Failed to rename tag');
    }
  };

  // Delete tag from all accounts
  const handleDeleteTag = async (tagToDelete: string) => {
    try {
      // Find all accounts that have this tag
      const accountsWithTag = accounts.filter(a => (a.tags || []).includes(tagToDelete));
      
      if (accountsWithTag.length === 0) {
        toast.error('No accounts found with this tag');
        return;
      }
      
      // Remove tag from each account
      for (const account of accountsWithTag) {
        const updatedTags = (account.tags || []).filter(t => t !== tagToDelete);
        await supabase
          .from('telegram_accounts')
          .update({ tags: updatedTags })
          .eq('id', account.id);
      }
      
      toast.success(`Tag "${tagToDelete}" removed from ${accountsWithTag.length} account(s)`);
      setEditingTagName('');
      setEditedTagValue('');
      setSelectedTagsForBulk(prev => prev.filter(t => t !== tagToDelete));
      refreshData();
    } catch (error) {
      console.error('Error deleting tag:', error);
      toast.error('Failed to delete tag');
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
    
    const matchesTag = 
      tagFilter === 'all' ? true :
      tagFilter === 'no_tags' ? (!acc.tags || acc.tags.length === 0) : 
      (acc.tags || []).includes(tagFilter);
    
    const matchesProxy = 
      proxyFilter === 'all' || 
      (proxyFilter === 'with_proxy' && acc.proxyId) ||
      (proxyFilter === 'without_proxy' && !acc.proxyId);
    
    // Profile is "synced" if it has telegram_id and first_name (basic profile data)
    const isProfileSynced = acc.telegramId && acc.firstName;
    const matchesProfile = 
      profileFilter === 'all' || 
      (profileFilter === 'synced' && isProfileSynced) ||
      (profileFilter === 'not_synced' && !isProfileSynced);
    
    return matchesSearch && matchesStatus && matchesTag && matchesProxy && matchesProfile;
  });

  // Split accounts by status
  // Helper to check if account is spambot limited (should be in restricted)
  const isSpambotLimited = (a: TelegramAccount) => 
    a.spambotStatus === 'limited' || a.spambotStatus === 'restricted';
  
  // Helper to check if account has a future restrictedUntil date (temporarily restricted)
  const isTemporarilyRestricted = (a: TelegramAccount) => {
    if (!a.restrictedUntil) return false;
    const restrictedTime = a.restrictedUntil instanceof Date 
      ? a.restrictedUntil.getTime() 
      : new Date(a.restrictedUntil).getTime();
    return restrictedTime > Date.now();
  };

  const accountsByStatus = {
    // Active: accounts with status 'active' that are not temporarily restricted
    active: filteredAccounts.filter(a => 
      a.status === 'active' && !isTemporarilyRestricted(a)
    ),
    // Restricted: includes status restricted/cooldown AND temporarily restricted
    restricted: filteredAccounts.filter(a => 
      a.status === 'restricted' || 
      a.status === 'cooldown' || 
      (a.status === 'active' && isTemporarilyRestricted(a)) // Active but has countdown timer
    ),
    inactive: filteredAccounts.filter(a => 
      a.status === 'banned' || 
      a.status === 'disconnected' ||
      a.status === 'frozen'
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

  const getProxyCountry = (proxyId?: string) => {
    if (!proxyId) return null;
    const proxy = proxies.find(p => p.id === proxyId);
    return proxy?.country || null;
  };

  // Convert country code to flag emoji
  const countryToFlag = (countryCode: string | null) => {
    if (!countryCode) return '🌐';
    const code = countryCode.toUpperCase();
    // Convert country code to regional indicator symbols
    if (code.length === 2) {
      const offset = 127397;
      return String.fromCodePoint(...[...code].map(c => c.charCodeAt(0) + offset));
    }
    return '🌐';
  };

  // Calculate stats - frozen/banned are always inactive, spambot limited = restricted
  const isAccountSpambotLimited = (a: TelegramAccount) => 
    a.spambotStatus === 'limited' || a.spambotStatus === 'restricted';
  
  const isAccountTemporarilyRestricted = (a: TelegramAccount) => {
    if (!a.restrictedUntil) return false;
    const restrictedTime = a.restrictedUntil instanceof Date 
      ? a.restrictedUntil.getTime() 
      : new Date(a.restrictedUntil).getTime();
    return restrictedTime > Date.now();
  };
  
  const stats = {
    total: accounts.length,
    active: accounts.filter(a => 
      a.status === 'active' && 
      !isAccountTemporarilyRestricted(a)
    ).length,
    restricted: accounts.filter(a => 
      a.status === 'restricted' || 
      a.status === 'cooldown' ||
      (a.status === 'active' && isAccountTemporarilyRestricted(a))
    ).length,
    inactive: accounts.filter(a => 
      a.status === 'banned' || 
      a.status === 'disconnected' ||
      a.status === 'frozen'
    ).length,
  };

  const renderAccountCard = (account: TelegramAccount) => {
    const verifyResult = verifyResults.get(account.id);
    const proxyLabel = getProxyLabel(account.proxyId);
    const proxyStatus = getProxyStatus(account.proxyId);
    const proxyCountry = getProxyCountry(account.proxyId);
    const proxyFlag = countryToFlag(proxyCountry);
    const msgSentToday = account.messagesSentToday || 0; // Use actual DB field
    const convStats = uniqueConversations.get(account.id) || { total: 0, withReplies: 0 };
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
              account.status === 'frozen' && "bg-blue-500/15 text-blue-500",
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
            account.status === 'frozen' && "bg-blue-500",
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
              <CheckCircle className="w-3.5 h-3.5 text-status-active" />
            )}
            
            {/* Banned Badge - Telegram banned accounts only */}
            {account.status === 'banned' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-status-banned text-white text-[10px] font-semibold animate-pulse">
                <XCircle className="w-3 h-3" />
                BANNED
              </span>
            )}
            
            {/* Frozen Badge - Account frozen by Telegram */}
            {account.status === 'frozen' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500 text-white text-[10px] font-semibold">
                <AlertTriangle className="w-3 h-3" />
                FROZEN
              </span>
            )}
            
            {/* Restricted Badge - Rate limited (24h cooldown) or has active restrictedUntil - but NOT for frozen/banned/disconnected */}
            {account.status !== 'frozen' && account.status !== 'banned' && account.status !== 'disconnected' && 
             (account.status === 'restricted' || (account.restrictedUntil && (account.restrictedUntil instanceof Date ? account.restrictedUntil.getTime() : new Date(account.restrictedUntil).getTime()) > Date.now())) && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-status-restricted text-white text-[10px] font-semibold">
                <AlertTriangle className="w-3 h-3" />
                RESTRICTED
              </span>
            )}
            
            {/* Disconnected Badge - different labels based on reason */}
            {account.status === 'disconnected' && (
              <>
                {account.banReason?.toLowerCase().includes('timeout') ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500 text-white text-[10px] font-semibold">
                    <Clock className="w-3 h-3" />
                    CONNECTION TIMEOUT
                  </span>
                ) : account.banReason?.toLowerCase().includes('session') ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500 text-white text-[10px] font-semibold">
                    <AlertTriangle className="w-3 h-3" />
                    SESSION EXPIRED
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-status-disconnected text-white text-[10px] font-semibold">
                    <WifiOff className="w-3 h-3" />
                    OFFLINE
                  </span>
                )}
              </>
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
            
            {/* Health Badge - Success rate indicator */}
            {(account.successCount !== undefined || account.failureCount !== undefined) && 
             ((account.successCount || 0) + (account.failureCount || 0)) >= 3 && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border",
                      account.autoDisabled 
                        ? "bg-destructive/20 text-destructive border-destructive/30"
                        : (account.successRate ?? 100) >= 80 
                          ? "bg-green-500/15 text-green-600 border-green-500/30"
                          : (account.successRate ?? 100) >= 50 
                            ? "bg-yellow-500/15 text-yellow-600 border-yellow-500/30"
                            : "bg-red-500/15 text-red-600 border-red-500/30"
                    )}>
                      {account.autoDisabled ? (
                        <>
                          <XCircle className="w-3 h-3" />
                          Disabled
                        </>
                      ) : (
                        `${Math.round(account.successRate ?? 100)}%`
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">
                      {account.autoDisabled ? 'Auto-Disabled' : 'Account Health'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {account.successCount || 0} sent, {account.failureCount || 0} failed
                    </p>
                    {account.disabledReason && (
                      <p className="text-xs text-destructive">{account.disabledReason}</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="flex flex-col text-xs text-muted-foreground mt-0.5">
            {(account.firstName || account.lastName) && (
              <span>{account.firstName || ''} {account.lastName || ''}</span>
            )}
            {account.username && !account.username.includes('update_state') && (
              <span className="text-primary/70">@{account.username}</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
            {/* Show countdown for temporary restrictions (restricted OR frozen with timer) */}
            {account.restrictedUntil && 
             new Date(account.restrictedUntil) > new Date() && 
             account.status !== 'banned' && (
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
            <div className="font-medium text-foreground">{getAccountAge(account.createdAt)}d</div>
            <div className="text-muted-foreground">Age</div>
          </div>
          
          {/* Total lifetime messages */}
          {/* Unique conversations (people contacted) */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs",
                  convStats.total > 0 ? "bg-blue-500/10 text-blue-600" : "bg-muted/50 text-muted-foreground"
                )}>
                  <Users className="w-3 h-3" />
                  <span className="font-medium">{convStats.total}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">Unique Conversations: {convStats.total}</p>
                <p className="text-xs text-muted-foreground">{convStats.withReplies} replied ({convStats.total > 0 ? Math.round((convStats.withReplies / convStats.total) * 100) : 0}% reply rate)</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          
          {/* Messages sent today */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded text-xs",
                  msgSentToday > 0 ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground"
                )}>
                  <MessageSquare className="w-3 h-3" />
                  <span className="font-medium">{msgSentToday}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Messages sent today: {msgSentToday} / {account.dailyLimit || 25}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

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
            {account.proxyId && (
              <>
                <DropdownMenuItem onClick={() => handleRemoveProxyFromAccount(account.id)}>
                  <Unlink className="w-4 h-4 mr-2" />
                  Remove Proxy
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
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
        <PageHeader
          title="Accounts"
          description={`Manage your ${stats.total} Telegram accounts`}
          icon={Phone}
          action={
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
                  setUploadTags([]);
                  setNewUploadTag('');
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

                    {sessionFiles.length > 0 && (
                      <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Tag className="w-4 h-4" />
                          Assign Tags (Optional)
                        </div>
                        {availableTags.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {availableTags.map(tag => (
                              <Badge
                                key={tag}
                                variant={uploadTags.includes(tag) ? "default" : "outline"}
                                className="cursor-pointer"
                                onClick={() => {
                                  if (uploadTags.includes(tag)) {
                                    setUploadTags(prev => prev.filter(t => t !== tag));
                                  } else {
                                    setUploadTags(prev => [...prev, tag]);
                                  }
                                }}
                              >
                                <Tag className="w-3 h-3 mr-1" />
                                {tag}
                                {uploadTags.includes(tag) && <Check className="w-3 h-3 ml-1" />}
                              </Badge>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <Input
                            placeholder="Or enter new tag name..."
                            value={newUploadTag}
                            onChange={(e) => setNewUploadTag(e.target.value)}
                            className="h-8 text-sm"
                          />
                        </div>
                        {(uploadTags.length > 0 || newUploadTag.trim()) && (
                          <p className="text-xs text-muted-foreground">
                            {uploadTags.length + (newUploadTag.trim() ? 1 : 0)} tag(s) will be assigned to {sessionFiles.length} account(s)
                          </p>
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
          }
        />

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

        {/* Bulk Actions Bar - Always visible */}
        <Card className={cn("transition-colors", selectedIds.size > 0 ? "border-primary/30 bg-primary/5" : "")}>
          <CardContent className="p-3">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="secondary" className="font-medium">
                {selectedIds.size} selected
              </Badge>
              
              <Separator orientation="vertical" className="h-6" />
              
              <Button variant="outline" size="sm" onClick={handleSyncProfile} disabled={isAccountTaskRunning || selectedIds.size === 0} className="gap-1.5">
                {isAccountTaskRunning && accountTasksProgress.taskType === 'Sync Profile' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Sync Profile
              </Button>
              
              <Button variant="outline" size="sm" onClick={handleBulkCheck} disabled={isBulkChecking || selectedIds.size === 0} className="gap-1.5">
                {isBulkChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
                Session Check
              </Button>
              
              
              <Button variant="outline" size="sm" onClick={handleSpamBotCheck} disabled={isSpamBotChecking || selectedIds.size === 0} className="gap-1.5">
                <Shield className="w-3.5 h-3.5" />
                SpamBot
              </Button>
              
              <Button variant="outline" size="sm" onClick={handleExportSessions} disabled={isExporting || selectedIds.size === 0} className="gap-1.5">
                {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Export
              </Button>
              

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5" disabled={selectedIds.size === 0}>
                    <Settings className="w-3.5 h-3.5" />
                    Actions
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onClick={() => { setIsBulkNameOpen(true); fetchNameTags(); }}>
                    <UserCircle className="w-4 h-4 mr-2" />
                    Change Name
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setIsProfilePicOpen(true); fetchPictureTags(); }}>
                    <Image className="w-4 h-4 mr-2" />
                    Change Profile Picture
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
                  <DropdownMenuItem onClick={handleBulkRemoveAllTags} className="text-orange-600">
                    <X className="w-4 h-4 mr-2" />
                    Remove All Tags
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setIsBulkProxyOpen(true)}>
                    <Globe className="w-4 h-4 mr-2" />
                    Assign Proxy
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleBulkRemoveProxy} className="text-orange-600">
                    <Unlink className="w-4 h-4 mr-2" />
                    Remove Proxy
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
              
              <Button variant="ghost" size="sm" onClick={() => { setSelectedIds(new Set()); setVerifyResults(new Map()); }} disabled={selectedIds.size === 0}>
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>

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
          
          {/* Unified Filter Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-2">
                <Filter className="w-4 h-4" />
                Filters
                {(tagFilter !== 'all' || proxyFilter !== 'all' || profileFilter !== 'all') && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
                    {[tagFilter !== 'all', proxyFilter !== 'all', profileFilter !== 'all'].filter(Boolean).length}
                  </Badge>
                )}
                <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 p-3">
              {/* Tag Filter */}
              <div className="space-y-2 mb-4">
                <Label className="text-xs text-muted-foreground flex items-center gap-2">
                  <Tag className="w-3.5 h-3.5" />
                  Tags
                </Label>
                <Select value={tagFilter} onValueChange={setTagFilter}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="All Tags" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Tags</SelectItem>
                    <SelectItem value="no_tags">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <X className="w-3 h-3" />
                        No Tags
                      </span>
                    </SelectItem>
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
              </div>
              
              {/* Proxy Filter */}
              <div className="space-y-2 mb-4">
                <Label className="text-xs text-muted-foreground flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5" />
                  Proxy
                </Label>
                <Select value={proxyFilter} onValueChange={setProxyFilter}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="All Accounts" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Accounts</SelectItem>
                    <SelectItem value="with_proxy">
                      <span className="flex items-center gap-2">
                        <Link2 className="w-3 h-3 text-green-500" />
                        With Proxy
                      </span>
                    </SelectItem>
                    <SelectItem value="without_proxy">
                      <span className="flex items-center gap-2">
                        <Unlink className="w-3 h-3 text-red-500" />
                        Without Proxy
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {/* Profile Sync Filter */}
              <div className="space-y-2 mb-3">
                <Label className="text-xs text-muted-foreground flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5" />
                  Profile Sync
                </Label>
                <Select value={profileFilter} onValueChange={setProfileFilter}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="All Profiles" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Profiles</SelectItem>
                    <SelectItem value="synced">
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className="w-3 h-3 text-green-500" />
                        Synced
                      </span>
                    </SelectItem>
                    <SelectItem value="not_synced">
                      <span className="flex items-center gap-2">
                        <AlertCircle className="w-3 h-3 text-orange-500" />
                        Not Synced
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {/* Clear Filters */}
              {(tagFilter !== 'all' || proxyFilter !== 'all' || profileFilter !== 'all') && (
                <>
                  <DropdownMenuSeparator className="my-2" />
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="w-full h-8 text-xs"
                    onClick={() => {
                      setTagFilter('all');
                      setProxyFilter('all');
                      setProfileFilter('all');
                    }}
                  >
                    <X className="w-3 h-3 mr-1" />
                    Clear All Filters
                  </Button>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
        <Dialog open={isBulkNameOpen} onOpenChange={(open) => {
          setIsBulkNameOpen(open);
          if (!open) {
            setSelectedNameTagId('');
            setMaterialNames([]);
            setSelectedMaterialNames(new Set());
            setBulkNames('');
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Change Names</DialogTitle>
              <DialogDescription>
                Select names from Material or enter manually. {selectedIds.size} account(s) selected.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              {/* Tag Selection */}
              <div className="space-y-2">
                <Label>Select Name Tag</Label>
                <Select 
                  value={selectedNameTagId} 
                  onValueChange={(v) => {
                    setSelectedNameTagId(v);
                    setSelectedMaterialNames(new Set());
                    if (v) fetchNamesForTag(v);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a tag..." />
                  </SelectTrigger>
                  <SelectContent>
                    {nameTags.map(tag => (
                      <SelectItem key={tag.id} value={tag.id}>
                        {tag.name} ({tag.item_count} names)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Mode Selection */}
              {selectedNameTagId && materialNames.length > 0 && (
                <div className="space-y-2">
                  <Label>Assignment Mode</Label>
                  <RadioGroup value={nameAssignMode} onValueChange={(v) => setNameAssignMode(v as 'random' | 'select')}>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="random" id="name-random" />
                      <Label htmlFor="name-random">Random - Use all names randomly</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="select" id="name-select" />
                      <Label htmlFor="name-select">Select - Choose specific names</Label>
                    </div>
                  </RadioGroup>
                </div>
              )}

              {/* Names List */}
              {isLoadingNames ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : selectedNameTagId && materialNames.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{materialNames.length} names available</Label>
                    {nameAssignMode === 'select' && (
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => {
                          if (selectedMaterialNames.size === materialNames.length) {
                            setSelectedMaterialNames(new Set());
                          } else {
                            setSelectedMaterialNames(new Set(materialNames.map(n => n.id)));
                          }
                        }}
                      >
                        {selectedMaterialNames.size === materialNames.length ? 'Deselect All' : 'Select All'}
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border rounded-lg p-2">
                    {materialNames.map(name => (
                      <div 
                        key={name.id}
                        className={cn(
                          "flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
                          nameAssignMode === 'select' && "hover:bg-muted",
                          selectedMaterialNames.has(name.id) && "bg-primary/10 border border-primary/30"
                        )}
                        onClick={() => {
                          if (nameAssignMode === 'select') {
                            const newSelected = new Set(selectedMaterialNames);
                            if (newSelected.has(name.id)) {
                              newSelected.delete(name.id);
                            } else {
                              newSelected.add(name.id);
                            }
                            setSelectedMaterialNames(newSelected);
                          }
                        }}
                      >
                        {nameAssignMode === 'select' && (
                          <Checkbox checked={selectedMaterialNames.has(name.id)} />
                        )}
                        <Users className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm">{name.first_name} {name.last_name || ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : selectedNameTagId ? (
                <p className="text-sm text-muted-foreground text-center py-4">No names in this tag</p>
              ) : null}

              {/* Manual Input Fallback */}
              {!selectedNameTagId && (
                <div className="space-y-2">
                  <Label>Or Enter Names Manually</Label>
                  <Textarea
                    placeholder="John Doe, Jane Smith&#10;or&#10;John Doe&#10;Jane Smith"
                    value={bulkNames}
                    onChange={(e) => setBulkNames(e.target.value)}
                    rows={4}
                  />
                  <p className="text-xs text-muted-foreground">
                    {bulkNames.split(/[,\n]/).filter(n => n.trim()).length} name(s)
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsBulkNameOpen(false)}>Cancel</Button>
                <Button 
                  onClick={handleBulkNameChange}
                  disabled={
                    (!selectedNameTagId || materialNames.length === 0 || (nameAssignMode === 'select' && selectedMaterialNames.size === 0)) &&
                    !bulkNames.trim()
                  }
                >
                  Queue Name Change
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Profile Picture Change Dialog */}
        <Dialog open={isProfilePicOpen} onOpenChange={(open) => {
          setIsProfilePicOpen(open);
          if (!open) {
            setSelectedPicTagId('');
            setMaterialPictures([]);
            setSelectedMaterialPics(new Set());
          }
        }}>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Change Profile Pictures</DialogTitle>
              <DialogDescription>
                Select pictures from Material. {selectedIds.size} account(s) selected.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              {/* Tag Selection */}
              <div className="space-y-2">
                <Label>Select Picture Tag</Label>
                <Select 
                  value={selectedPicTagId} 
                  onValueChange={(v) => {
                    setSelectedPicTagId(v);
                    setSelectedMaterialPics(new Set());
                    if (v) fetchPicturesForTag(v);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a tag..." />
                  </SelectTrigger>
                  <SelectContent>
                    {pictureTags.map(tag => (
                      <SelectItem key={tag.id} value={tag.id}>
                        {tag.name} ({tag.item_count} pictures)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Mode Selection */}
              {selectedPicTagId && materialPictures.length > 0 && (
                <div className="space-y-2">
                  <Label>Assignment Mode</Label>
                  <RadioGroup value={picAssignMode} onValueChange={(v) => setPicAssignMode(v as 'random' | 'select')}>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="random" id="pic-random" />
                      <Label htmlFor="pic-random">Random - Use all pictures randomly</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="select" id="pic-select" />
                      <Label htmlFor="pic-select">Select - Choose specific pictures</Label>
                    </div>
                  </RadioGroup>
                </div>
              )}

              {/* Pictures Grid */}
              {isLoadingPictures ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : selectedPicTagId && materialPictures.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{materialPictures.length} pictures available</Label>
                    {picAssignMode === 'select' && (
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => {
                          if (selectedMaterialPics.size === materialPictures.length) {
                            setSelectedMaterialPics(new Set());
                          } else {
                            setSelectedMaterialPics(new Set(materialPictures.map(p => p.id)));
                          }
                        }}
                      >
                        {selectedMaterialPics.size === materialPictures.length ? 'Deselect All' : 'Select All'}
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-3 max-h-64 overflow-y-auto border rounded-lg p-3">
                    {materialPictures.map(pic => (
                      <div 
                        key={pic.id}
                        className={cn(
                          "relative aspect-square rounded-lg overflow-hidden cursor-pointer transition-all",
                          picAssignMode === 'select' && "hover:ring-2 hover:ring-primary/50",
                          selectedMaterialPics.has(pic.id) && "ring-2 ring-primary"
                        )}
                        onClick={() => {
                          if (picAssignMode === 'select') {
                            const newSelected = new Set(selectedMaterialPics);
                            if (newSelected.has(pic.id)) {
                              newSelected.delete(pic.id);
                            } else {
                              newSelected.add(pic.id);
                            }
                            setSelectedMaterialPics(newSelected);
                          }
                        }}
                      >
                        <img 
                          src={pic.file_url} 
                          alt={pic.file_name}
                          className="w-full h-full object-cover"
                        />
                        {picAssignMode === 'select' && selectedMaterialPics.has(pic.id) && (
                          <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                            <Check className="w-6 h-6 text-primary" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {picAssignMode === 'select' && (
                    <p className="text-xs text-muted-foreground">
                      {selectedMaterialPics.size} picture(s) selected
                    </p>
                  )}
                </div>
              ) : selectedPicTagId ? (
                <p className="text-sm text-muted-foreground text-center py-4">No pictures in this tag</p>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">Select a tag to view pictures</p>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsProfilePicOpen(false)}>Cancel</Button>
                <Button 
                  onClick={handleBulkProfilePicChange}
                  disabled={
                    !selectedPicTagId || 
                    materialPictures.length === 0 || 
                    (picAssignMode === 'select' && selectedMaterialPics.size === 0)
                  }
                >
                  Queue Picture Change
                </Button>
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
                <Label>Assignment Method</Label>
                <RadioGroup value={selectedProxyId === 'auto' ? 'random' : 'select'} onValueChange={(v) => {
                  if (v === 'random') setSelectedProxyId('auto');
                  else setSelectedProxyId('');
                }}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="random" id="proxy-random" />
                    <Label htmlFor="proxy-random" className="flex items-center gap-2 cursor-pointer">
                      <Shuffle className="w-4 h-4" />
                      Randomly assign from available proxies
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="select" id="proxy-select" />
                    <Label htmlFor="proxy-select" className="cursor-pointer">Select specific proxy</Label>
                  </div>
                </RadioGroup>
              </div>
              
              {selectedProxyId !== 'auto' && (
                <div className="space-y-2">
                  <Label>Select Proxy</Label>
                  <Select value={selectedProxyId} onValueChange={setSelectedProxyId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a proxy" />
                    </SelectTrigger>
                    <SelectContent>
                      {proxies.filter(p => p.status === 'active').map(proxy => {
                        const accountCount = accounts.filter(a => a.proxyId === proxy.id).length;
                        return (
                          <SelectItem key={proxy.id} value={proxy.id}>
                            <div className="flex items-center justify-between w-full gap-4">
                              <span>{proxy.host}:{proxy.port} {proxy.country && `(${proxy.country})`}</span>
                              <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                                {accountCount} account{accountCount !== 1 ? 's' : ''}
                              </span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
              
              {selectedProxyId === 'auto' && (
                <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                  <span className="font-medium">Smart Distribution:</span> Proxies will be distributed evenly. 
                  If you have more accounts than proxies, some proxies will get 2 accounts.
                </p>
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
              <DialogTitle>Manage Tags</DialogTitle>
              <DialogDescription>
                Add tags to {selectedIds.size} selected account(s) or rename existing tags
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              {/* Existing tags to select or rename */}
              {availableTags.length > 0 && (
                <div className="space-y-2">
                  <Label>Select Existing Tags</Label>
                  <div className="flex flex-wrap gap-2">
                    {availableTags.map(tag => (
                      <div key={tag} className="flex items-center gap-1">
                        <Badge
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
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingTagName(tag);
                            setEditedTagValue(tag);
                          }}
                        >
                          <Settings className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Rename tag input */}
              {editingTagName && (
                <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
                  <Label>Edit Tag: "{editingTagName}"</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="New tag name..."
                      value={editedTagValue}
                      onChange={(e) => setEditedTagValue(e.target.value)}
                      className="flex-1"
                    />
                    <Button 
                      size="sm" 
                      onClick={handleRenameTag}
                      disabled={!editedTagValue.trim() || editedTagValue === editingTagName}
                    >
                      Rename
                    </Button>
                    <Button 
                      size="sm" 
                      variant="destructive"
                      onClick={() => handleDeleteTag(editingTagName)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                    <Button 
                      size="sm" 
                      variant="ghost"
                      onClick={() => { setEditingTagName(''); setEditedTagValue(''); }}
                    >
                      Cancel
                    </Button>
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
              
              {/* Add vs Replace Mode */}
              <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
                <Label>Assignment Mode</Label>
                <RadioGroup 
                  value={tagAssignMode} 
                  onValueChange={(v) => setTagAssignMode(v as 'add' | 'replace')}
                  className="flex gap-4"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="add" id="tag-add" />
                    <Label htmlFor="tag-add" className="font-normal cursor-pointer">
                      Add to existing tags
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="replace" id="tag-replace" />
                    <Label htmlFor="tag-replace" className="font-normal cursor-pointer">
                      Replace all tags
                    </Label>
                  </div>
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  {tagAssignMode === 'add' 
                    ? 'Selected tags will be added to accounts\' existing tags' 
                    : 'All existing tags will be removed and replaced with selected tags'}
                </p>
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setIsTagDialogOpen(false); setNewTagName(''); setSelectedTagsForBulk([]); setEditingTagName(''); setEditedTagValue(''); }}>
                  Cancel
                </Button>
                <Button onClick={handleBulkTagAssign} disabled={isTagAssigning || (selectedTagsForBulk.length === 0 && !newTagName.trim())}>
                  {isTagAssigning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Tag className="w-4 h-4 mr-2" />}
                  {isTagAssigning ? 'Assigning...' : tagAssignMode === 'replace' ? 'Replace Tags' : 'Add Tags'}
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
