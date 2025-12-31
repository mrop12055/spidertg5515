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
  Loader2
} from 'lucide-react';

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
    warmupDays: 5,
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
        {/* Python Script Speed Settings */}
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
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

        {/* Maturation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5" />
              Account Maturation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-run maturation</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically mature new accounts
                </p>
              </div>
              <Switch
                checked={settings.maturationAutoRun}
                onCheckedChange={(checked) => updateSettings({ maturationAutoRun: checked })}
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
