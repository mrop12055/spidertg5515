import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAppSettings } from '@/hooks/useAppSettings';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Bell, 
  Calendar,
  Loader2,
  Trash2,
  Save,
  Settings as SettingsIcon,
  MessageSquare,
  Zap,
  CheckCircle2
} from 'lucide-react';

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

  // Helper to update livechat settings
  const updateLivechatSettings = (updates: Partial<typeof dbSettings.livechat>) => {
    updateDbSettings('livechat', updates);
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
          <TabsList className="grid w-full grid-cols-4 h-11">
            <TabsTrigger value="api" className="gap-2">
              <Zap className="w-4 h-4" />
              API System
            </TabsTrigger>
            <TabsTrigger value="livechat" className="gap-2">
              <MessageSquare className="w-4 h-4" />
              Livechat
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

          {/* Dynamic API System Tab */}
          <TabsContent value="api" className="space-y-4 mt-0">
            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-lg flex items-center gap-3">
                      Dynamic Per-Request API System
                      <Badge variant="default" className="font-normal bg-green-500/20 text-green-500 border-green-500/30">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Active
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      Every Telegram interaction uses a unique, randomly generated API credential
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-6">
                  {/* Status Overview */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-4 rounded-xl border bg-card">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 rounded-lg bg-green-500/10">
                          <Zap className="w-4 h-4 text-green-500" />
                        </div>
                        <p className="font-medium text-sm">Unique Per Message</p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Each message gets a fresh api_id + api_hash pair
                      </p>
                    </div>
                    
                    <div className="p-4 rounded-xl border bg-card">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 rounded-lg bg-blue-500/10">
                          <CheckCircle2 className="w-4 h-4 text-blue-500" />
                        </div>
                        <p className="font-medium text-sm">No Rate Limits</p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        APIs are never reused, eliminating rate limiting
                      </p>
                    </div>
                    
                    <div className="p-4 rounded-xl border bg-card">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 rounded-lg bg-purple-500/10">
                          <Zap className="w-4 h-4 text-purple-500" />
                        </div>
                        <p className="font-medium text-sm">90M+ Capacity</p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Random 8-digit IDs = virtually unlimited APIs
                      </p>
                    </div>
                  </div>

                  {/* How It Works */}
                  <div className="p-4 rounded-xl border bg-muted/30">
                    <h4 className="font-medium text-sm mb-3">How It Works</h4>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      <li className="flex items-start gap-2">
                        <span className="text-primary font-bold">1.</span>
                        <span>When a task (message, warmup, spambot check, etc.) is fetched, the system generates a random 8-digit api_id</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-primary font-bold">2.</span>
                        <span>A random 32-character hex api_hash is also generated</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-primary font-bold">3.</span>
                        <span>These credentials are included in the task payload and used by the Python runner</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-primary font-bold">4.</span>
                        <span>After use, the credentials are discarded (ephemeral, not stored)</span>
                      </li>
                    </ul>
                  </div>

                  <div className="pt-4 border-t">
                    <p className="text-xs text-muted-foreground text-center">
                      ✨ No configuration needed • Fully automatic • Zero maintenance
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Livechat Tab */}
          <TabsContent value="livechat" className="mt-0">
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Livechat Settings</CardTitle>
                <CardDescription>
                  Configure parallel message sending and stagger delays for livechat
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Enable Parallel Mode */}
                <div className="flex items-center justify-between py-2">
                  <div className="space-y-0.5">
                    <Label className="text-base">Parallel Message Sending</Label>
                    <p className="text-sm text-muted-foreground">
                      Send messages to multiple recipients simultaneously across all accounts
                    </p>
                  </div>
                  <Switch
                    checked={dbSettings.livechat?.enableParallel ?? true}
                    onCheckedChange={(checked) => updateLivechatSettings({ enableParallel: checked })}
                  />
                </div>

                <Separator />

                {/* Same Account Stagger */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base">Same Account Stagger</Label>
                      <p className="text-sm text-muted-foreground">
                        Delay between messages when same account sends to multiple recipients
                      </p>
                    </div>
                    <Badge variant="secondary" className="text-sm font-medium">
                      {dbSettings.livechat?.sameAccountStaggerMin ?? 1} - {dbSettings.livechat?.sameAccountStaggerMax ?? 2}s
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Min Delay (seconds)</Label>
                      <Slider
                        value={[dbSettings.livechat?.sameAccountStaggerMin ?? 1]}
                        onValueChange={([value]) => updateLivechatSettings({ sameAccountStaggerMin: value })}
                        min={0}
                        max={5}
                        step={0.5}
                        className="py-2"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>0s</span>
                        <span>5s</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Max Delay (seconds)</Label>
                      <Slider
                        value={[dbSettings.livechat?.sameAccountStaggerMax ?? 2]}
                        onValueChange={([value]) => updateLivechatSettings({ sameAccountStaggerMax: value })}
                        min={0}
                        max={10}
                        step={0.5}
                        className="py-2"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>0s</span>
                        <span>10s</span>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                    💡 If Account A has 3 messages to send, it will wait {dbSettings.livechat?.sameAccountStaggerMin ?? 1}-{dbSettings.livechat?.sameAccountStaggerMax ?? 2}s between each
                  </p>
                </div>

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
