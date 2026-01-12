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
import { useAppSettings } from '@/hooks/useAppSettings';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Bell, 
  Calendar,
  Loader2,
  Smartphone,
  Monitor,
  Key,
  Plus,
  X,
  Trash2,
  Save,
  Settings as SettingsIcon,
  Upload,
  RefreshCw
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ApiCredential {
  id: string;
  name: string;
  api_id: string;
  api_hash: string;
  client_type: string;
  accounts_count: number;
  is_active: boolean;
  sent_24h?: number; // Dynamic: messages sent in last 24h
  success_rate_24h?: number; // Dynamic: success rate over last 24 hours
  sent_count_24h?: number; // Dynamic: successful sends in last 24 hours
  failed_count_24h?: number; // Dynamic: fails in last 24 hours
}

const API_DAILY_LIMIT = 80; // Max messages per API per 24 hours

const Settings: React.FC = () => {
  const { toast: showToast } = useToast();
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  
  // Use database settings hook
  const { 
    settings: dbSettings, 
    isLoading: isLoadingSettings, 
    isSaving, 
    saveAllSettings, 
    updateSettings: updateDbSettings 
  } = useAppSettings();
  
  // Local UI settings
  const [localSettings, setLocalSettings] = useState({
    notifyOnReply: true,
    notifyOnBan: true,
  });

  // API credentials
  const [apiCredentials, setApiCredentials] = useState<ApiCredential[]>([]);
  const [isLoadingCredentials, setIsLoadingCredentials] = useState(true);
  
  // Add API credential dialog
  const [isAddApiOpen, setIsAddApiOpen] = useState(false);
  const [newApiName, setNewApiName] = useState('');
  const [newApiId, setNewApiId] = useState('');
  const [newApiHash, setNewApiHash] = useState('');
  const [newApiType, setNewApiType] = useState<string>('android');
  const [isAddingApi, setIsAddingApi] = useState(false);
  
  // Bulk API import
  const [isBulkApiOpen, setIsBulkApiOpen] = useState(false);
  const [bulkApiInput, setBulkApiInput] = useState('');
  const [bulkApiType, setBulkApiType] = useState<string>('random');
  const [isImportingBulk, setIsImportingBulk] = useState(false);
  
  // Manual redistribute
  const [isRedistributing, setIsRedistributing] = useState(false);

  // Fetch API credentials with 24h send counts and success rates
  const fetchApiCredentials = async () => {
    setIsLoadingCredentials(true);
    try {
      const { data, error } = await supabase
        .from('telegram_api_credentials')
        .select('*')
        .order('client_type');
      
      if (error) throw error;

      // Get 24h timestamp
      const yesterday = new Date();
      yesterday.setHours(yesterday.getHours() - 24);
      
      // Get campaign recipients from last 24 hours WITH api_credential_id
      // This is the CORRECT source - matches what get-batch-tasks uses for rate limiting
      const { data: recipientsData } = await supabase
        .from('campaign_recipients')
        .select('api_credential_id, status')
        .in('status', ['sent', 'failed'])
        .not('api_credential_id', 'is', null)
        .gte('sent_at', yesterday.toISOString());
      
      // Count 24h sends per API (using campaign_recipients - matches backend logic)
      const apiSentCounts = new Map<string, number>();
      const apiFailed = new Map<string, number>();
      (recipientsData || []).forEach((rec: any) => {
        if (rec.api_credential_id) {
          if (rec.status === 'sent') {
            apiSentCounts.set(rec.api_credential_id, (apiSentCounts.get(rec.api_credential_id) || 0) + 1);
          } else if (rec.status === 'failed') {
            apiFailed.set(rec.api_credential_id, (apiFailed.get(rec.api_credential_id) || 0) + 1);
          }
        }
      });
      
      // Merge counts into credentials
      const credentialsWithCounts = (data || []).map((cred: ApiCredential) => {
        const sent = apiSentCounts.get(cred.id) || 0;
        const failed = apiFailed.get(cred.id) || 0;
        const total = sent + failed;
        const successRate = total > 0 ? (sent / total) * 100 : null;
        
        return {
          ...cred,
          sent_24h: sent,  // Use campaign_recipients count (matches backend rate limiting)
          success_rate_24h: successRate,
          sent_count_24h: sent,
          failed_count_24h: failed,
        };
      });
      
      setApiCredentials(credentialsWithCounts);
    } catch (error) {
      console.error('Failed to fetch API credentials:', error);
    } finally {
      setIsLoadingCredentials(false);
    }
  };


  // Add new API credential with auto-redistribution
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
      
      toast.success('API credential added! Auto-redistributing accounts...');
      setNewApiName('');
      setNewApiId('');
      setNewApiHash('');
      setNewApiType('android');
      setIsAddApiOpen(false);
      
      // Auto-redistribute accounts to include the new API
      try {
        const { data, error: redistError } = await supabase.functions.invoke('redistribute-api-credentials');
        if (redistError) {
          console.error('Auto-redistribution failed:', redistError);
          toast.error('API added but auto-redistribution failed. Please redistribute manually.');
        } else {
          toast.success(`Accounts redistributed! ${data?.assigned || 0} accounts assigned across all APIs.`);
        }
      } catch (redistErr) {
        console.error('Auto-redistribution error:', redistErr);
        toast.error('API added but auto-redistribution failed.');
      }
      
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

  // Generate random name for API
  const generateRandomName = (index: number) => {
    const adjectives = ['Swift', 'Rapid', 'Quick', 'Fast', 'Prime', 'Ultra', 'Super', 'Mega', 'Turbo', 'Hyper'];
    const nouns = ['Thunder', 'Storm', 'Wave', 'Flash', 'Bolt', 'Star', 'Nova', 'Pulse', 'Stream', 'Flow'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 900) + 100;
    return `${adj}${noun}_${num}`;
  };

  // Predefined API credentials for each device type
  const deviceApiCredentials: Record<string, { api_id: string; api_hash: string }> = {
    android: { api_id: '2040', api_hash: 'b18441a1ff607e10a989891a5462e627' },
    ios: { api_id: '21724', api_hash: '3e0cb5efcd52300aec5994fdfc5bdc16' },
    desktop: { api_id: '2496', api_hash: '8da85b0d5bfe62527e5b244c209159c3' },
    macos: { api_id: '2834', api_hash: '68875f756c9b437a8b916ca3de215571' },
  };

  // Generate random device type
  const getRandomDeviceType = () => {
    const types = ['android', 'ios', 'desktop', 'macos'];
    return types[Math.floor(Math.random() * types.length)];
  };

  // Bulk import API credentials
  const handleBulkImport = async () => {
    const lines = bulkApiInput.trim().split('\n').filter(line => line.trim());
    if (lines.length === 0) {
      toast.error('Please enter at least one API hash');
      return;
    }
    
    setIsImportingBulk(true);
    let successCount = 0;
    let failCount = 0;
    
    try {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        let apiId: string;
        let apiHash: string;
        let deviceType: string;
        
        if (bulkApiType === 'random') {
          // Custom mode - parse api_id:api_hash format
          const parts = line.split(/[,:]/);
          if (parts.length >= 2) {
            apiId = parts[0].trim();
            apiHash = parts[1].trim();
            deviceType = getRandomDeviceType();
          } else {
            failCount++;
            continue;
          }
        } else {
          // Device selected - use predefined api_id, user provides api_hash only
          const creds = deviceApiCredentials[bulkApiType];
          if (!creds) {
            failCount++;
            continue;
          }
          apiId = creds.api_id;
          apiHash = line; // User only enters api_hash
          deviceType = bulkApiType;
        }
        
        if (apiId && apiHash) {
          const randomName = generateRandomName(i);
          
          const { error } = await supabase
            .from('telegram_api_credentials')
            .insert({
              name: randomName,
              api_id: apiId,
              api_hash: apiHash,
              client_type: deviceType,
              is_active: true,
              accounts_count: 0,
            });
          
          if (error) {
            console.error('Failed to add API:', error);
            failCount++;
          } else {
            successCount++;
          }
        } else {
          failCount++;
        }
      }
      
      if (successCount > 0) {
        toast.success(`Added ${successCount} API credentials${failCount > 0 ? `, ${failCount} failed` : ''}`);
        setBulkApiInput('');
        setIsBulkApiOpen(false);
        
        // Auto-redistribute after bulk import
        try {
          const { data } = await supabase.functions.invoke('redistribute-api-credentials');
          toast.success(`Accounts redistributed! ${data?.assigned || 0} accounts assigned.`);
        } catch (err) {
          console.error('Auto-redistribution failed:', err);
        }
        
        fetchApiCredentials();
      } else {
        toast.error('Failed to add any API credentials');
      }
    } catch (error) {
      console.error('Bulk import error:', error);
      toast.error('Bulk import failed');
    } finally {
      setIsImportingBulk(false);
    }
  };

  // Manual redistribute
  const handleManualRedistribute = async () => {
    setIsRedistributing(true);
    toast.info('Redistributing accounts... This may take up to 60 seconds for large account sets.');
    try {
      // Use fetch with longer timeout for large account sets
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/redistribute-api-credentials`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      
      const data = await response.json();
      toast.success(`Redistributed! ${data?.assigned || 0} accounts assigned across ${data?.distribution?.length || 0} APIs.`);
      await fetchApiCredentials();
    } catch (error) {
      console.error('Redistribute failed:', error);
      toast.error(`Failed to redistribute: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsRedistributing(false);
    }
  };

  // Auto-redistribute based on least usage every 1 minute
  const triggerAutoRedistribution = async () => {
    try {
      console.log('[Settings] Auto-triggering redistribution based on least usage...');
      await supabase.functions.invoke('redistribute-api-credentials');
      await fetchApiCredentials();
    } catch (err) {
      console.error('[Settings] Auto-redistribution failed:', err);
    }
  };

  useEffect(() => {
    fetchApiCredentials();
    
    // Auto-redistribute every 1 minute based on least API usage
    const interval = setInterval(() => {
      triggerAutoRedistribution();
    }, 60000); // 60 seconds = 1 minute
    
    return () => clearInterval(interval);
  }, []);

  // Load local settings from localStorage
  useEffect(() => {
    const savedLocal = localStorage.getItem('local_ui_settings');
    if (savedLocal) {
      try {
        setLocalSettings(prev => ({ ...prev, ...JSON.parse(savedLocal) }));
      } catch (e) {
        console.error('Failed to load local settings');
      }
    }
  }, []);

  // Helper to update cleanup settings
  const updateCleanupSettings = (updates: Partial<typeof dbSettings.cleanup>) => {
    updateDbSettings('cleanup', updates);
  };

  // Update local UI settings
  const updateLocalSettings = (updates: Partial<typeof localSettings>) => {
    const newSettings = { ...localSettings, ...updates };
    setLocalSettings(newSettings);
    localStorage.setItem('local_ui_settings', JSON.stringify(newSettings));
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

  const handleSave = async () => {
    const saved = await saveAllSettings(dbSettings);
    if (saved) {
      localStorage.setItem('local_ui_settings', JSON.stringify(localSettings));
      showToast({
        title: "Settings saved",
        description: "Your settings have been saved to database.",
      });
    }
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Settings"
        description="Configure your system preferences"
        icon={SettingsIcon}
      />

      <div className="max-w-4xl">
        {/* Loading indicator for database settings */}
        {isLoadingSettings && (
          <Card className="border-primary/30 mb-6">
            <CardContent className="flex items-center justify-center py-8">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-muted-foreground">Loading settings...</span>
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="api" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 h-11">
            <TabsTrigger value="api" className="gap-2">
              <Key className="w-4 h-4" />
              API Credentials
            </TabsTrigger>
            <TabsTrigger value="cleanup" className="gap-2">
              <Calendar className="w-4 h-4" />
              Cleanup
            </TabsTrigger>
            <TabsTrigger value="notifications" className="gap-2">
              <Bell className="w-4 h-4" />
              Notifications
            </TabsTrigger>
          </TabsList>

          {/* API Credentials Tab */}
          <TabsContent value="api" className="space-y-4 mt-0">

        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="text-lg">API Credentials Distribution</CardTitle>
                <CardDescription>
                  Distribute accounts across multiple API IDs to reduce ban risk
                </CardDescription>
              </div>
              <div className="flex gap-2">
                {/* Manual Redistribute Button */}
                <Button 
                  size="sm" 
                  variant="outline" 
                  className="gap-2"
                  onClick={handleManualRedistribute}
                  disabled={isRedistributing}
                >
                  {isRedistributing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  Redistribute
                </Button>

                {/* Bulk Import Dialog */}
                <Dialog open={isBulkApiOpen} onOpenChange={setIsBulkApiOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" className="gap-2">
                      <Upload className="w-4 h-4" />
                      Bulk Import
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Bulk Import API Credentials</DialogTitle>
                      <DialogDescription>
                        Select a device type and enter API hashes (one per line). API ID is auto-filled.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 pt-4">
                      <div className="space-y-2">
                        <Label>Device Type</Label>
                        <Select 
                          value={bulkApiType} 
                          onValueChange={(value) => {
                            setBulkApiType(value);
                            setBulkApiInput('');
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="android">📱 Android (API ID: 2040)</SelectItem>
                            <SelectItem value="ios">🍎 iOS (API ID: 21724)</SelectItem>
                            <SelectItem value="desktop">🖥️ Desktop (API ID: 2496)</SelectItem>
                            <SelectItem value="macos">💻 macOS (API ID: 2834)</SelectItem>
                            <SelectItem value="random">🎲 Custom (enter api_id:api_hash)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      
                      <div className="space-y-2">
                        <Label>{bulkApiType === 'random' ? 'API Credentials' : 'API Hashes'}</Label>
                        <Textarea
                          placeholder={bulkApiType === 'random' 
                            ? "12345678:a1b2c3d4e5f6g7h8i9j0\n87654321:k1l2m3n4o5p6q7r8s9t0"
                            : "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6\nq7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2"
                          }
                          value={bulkApiInput}
                          onChange={(e) => {
                            const text = e.target.value;
                            if (bulkApiType === 'random') {
                              setBulkApiInput(text);
                            } else {
                              // Device mode - extract API hashes from text
                              const lines = text.split('\n');
                              const hashes: string[] = [];
                              
                              for (const line of lines) {
                                // First try to find UUID format (8-4-4-4-12 with dashes) and remove dashes
                                const uuidMatch = line.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi);
                                if (uuidMatch) {
                                  uuidMatch.forEach(uuid => {
                                    hashes.push(uuid.replace(/-/g, ''));
                                  });
                                } else {
                                  // Fallback to finding 32 consecutive hex chars
                                  const hexMatch = line.match(/[a-f0-9]{32}/gi);
                                  if (hexMatch) {
                                    hashes.push(...hexMatch);
                                  }
                                }
                              }
                              
                              if (hashes.length > 0) {
                                setBulkApiInput(hashes.join('\n'));
                              } else {
                                // Allow typing - only keep hex chars for partial input
                                const cleanedLines = lines.map(line => 
                                  line.replace(/[^a-f0-9\n]/gi, '')
                                ).join('\n');
                                setBulkApiInput(cleanedLines);
                              }
                            }
                          }}
                          rows={6}
                          className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          {bulkApiType === 'random' 
                            ? 'Enter one API per line as: api_id:api_hash'
                            : `Enter API hashes only (one per line) — API ID ${deviceApiCredentials[bulkApiType]?.api_id} will be used`
                          }
                        </p>
                      </div>
                      
                      <Button 
                        onClick={handleBulkImport} 
                        disabled={isImportingBulk}
                        className="w-full"
                      >
                        {isImportingBulk ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Adding...
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4 mr-2" />
                            {bulkApiType === 'random' ? 'Import APIs' : `Add ${bulkApiType} API`}
                          </>
                        )}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>

                {/* Single Add Dialog */}
                <Dialog open={isAddApiOpen} onOpenChange={setIsAddApiOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="gap-2">
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
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoadingCredentials ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : apiCredentials.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Key className="w-12 h-12 text-muted-foreground/50 mb-3" />
                <p className="text-muted-foreground">No API credentials configured</p>
                <p className="text-sm text-muted-foreground/70">Add your first API to get started</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {apiCredentials.map((cred) => {
                    const iconMap: Record<string, React.ReactNode> = {
                      android: <Smartphone className="w-4 h-4 text-green-500" />,
                      ios: <Smartphone className="w-4 h-4 text-blue-500" />,
                      desktop: <Monitor className="w-4 h-4 text-purple-500" />,
                      macos: <Monitor className="w-4 h-4 text-gray-500" />,
                    };
                    
                    return (
                      <div 
                        key={cred.id} 
                        className="p-4 rounded-xl border bg-card hover:bg-accent/5 transition-colors group relative"
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="absolute top-3 right-3 h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteApiCredential(cred.id)}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                        <div className="flex items-center gap-3 mb-3">
                          <div className="p-2 rounded-lg bg-muted">
                            {iconMap[cred.client_type] || <Smartphone className="w-4 h-4" />}
                          </div>
                          <div className="flex-1 min-w-0 pr-6">
                            <p className="font-medium text-sm truncate">{cred.name}</p>
                            <p className="text-xs text-muted-foreground">{cred.accounts_count} accounts</p>
                          </div>
                          <Badge variant="secondary" className="text-xs capitalize shrink-0">
                            {cred.client_type}
                          </Badge>
                        </div>
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">24h Usage</span>
                              <span className={cn(
                                "font-medium",
                                (cred.sent_24h || 0) >= API_DAILY_LIMIT ? "text-destructive" : 
                                (cred.sent_24h || 0) >= API_DAILY_LIMIT * 0.8 ? "text-yellow-500" : "text-muted-foreground"
                              )}>
                                {cred.sent_24h || 0}/{API_DAILY_LIMIT}
                              </span>
                            </div>
                            <Progress 
                              value={Math.min(((cred.sent_24h || 0) / API_DAILY_LIMIT) * 100, 100)} 
                              className={cn(
                                "h-1.5",
                                (cred.sent_24h || 0) >= API_DAILY_LIMIT ? "[&>div]:bg-destructive" : 
                                (cred.sent_24h || 0) >= API_DAILY_LIMIT * 0.8 ? "[&>div]:bg-yellow-500" : "[&>div]:bg-primary"
                              )}
                            />
                          </div>
                          {cred.success_rate_24h !== null && cred.success_rate_24h !== undefined && (
                            <div className="flex items-center justify-between text-xs pt-1">
                              <span className="text-muted-foreground">Success Rate</span>
                              <span className={cn(
                                "font-medium",
                                cred.success_rate_24h >= 90 ? "text-green-500" : 
                                cred.success_rate_24h >= 70 ? "text-yellow-500" : "text-destructive"
                              )}>
                                {cred.success_rate_24h.toFixed(0)}%
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="pt-4 mt-4 border-t">
                  <p className="text-xs text-muted-foreground text-center">
                    Daily limit: {API_DAILY_LIMIT} messages per API • System auto-selects least-used APIs
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </TabsContent>


      {/* Cleanup Tab */}
      <TabsContent value="cleanup" className="mt-0">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Auto Cleanup</CardTitle>
            <CardDescription>
              Automatically delete old conversations to reduce storage and ban risk
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-base">Delete chats older than</Label>
                <Badge variant="secondary" className="text-sm font-medium">
                  {dbSettings.cleanup.retentionDays} days
                </Badge>
              </div>
              <Slider
                value={[dbSettings.cleanup.retentionDays]}
                onValueChange={([value]) => updateCleanupSettings({ retentionDays: value })}
                min={3}
                max={30}
                step={1}
                className="py-2"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>3 days</span>
                <span>30 days</span>
              </div>
            </div>
            
            <Separator />
            
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Manual Cleanup</p>
                <p className="text-sm text-muted-foreground">Run cleanup immediately</p>
              </div>
              <Button 
                variant="outline" 
                onClick={handleManualCleanup}
                disabled={isCleaningUp}
                className="gap-2"
              >
                {isCleaningUp ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Cleaning...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Run Now
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Notifications Tab */}
      <TabsContent value="notifications" className="mt-0">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Notification Preferences</CardTitle>
            <CardDescription>
              Configure how you want to be notified about events
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between py-2">
              <div className="space-y-0.5">
                <Label className="text-base">Reply Notifications</Label>
                <p className="text-sm text-muted-foreground">
                  Get notified when someone replies to your messages
                </p>
              </div>
              <Switch
                checked={localSettings.notifyOnReply}
                onCheckedChange={(checked) => updateLocalSettings({ notifyOnReply: checked })}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between py-2">
              <div className="space-y-0.5">
                <Label className="text-base">Ban Alerts</Label>
                <p className="text-sm text-muted-foreground">
                  Get notified when an account gets banned or restricted
                </p>
              </div>
              <Switch
                checked={localSettings.notifyOnBan}
                onCheckedChange={(checked) => updateLocalSettings({ notifyOnBan: checked })}
              />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

        {/* Save Button */}
        <div className="flex justify-end pt-4">
          <Button onClick={handleSave} disabled={isSaving} size="lg" className="gap-2">
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Settings;
