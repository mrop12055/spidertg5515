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
  Loader2,
  Save,
  Settings as SettingsIcon,
  MessageSquare,
} from 'lucide-react';

const Settings: React.FC = () => {
  const { toast: showToast } = useToast();
  
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

        <Tabs defaultValue="livechat" className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 h-11">
            <TabsTrigger value="livechat" className="gap-2">
              <MessageSquare className="w-4 h-4" />
              Livechat
            </TabsTrigger>
            <TabsTrigger value="notifications" className="gap-2">
              <Bell className="w-4 h-4" />
              Notifications
            </TabsTrigger>
          </TabsList>

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