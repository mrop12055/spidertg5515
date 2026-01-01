import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { 
  Settings as SettingsIcon, 
  Bell, 
  Shield, 
  Clock, 
  MessageSquare,
  Save,
  Download,
  Zap,
  RotateCcw,
  Trash2,
  Calendar,
  Loader2,
  Smartphone,
  Monitor,
  RefreshCw,
  Key,
  Plus,
  X,
  Globe,
  Flame,
  Link2,
  AlertTriangle,
  Users,
  MessageCircle,
  Play
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ApiCredential {
  id: string;
  name: string;
  api_id: string;
  api_hash: string;
  client_type: string;
  accounts_count: number;
  is_active: boolean;
}

const Settings: React.FC = () => {
  const { toast: showToast } = useToast();
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  
  const [settings, setSettings] = useState({
    dailyMessageLimit: 10,
    messageCooldown: 60,
    autoRestartBanned: false,
    notifyOnReply: true,
    notifyOnBan: true,
    maturationAutoRun: false,
    proxyRotation: false,
    autoCleanupDays: 7,
    warmupDays: 14,
    blockFirstMessageLinks: true,
    warnFirstMessageLinks: true,
    enforceProxyMapping: true,
    requireGeoMatch: false,
  });

  // Python script scheduler settings
  const [schedulerSettings, setSchedulerSettings] = useState({
    enabled: true,
    maxMessagesBeforeRotation: 10,
    cooldownDuration: 10,
    prioritizeHighMaturity: true,
    autoSkipRestricted: true,
    balanceLoad: true,
    messagesPerAccount: 10,
    messageInterval: 3,
    accountSwitchDelay: 5,
  });

  // API credentials distribution
  const [apiCredentials, setApiCredentials] = useState<ApiCredential[]>([]);
  const [isLoadingCredentials, setIsLoadingCredentials] = useState(true);
  const [isRedistributing, setIsRedistributing] = useState(false);
  const [totalAccounts, setTotalAccounts] = useState(0);
  
  // Add API credential dialog
  const [isAddApiOpen, setIsAddApiOpen] = useState(false);
  const [newApiName, setNewApiName] = useState('');
  const [newApiId, setNewApiId] = useState('');
  const [newApiHash, setNewApiHash] = useState('');
  const [newApiType, setNewApiType] = useState<string>('android');
  const [isAddingApi, setIsAddingApi] = useState(false);
  
  // Warmup & Geo states
  const [isSchedulingWarmup, setIsSchedulingWarmup] = useState(false);
  const [isDetectingCountry, setIsDetectingCountry] = useState(false);
  const [isRunningSpamBotCheck, setIsRunningSpamBotCheck] = useState(false);
  const [lastSpamBotResult, setLastSpamBotResult] = useState<{ scheduled: number; restricted: number } | null>(null);
  const [isEnforcingProxy, setIsEnforcingProxy] = useState(false);
  const [isLoadingStats, setIsLoadingStats] = useState(true);
  const [antiBotStats, setAntiBotStats] = useState<{
    phase1_api_distribution: { total_api_credentials: number; active_api_credentials: number; accounts_per_api: number };
    phase2_proxy_mapping: { total_accounts: number; accounts_with_proxy: number; accounts_without_proxy: number; total_proxies: number; shared_proxies_violations: number; mapping_coverage: number };
    phase3_warmup: { accounts_in_warmup: number; accounts_warmup_complete: number; pending_warmup_tasks: number };
    phase4_spambot: { clean: number; limited: number; restricted: number; unknown: number; pending_checks: number };
    phase5_first_message: { new_contact_conversations: number };
    phase6_geo_consistency: { geo_matched: number; geo_mismatches: number; match_rate: number; proxies_with_country: number };
    phase7_interactions: { pending: number; completed: number };
  } | null>(null);

  // Schedule warmup tasks
  const handleScheduleWarmup = async () => {
    setIsSchedulingWarmup(true);
    try {
      const { data, error } = await supabase.functions.invoke('schedule-warmup-tasks');
      if (error) throw error;
      toast.success(`Scheduled ${data.scheduled} warmup tasks for ${data.accounts_processed} accounts`);
    } catch (error) {
      console.error('Warmup scheduling failed:', error);
      toast.error('Failed to schedule warmup tasks');
    } finally {
      setIsSchedulingWarmup(false);
    }
  };

  // Detect proxy countries
  const handleDetectProxyCountry = async () => {
    setIsDetectingCountry(true);
    try {
      const { data, error } = await supabase.functions.invoke('detect-proxy-country');
      if (error) throw error;
      toast.success(`Detected country for ${data.detected}/${data.checked} proxies. ${data.geo_mismatches} geo mismatches found.`);
    } catch (error) {
      console.error('Country detection failed:', error);
      toast.error('Failed to detect proxy countries');
    } finally {
      setIsDetectingCountry(false);
    }
  };

  // Run SpamBot health check
  const handleRunSpamBotCheck = async () => {
    setIsRunningSpamBotCheck(true);
    try {
      const { data, error } = await supabase.functions.invoke('auto-spambot-check');
      if (error) throw error;
      setLastSpamBotResult({ scheduled: data.scheduled, restricted: data.restricted_accounts });
      if (data.restricted_accounts > 0) {
        toast.warning(`Scheduled ${data.scheduled} checks. ⚠️ ${data.restricted_accounts} accounts are restricted!`);
      } else {
        toast.success(`Scheduled ${data.scheduled} SpamBot checks for ${data.total_accounts} accounts`);
      }
    } catch (error) {
      console.error('SpamBot check failed:', error);
      toast.error('Failed to run SpamBot check');
    } finally {
      setIsRunningSpamBotCheck(false);
    }
  };

  // Fetch anti-bot stats
  const fetchAntiBotStats = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('get-antibot-stats');
      if (error) throw error;
      setAntiBotStats(data.stats);
    } catch (error) {
      console.error('Failed to fetch anti-bot stats:', error);
    } finally {
      setIsLoadingStats(false);
    }
  };

  // Enforce 1:1 proxy mapping
  const handleEnforceProxyMapping = async () => {
    setIsEnforcingProxy(true);
    try {
      const { data, error } = await supabase.functions.invoke('enforce-proxy-mapping');
      if (error) throw error;
      const { stats } = data;
      if (stats.violations.length > 0) {
        toast.warning(`Assigned ${stats.assignments_made} proxies. ${stats.violations.length} issues found.`);
      } else {
        toast.success(`All accounts have dedicated proxies! ${stats.assignments_made} new assignments.`);
      }
      fetchAntiBotStats();
    } catch (error) {
      console.error('Proxy mapping failed:', error);
      toast.error('Failed to enforce proxy mapping');
    } finally {
      setIsEnforcingProxy(false);
    }
  };

  // Fetch API credentials
  const fetchApiCredentials = async () => {
    setIsLoadingCredentials(true);
    try {
      const { data, error } = await supabase
        .from('telegram_api_credentials')
        .select('*')
        .order('client_type');
      
      if (error) throw error;
      setApiCredentials(data || []);

      // Get total accounts
      const { count } = await supabase
        .from('telegram_accounts')
        .select('*', { count: 'exact', head: true });
      setTotalAccounts(count || 0);
    } catch (error) {
      console.error('Failed to fetch API credentials:', error);
    } finally {
      setIsLoadingCredentials(false);
    }
  };

  // Redistribute accounts across API credentials
  const handleRedistribute = async () => {
    setIsRedistributing(true);
    try {
      const { data, error } = await supabase.functions.invoke('redistribute-api-credentials');
      
      if (error) throw error;
      
      toast.success(`Redistributed ${data.assigned} accounts across API credentials`);
      fetchApiCredentials();
    } catch (error) {
      console.error('Redistribution failed:', error);
      toast.error('Failed to redistribute accounts');
    } finally {
      setIsRedistributing(false);
    }
  };

  // Add new API credential
  const handleAddApiCredential = async () => {
    if (!newApiName.trim() || !newApiId.trim() || !newApiHash.trim()) {
      toast.error('Please fill all fields');
      return;
    }
    
    setIsAddingApi(true);
    try {
      const { error } = await supabase
        .from('telegram_api_credentials')
        .insert({
          name: newApiName.trim(),
          api_id: newApiId.trim(),
          api_hash: newApiHash.trim(),
          client_type: newApiType,
          is_active: true,
          accounts_count: 0,
        });
      
      if (error) throw error;
      
      toast.success('API credential added successfully');
      setNewApiName('');
      setNewApiId('');
      setNewApiHash('');
      setNewApiType('android');
      setIsAddApiOpen(false);
      fetchApiCredentials();
    } catch (error) {
      console.error('Failed to add API credential:', error);
      toast.error('Failed to add API credential');
    } finally {
      setIsAddingApi(false);
    }
  };

  // Delete API credential
  const handleDeleteApiCredential = async (id: string) => {
    try {
      // First unassign accounts from this credential
      await supabase
        .from('telegram_accounts')
        .update({ api_credential_id: null })
        .eq('api_credential_id', id);
      
      const { error } = await supabase
        .from('telegram_api_credentials')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      toast.success('API credential deleted');
      fetchApiCredentials();
    } catch (error) {
      console.error('Failed to delete API credential:', error);
      toast.error('Failed to delete API credential');
    }
  };

  useEffect(() => {
    fetchApiCredentials();
    fetchAntiBotStats();
  }, []);

  // Load settings from localStorage
  useEffect(() => {
    const savedSettings = localStorage.getItem('app_settings');
    if (savedSettings) {
      try {
        setSettings(prev => ({ ...prev, ...JSON.parse(savedSettings) }));
      } catch (e) {
        console.error('Failed to load settings');
      }
    }

    const savedScheduler = localStorage.getItem('python_scheduler_settings');
    if (savedScheduler) {
      try {
        setSchedulerSettings(prev => ({ ...prev, ...JSON.parse(savedScheduler) }));
      } catch (e) {
        console.error('Failed to load scheduler settings');
      }
    }
  }, []);

  // Save settings to localStorage
  const updateSettings = (updates: Partial<typeof settings>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    localStorage.setItem('app_settings', JSON.stringify(newSettings));
  };

  const updateSchedulerSettings = (updates: Partial<typeof schedulerSettings>) => {
    const newSettings = { ...schedulerSettings, ...updates };
    setSchedulerSettings(newSettings);
    localStorage.setItem('python_scheduler_settings', JSON.stringify(newSettings));
  };

  // Manual cleanup trigger
  const handleManualCleanup = async () => {
    setIsCleaningUp(true);
    try {
      const { data, error } = await supabase.functions.invoke('cleanup-old-chats');
      
      if (error) throw error;
      
      toast.success(`Cleanup complete: ${data.deleted?.conversations || 0} chats deleted`);
    } catch (error) {
      console.error('Cleanup failed:', error);
      toast.error('Cleanup failed');
    } finally {
      setIsCleaningUp(false);
    }
  };

  // Export settings as JSON
  const handleExportSettings = () => {
    const exportSettings = {
      ...schedulerSettings,
      dailyLimit: settings.dailyMessageLimit,
      warmupDays: settings.warmupDays,
    };
    
    const blob = new Blob([JSON.stringify(exportSettings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scheduler_settings.json';
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success('Settings exported!');
  };

  const handleSave = () => {
    localStorage.setItem('app_settings', JSON.stringify(settings));
    localStorage.setItem('python_scheduler_settings', JSON.stringify(schedulerSettings));
    showToast({
      title: "Settings saved",
      description: "Your settings have been updated successfully.",
    });
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Settings"
        description="Configure your Telegram Hub preferences"
      />

      <div className="max-w-3xl space-y-6">
        {/* API Credentials Distribution */}
        <Card className="border-primary/30">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Key className="w-5 h-5 text-primary" />
                  API Credentials Distribution
                </CardTitle>
                <CardDescription>
                  Accounts are distributed across multiple Telegram API IDs to reduce ban risk
                </CardDescription>
              </div>
              <Dialog open={isAddApiOpen} onOpenChange={setIsAddApiOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="gap-2">
                    <Plus className="w-4 h-4" />
                    Add API
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add API Credential</DialogTitle>
                    <DialogDescription>
                      Add a custom Telegram API ID/Hash pair for account distribution
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 pt-4">
                    <div className="space-y-2">
                      <Label>Name</Label>
                      <Input
                        placeholder="e.g., Custom Android 1"
                        value={newApiName}
                        onChange={(e) => setNewApiName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>API ID</Label>
                      <Input
                        placeholder="e.g., 12345678"
                        value={newApiId}
                        onChange={(e) => setNewApiId(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>API Hash</Label>
                      <Input
                        placeholder="e.g., abc123def456..."
                        value={newApiHash}
                        onChange={(e) => setNewApiHash(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Client Type</Label>
                      <Select value={newApiType} onValueChange={setNewApiType}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="android">Android</SelectItem>
                          <SelectItem value="ios">iOS</SelectItem>
                          <SelectItem value="desktop">Desktop</SelectItem>
                          <SelectItem value="macos">macOS</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button 
                      onClick={handleAddApiCredential} 
                      disabled={isAddingApi}
                      className="w-full"
                    >
                      {isAddingApi ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        'Add API Credential'
                      )}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoadingCredentials ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  {apiCredentials.map((cred) => {
                    const percentage = totalAccounts > 0 
                      ? Math.round((cred.accounts_count / totalAccounts) * 100) 
                      : 0;
                    const iconMap: Record<string, React.ReactNode> = {
                      android: <Smartphone className="w-4 h-4 text-green-500" />,
                      ios: <Smartphone className="w-4 h-4 text-blue-500" />,
                      desktop: <Monitor className="w-4 h-4 text-purple-500" />,
                      macos: <Monitor className="w-4 h-4 text-gray-500" />,
                    };
                    
                    return (
                      <div 
                        key={cred.id} 
                        className="p-4 rounded-lg border bg-card/50 space-y-2 group relative"
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="absolute top-2 right-2 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => handleDeleteApiCredential(cred.id)}
                        >
                          <X className="w-3 h-3 text-destructive" />
                        </Button>
                        <div className="flex items-center justify-between pr-6">
                          <div className="flex items-center gap-2">
                            {iconMap[cred.client_type] || <Smartphone className="w-4 h-4" />}
                            <span className="font-medium text-sm">{cred.name}</span>
                          </div>
                          <Badge variant="outline" className="text-xs">
                            {cred.client_type}
                          </Badge>
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">
                              {cred.accounts_count} accounts
                            </span>
                            <span className="font-medium">{percentage}%</span>
                          </div>
                          <Progress value={percentage} className="h-2" />
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          API ID: {cred.api_id}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {apiCredentials.length > 0 && (
                  <div className="pt-2 space-y-3">
                    <Separator />
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total Accounts</span>
                      <span className="font-medium">{totalAccounts}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Unassigned</span>
                      <span className="font-medium">
                        {totalAccounts - apiCredentials.reduce((sum, c) => sum + c.accounts_count, 0)}
                      </span>
                    </div>
                    <Button 
                      variant="outline" 
                      onClick={handleRedistribute}
                      disabled={isRedistributing}
                      className="w-full"
                    >
                      {isRedistributing ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Redistributing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2" />
                          Redistribute Accounts Evenly
                        </>
                      )}
                    </Button>
                    <p className="text-xs text-muted-foreground text-center">
                      Assigns unassigned accounts and balances distribution across all API IDs
                    </p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Python Script Speed Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Message Sending Settings
            </CardTitle>
            <CardDescription>
              Configure message intervals and account rotation
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <Label>Enable Auto-Rotation</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically rotate between accounts
                </p>
              </div>
              <Switch
                checked={schedulerSettings.enabled}
                onCheckedChange={(checked) => updateSchedulerSettings({ enabled: checked })}
              />
            </div>
            
            <Separator />
            
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Message Interval</Label>
                  <span className="text-sm font-medium">{schedulerSettings.messageInterval}s</span>
                </div>
                <Slider
                  value={[schedulerSettings.messageInterval]}
                  onValueChange={([value]) => updateSchedulerSettings({ messageInterval: value })}
                  min={1}
                  max={60}
                  step={1}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Seconds between each message. Lower = faster but riskier.
                </p>
              </div>
              
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Account Switch Delay</Label>
                  <span className="text-sm font-medium">{schedulerSettings.accountSwitchDelay}s</span>
                </div>
                <Slider
                  value={[schedulerSettings.accountSwitchDelay]}
                  onValueChange={([value]) => updateSchedulerSettings({ accountSwitchDelay: value })}
                  min={1}
                  max={120}
                  step={1}
                />
              </div>
              
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Messages Per Account</Label>
                  <span className="text-sm font-medium">{schedulerSettings.messagesPerAccount}</span>
                </div>
                <Slider
                  value={[schedulerSettings.messagesPerAccount]}
                  onValueChange={([value]) => updateSchedulerSettings({ messagesPerAccount: value })}
                  min={1}
                  max={50}
                  step={1}
                />
              </div>
              
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Cooldown Duration</Label>
                  <span className="text-sm font-medium">{schedulerSettings.cooldownDuration} min</span>
                </div>
                <Slider
                  value={[schedulerSettings.cooldownDuration]}
                  onValueChange={([value]) => updateSchedulerSettings({ cooldownDuration: value })}
                  min={1}
                  max={60}
                  step={1}
                />
              </div>
            </div>
            
            <Separator />
            
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Prioritize high maturity accounts</Label>
                <Switch
                  checked={schedulerSettings.prioritizeHighMaturity}
                  onCheckedChange={(v) => updateSchedulerSettings({ prioritizeHighMaturity: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Auto-skip restricted accounts</Label>
                <Switch
                  checked={schedulerSettings.autoSkipRestricted}
                  onCheckedChange={(v) => updateSchedulerSettings({ autoSkipRestricted: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Balance load across accounts</Label>
                <Switch
                  checked={schedulerSettings.balanceLoad}
                  onCheckedChange={(v) => updateSchedulerSettings({ balanceLoad: v })}
                />
              </div>
            </div>
            
            <Separator />
            
            <Button variant="outline" onClick={handleExportSettings} className="w-full">
              <Download className="w-4 h-4 mr-2" />
              Export Settings for Python Script
            </Button>
          </CardContent>
        </Card>

        {/* Account Limits */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              Account Limits
            </CardTitle>
            <CardDescription>
              Configure default limits for accounts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Daily Message Limit (per account)</Label>
                <span className="text-sm font-medium">{settings.dailyMessageLimit}</span>
              </div>
              <Slider
                value={[settings.dailyMessageLimit]}
                onValueChange={([value]) => updateSettings({ dailyMessageLimit: value })}
                min={5}
                max={50}
                step={1}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Max messages per account per day. Lower = safer.
              </p>
            </div>
            
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Warm-up Days</Label>
                <span className="text-sm font-medium">{settings.warmupDays} days</span>
              </div>
              <Slider
                value={[settings.warmupDays]}
                onValueChange={([value]) => updateSettings({ warmupDays: value })}
                min={1}
                max={14}
                step={1}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Days before new accounts can join campaigns
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Auto Cleanup */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              Auto Cleanup
            </CardTitle>
            <CardDescription>
              Automatically delete old conversations to reduce ban risk
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Auto-delete chats older than</Label>
                <span className="text-sm font-medium">{settings.autoCleanupDays} days</span>
              </div>
              <Slider
                value={[settings.autoCleanupDays]}
                onValueChange={([value]) => updateSettings({ autoCleanupDays: value })}
                min={3}
                max={30}
                step={1}
              />
            </div>
            
            <Separator />
            
            <Button 
              variant="destructive" 
              onClick={handleManualCleanup}
              disabled={isCleaningUp}
              className="w-full"
            >
              {isCleaningUp ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Cleaning up...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Run Cleanup Now
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Safety Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Safety Settings
            </CardTitle>
            <CardDescription>
              Protect your accounts from bans
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-restart banned accounts</Label>
                <p className="text-sm text-muted-foreground">
                  Attempt to reconnect banned accounts after 24h
                </p>
              </div>
              <Switch
                checked={settings.autoRestartBanned}
                onCheckedChange={(checked) => updateSettings({ autoRestartBanned: checked })}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label>Proxy Rotation</Label>
                <p className="text-sm text-muted-foreground">
                  Rotate proxies periodically
                </p>
              </div>
              <Switch
                checked={settings.proxyRotation}
                onCheckedChange={(checked) => updateSettings({ proxyRotation: checked })}
              />
            </div>
          </CardContent>
        </Card>

        {/* 14-Day Warmup System (Phase 3) */}
        <Card className="border-orange-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Flame className="w-5 h-5 text-orange-500" />
              14-Day Warmup System
            </CardTitle>
            <CardDescription>
              Automated daily tasks to build account trust and activity history
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {antiBotStats && (
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="p-3 rounded-lg bg-orange-500/10 text-center">
                  <div className="text-2xl font-bold text-orange-500">{antiBotStats.phase3_warmup.accounts_in_warmup}</div>
                  <div className="text-xs text-muted-foreground">In Warmup</div>
                </div>
                <div className="p-3 rounded-lg bg-green-500/10 text-center">
                  <div className="text-2xl font-bold text-green-500">{antiBotStats.phase3_warmup.accounts_warmup_complete}</div>
                  <div className="text-xs text-muted-foreground">Complete</div>
                </div>
                <div className="p-3 rounded-lg bg-muted/50 text-center">
                  <div className="text-2xl font-bold">{antiBotStats.phase3_warmup.pending_warmup_tasks}</div>
                  <div className="text-xs text-muted-foreground">Pending Tasks</div>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-run warmup tasks</Label>
                <p className="text-sm text-muted-foreground">
                  Join channels, view content, send reactions daily
                </p>
              </div>
              <Switch
                checked={settings.maturationAutoRun}
                onCheckedChange={(checked) => updateSettings({ maturationAutoRun: checked })}
              />
            </div>
            <Separator />
            <Button 
              variant="outline" 
              onClick={handleScheduleWarmup}
              disabled={isSchedulingWarmup}
              className="w-full"
            >
              {isSchedulingWarmup ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Scheduling...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Schedule Today's Warmup Tasks
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Schedules channel joins, content viewing, reactions based on account age
            </p>
          </CardContent>
        </Card>

        {/* SpamBot Health Checks (Phase 4) */}
        <Card className="border-red-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-red-500" />
              SpamBot Health Checks
            </CardTitle>
            <CardDescription>
              Weekly automated checks via @SpamBot to detect restrictions early
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {antiBotStats && (
              <div className="grid grid-cols-4 gap-2 mb-4">
                <div className="p-2 rounded-lg bg-green-500/10 text-center">
                  <div className="text-lg font-bold text-green-500">{antiBotStats.phase4_spambot.clean}</div>
                  <div className="text-[10px] text-muted-foreground">Clean</div>
                </div>
                <div className="p-2 rounded-lg bg-yellow-500/10 text-center">
                  <div className="text-lg font-bold text-yellow-500">{antiBotStats.phase4_spambot.limited}</div>
                  <div className="text-[10px] text-muted-foreground">Limited</div>
                </div>
                <div className="p-2 rounded-lg bg-red-500/10 text-center">
                  <div className="text-lg font-bold text-red-500">{antiBotStats.phase4_spambot.restricted}</div>
                  <div className="text-[10px] text-muted-foreground">Restricted</div>
                </div>
                <div className="p-2 rounded-lg bg-muted/50 text-center">
                  <div className="text-lg font-bold">{antiBotStats.phase4_spambot.unknown}</div>
                  <div className="text-[10px] text-muted-foreground">Unknown</div>
                </div>
              </div>
            )}
            <div className="p-3 rounded-lg bg-muted/50">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Automatic Schedule</span>
                <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/30">
                  Every Sunday 3:00 AM UTC
                </Badge>
              </div>
              {(lastSpamBotResult || antiBotStats) && (
                <div className="mt-2 pt-2 border-t border-border">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Pending Checks</span>
                    <span>{antiBotStats?.phase4_spambot.pending_checks || 0}</span>
                  </div>
                </div>
              )}
            </div>
            <Button 
              variant="outline" 
              onClick={handleRunSpamBotCheck}
              disabled={isRunningSpamBotCheck}
              className="w-full"
            >
              {isRunningSpamBotCheck ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Shield className="w-4 h-4 mr-2" />
                  Run SpamBot Check Now
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Schedules SpamBot checks for all active accounts. Run Python account_manager.py to process.
            </p>
          </CardContent>
        </Card>

        {/* First Message Safety (Phase 5) */}
        <Card className="border-yellow-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              First Message Safety
            </CardTitle>
            <CardDescription>
              Protect accounts when messaging new contacts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Block links in first messages</Label>
                <p className="text-sm text-muted-foreground">
                  Prevent sending URLs to new contacts (high ban risk)
                </p>
              </div>
              <Switch
                checked={settings.blockFirstMessageLinks}
                onCheckedChange={(checked) => updateSettings({ blockFirstMessageLinks: checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Warn about links</Label>
                <p className="text-sm text-muted-foreground">
                  Show warning when campaign contains URLs
                </p>
              </div>
              <Switch
                checked={settings.warnFirstMessageLinks}
                onCheckedChange={(checked) => updateSettings({ warnFirstMessageLinks: checked })}
              />
            </div>
          </CardContent>
        </Card>

        {/* Geographic IP Consistency (Phase 6) */}
        <Card className="border-blue-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="w-5 h-5 text-blue-500" />
              Geographic IP Consistency
            </CardTitle>
            <CardDescription>
              Match proxy locations to phone number countries
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {antiBotStats && (
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="p-3 rounded-lg bg-green-500/10 text-center">
                  <div className="text-2xl font-bold text-green-500">{antiBotStats.phase2_proxy_mapping.accounts_with_proxy}</div>
                  <div className="text-xs text-muted-foreground">With Proxy</div>
                </div>
                <div className="p-3 rounded-lg bg-red-500/10 text-center">
                  <div className="text-2xl font-bold text-red-500">{antiBotStats.phase6_geo_consistency.geo_mismatches}</div>
                  <div className="text-xs text-muted-foreground">Geo Mismatch</div>
                </div>
                <div className="p-3 rounded-lg bg-blue-500/10 text-center">
                  <div className="text-2xl font-bold text-blue-500">{antiBotStats.phase6_geo_consistency.match_rate}%</div>
                  <div className="text-xs text-muted-foreground">Match Rate</div>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <div>
                <Label>Enforce 1:1 proxy mapping</Label>
                <p className="text-sm text-muted-foreground">
                  Each account must have a dedicated proxy
                </p>
              </div>
              <Switch
                checked={settings.enforceProxyMapping}
                onCheckedChange={(checked) => updateSettings({ enforceProxyMapping: checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Require geo-match</Label>
                <p className="text-sm text-muted-foreground">
                  Block messaging if proxy country ≠ phone country
                </p>
              </div>
              <Switch
                checked={settings.requireGeoMatch}
                onCheckedChange={(checked) => updateSettings({ requireGeoMatch: checked })}
              />
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-2">
              <Button 
                variant="outline" 
                onClick={handleEnforceProxyMapping}
                disabled={isEnforcingProxy}
              >
                {isEnforcingProxy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
                Assign Proxies
              </Button>
              <Button 
                variant="outline" 
                onClick={handleDetectProxyCountry}
                disabled={isDetectingCountry}
              >
                {isDetectingCountry ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Globe className="w-4 h-4 mr-2" />}
                Detect Countries
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Bidirectional Interactions (Phase 7) */}
        <Card className="border-purple-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-purple-500" />
              Bidirectional Interactions
            </CardTitle>
            <CardDescription>
              Build trust by having your accounts message each other
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {antiBotStats && (
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="p-3 rounded-lg bg-purple-500/10 text-center">
                  <div className="text-2xl font-bold text-purple-500">{antiBotStats.phase7_interactions.pending}</div>
                  <div className="text-xs text-muted-foreground">Pending</div>
                </div>
                <div className="p-3 rounded-lg bg-green-500/10 text-center">
                  <div className="text-2xl font-bold text-green-500">{antiBotStats.phase7_interactions.completed}</div>
                  <div className="text-xs text-muted-foreground">Completed</div>
                </div>
              </div>
            )}
            <div className="p-3 rounded-lg bg-muted/50 text-xs">
              <p className="font-medium mb-1">How it works:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>Days 1-7: No interactions (building individual history)</li>
                <li>Days 8-14: Accounts start messaging each other</li>
                <li>Replies are scheduled 30min-2hrs later for realism</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5" />
              Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Notify on reply</Label>
                <p className="text-sm text-muted-foreground">
                  Get notified when someone replies
                </p>
              </div>
              <Switch
                checked={settings.notifyOnReply}
                onCheckedChange={(checked) => updateSettings({ notifyOnReply: checked })}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label>Notify on ban</Label>
                <p className="text-sm text-muted-foreground">
                  Get notified when an account gets banned
                </p>
              </div>
              <Switch
                checked={settings.notifyOnBan}
                onCheckedChange={(checked) => updateSettings({ notifyOnBan: checked })}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} className="gap-2">
            <Save className="w-4 h-4" />
            Save Settings
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Settings;
