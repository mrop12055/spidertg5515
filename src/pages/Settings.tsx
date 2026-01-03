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
import { 
  Bell, 
  Calendar,
  Loader2,
  Smartphone,
  Monitor,
  RefreshCw,
  Key,
  Plus,
  X,
  Trash2,
  Save,
  CheckCircle2,
  AlertTriangle,
  RotateCcw
} from 'lucide-react';
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
  last_validated_at: string | null;
  validation_error: string | null;
}

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
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

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
      
      toast.success('API credential added! Now redistributing accounts...');
      setNewApiName('');
      setNewApiId('');
      setNewApiHash('');
      setNewApiType('android');
      setIsAddApiOpen(false);
      
      // Auto-redistribute accounts when new API is added
      await handleRedistribute();
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

  // Reactivate an API credential
  const handleReactivateCredential = async (id: string) => {
    setReactivatingId(id);
    try {
      const { error } = await supabase
        .from('telegram_api_credentials')
        .update({
          is_active: true,
          validation_error: null,
          last_validated_at: new Date().toISOString(),
        })
        .eq('id', id);
      
      if (error) throw error;
      
      toast.success('API credential reactivated! Redistributing accounts...');
      await handleRedistribute();
      fetchApiCredentials();
    } catch (error) {
      console.error('Failed to reactivate API credential:', error);
      toast.error('Failed to reactivate API credential');
    } finally {
      setReactivatingId(null);
    }
  };

  useEffect(() => {
    fetchApiCredentials();
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
        description="Configure your Telegram Hub preferences"
      />

      <div className="max-w-3xl space-y-6">
        {/* Loading indicator for database settings */}
        {isLoadingSettings && (
          <Card className="border-primary/30">
            <CardContent className="flex items-center justify-center py-8">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-muted-foreground">Loading settings from database...</span>
              </div>
            </CardContent>
          </Card>
        )}

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
                    
                    const isInvalid = !cred.is_active || !!cred.validation_error;
                    
                    return (
                      <div 
                        key={cred.id} 
                        className={`p-4 rounded-lg border bg-card/50 space-y-2 group relative ${
                          isInvalid ? 'border-destructive/50 bg-destructive/5' : ''
                        }`}
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
                            {isInvalid ? (
                              <AlertTriangle className="w-4 h-4 text-destructive" />
                            ) : (
                              <CheckCircle2 className="w-4 h-4 text-green-500" />
                            )}
                          </div>
                          <Badge variant={isInvalid ? "destructive" : "outline"} className="text-xs">
                            {isInvalid ? 'Invalid' : cred.client_type}
                          </Badge>
                        </div>
                        
                        {/* Show error message if invalid */}
                        {cred.validation_error && (
                          <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">
                            {cred.validation_error}
                          </div>
                        )}
                        
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">
                              {cred.accounts_count} accounts
                            </span>
                            <span className="font-medium">{percentage}%</span>
                          </div>
                          <Progress value={percentage} className="h-2" />
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="text-xs text-muted-foreground font-mono">
                            API ID: {cred.api_id}
                          </div>
                          {cred.last_validated_at && (
                            <div className="text-xs text-muted-foreground">
                              Checked: {new Date(cred.last_validated_at).toLocaleDateString()}
                            </div>
                          )}
                        </div>
                        
                        {/* Reactivate button for invalid credentials */}
                        {isInvalid && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full mt-2"
                            onClick={() => handleReactivateCredential(cred.id)}
                            disabled={reactivatingId === cred.id}
                          >
                            {reactivatingId === cred.id ? (
                              <>
                                <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                                Reactivating...
                              </>
                            ) : (
                              <>
                                <RotateCcw className="w-3 h-3 mr-2" />
                                Reactivate & Redistribute
                              </>
                            )}
                          </Button>
                        )}
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
                <span className="text-sm font-medium">{dbSettings.cleanup.retentionDays} days</span>
              </div>
              <Slider
                value={[dbSettings.cleanup.retentionDays]}
                onValueChange={([value]) => updateCleanupSettings({ retentionDays: value })}
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
                checked={localSettings.notifyOnReply}
                onCheckedChange={(checked) => updateLocalSettings({ notifyOnReply: checked })}
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
                checked={localSettings.notifyOnBan}
                onCheckedChange={(checked) => updateLocalSettings({ notifyOnBan: checked })}
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
